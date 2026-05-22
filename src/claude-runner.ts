/**
 * Claude Code subprocess runner.
 *
 * Drives the local `claude` CLI on behalf of an agent: spawns one subprocess
 * per prompt, streams `--output-format=stream-json` events, captures the final
 * assistant text + session id + usage tokens, and persists prompt/response
 * pairs to SQLite via the peer-owned db module. Rate-limit detection is
 * delegated to `quota.parseRateLimit`; on a hit, the agent row is paused and
 * the subprocess is cancelled so we don't burn more tokens.
 *
 * --- CLI verification (per spec, MUST verify before coding) ---
 *
 * Source: Claude Code CLI reference
 *   https://docs.anthropic.com/en/docs/claude-code/cli-reference
 *   (canonical host as of 2026-05-21: https://code.claude.com/docs/en/cli-reference)
 *
 * Source: Agent SDK overview (stream-json semantics, session id field)
 *   https://docs.claude.com/en/docs/agent-sdk
 *
 * Source: Streaming Input vs Single-message (one-shot vs persistent)
 *   https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
 *
 * Verified facts:
 *   - `claude -p "..."` / `claude --print` is ONE-SHOT: the process queries
 *     the SDK and exits. Quote from CLI reference commands table:
 *     "Query via SDK, then exit ... claude -p \"explain this function\"".
 *   - `--output-format <format>` accepts "text" | "json" | "stream-json"
 *     (print mode only). stream-json emits NDJSON events.
 *   - `--max-turns N` limits agentic turns in print mode; exits with error
 *     when the limit is reached. No limit by default.
 *   - `--resume <id>` resumes a session by ID or name. `--continue` (`-c`)
 *     loads the most recent conversation in the current directory.
 *   - `--session-id <uuid>` pins a specific session UUID.
 *   - `--include-partial-messages` requires `--print` + `--output-format
 *     stream-json` (we don't use it; we want final-event accumulation).
 *   - System init event: `{ type: "system", subtype: "init", session_id }`
 *     (Agent SDK Sessions example).
 *   - Result event: `{ type: "result", subtype: "success"|..., result, ... }`
 *     (Streaming Input example).
 *
 * Therefore: ONE-SHOT-PER-PROMPT model. We spawn a fresh `claude --print`
 * for each `runPrompt` invocation. Cross-prompt threading uses `--resume
 * <sessionId>`, where `sessionId` was captured from the prior run's
 * `system.init` event.
 *
 * Flags we emit (all verified above):
 *   claude --print
 *          --output-format stream-json
 *          --verbose
 *          --max-turns 12
 *          [--resume <sessionId>]
 *          --                              (end-of-flags marker)
 *          <prompt>
 *
 * `--verbose` is required by some Claude Code builds for stream-json to
 * flush per-event; harmless when not required.
 *
 * Subprocess spawning uses `execa` (per spec), which invokes the child via
 * `execFile`-style argv arrays — no shell interpolation, so user-supplied
 * prompts cannot inject shell metacharacters.
 */

import { execa, type ResultPromise, ExecaError } from "execa";
import {
  type DB,
  appendMessage,
  updateAgentStatus,
} from "./db/index.js";
import { parseRateLimit, pauseUntil, recordRequest } from "./quota.js";

// ---------------------------------------------------------------------------
// Public types (LOCKED — peers depend on these)
// ---------------------------------------------------------------------------

export interface RunArgs {
  agentId: string;
  cwd: string;
  prompt: string;
  /** Optional session/conversation id from a prior run. */
  sessionId?: string;
  /** Hard cap on subprocess wall time. Default 10 min. */
  timeoutMs?: number;
  /** Called for each stdout chunk (assistant text) as it arrives. */
  onChunk?: (chunk: string) => void;
}

export interface RunRateLimit {
  resetAt: number;
  rawSnippet: string;
  confidence: "high" | "medium" | "low";
}

export interface RunResult {
  ok: boolean;
  /** Full assistant output. */
  text: string;
  /** Session id to thread the next prompt, if the CLI emitted one. */
  sessionId?: string;
  /** Approximate tokens (input + output). null if unknown. */
  tokensEstimated: number | null;
  /** Set when a rate-limit was detected mid-run. */
  rateLimit: RunRateLimit | null;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Exit code from the subprocess. */
  exitCode: number | null;
  /** stderr text (truncated to 4 KB). */
  stderrSnippet: string;
}

export interface ProbeResult {
  installed: boolean;
  version?: string;
  authed?: boolean;
  /** Full output for diagnostics. */
  raw: string;
}

// ---------------------------------------------------------------------------
// Module-scoped subprocess registry
// ---------------------------------------------------------------------------

type AnySubprocess = ResultPromise<Record<string, unknown>>;

const running = new Map<string, AnySubprocess>();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const STDERR_CAP_BYTES = 4 * 1024;
const MAX_TURNS = 12;

const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";

// ---------------------------------------------------------------------------
// probeCli
// ---------------------------------------------------------------------------

/** Probe the local CLI: returns version + (best-effort) auth status. Never throws. */
export async function probeCli(): Promise<ProbeResult> {
  let versionRaw = "";
  let versionOk = false;
  let version: string | undefined;

  try {
    const r = await execa(CLAUDE_BIN, ["--version"], {
      reject: false,
      timeout: 10_000,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    const stdout = typeof r.stdout === "string" ? r.stdout : "";
    const stderr = typeof r.stderr === "string" ? r.stderr : "";
    versionRaw = `${stdout}\n${stderr}`.trim();
    if (r.exitCode === 0) {
      versionOk = true;
      const match = /\d+\.\d+\.\d+/.exec(versionRaw);
      version = match ? match[0] : versionRaw.split(/\s+/)[0] || versionRaw;
    }
  } catch (err) {
    versionRaw = stringifyError(err);
  }

  if (!versionOk) {
    return { installed: false, raw: versionRaw };
  }

  let authed: boolean | undefined;
  let authRaw = "";
  try {
    const a = await execa(CLAUDE_BIN, ["auth", "status"], {
      reject: false,
      timeout: 10_000,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    const stdout = typeof a.stdout === "string" ? a.stdout : "";
    const stderr = typeof a.stderr === "string" ? a.stderr : "";
    authRaw = `${stdout}\n${stderr}`.trim();
    authed = a.exitCode === 0;
  } catch (err) {
    authRaw = stringifyError(err);
  }

  return {
    installed: true,
    version,
    authed,
    raw: [versionRaw, authRaw].filter((s) => s.length > 0).join("\n---\n"),
  };
}

// ---------------------------------------------------------------------------
// killAgent / runningAgents
// ---------------------------------------------------------------------------

/** Kill the subprocess for an agent if it's running. Returns true if killed. */
export function killAgent(agentId: string): boolean {
  const sub = running.get(agentId);
  if (!sub) return false;
  try {
    sub.kill("SIGTERM");
  } catch {
    // ignore — subprocess may already be gone
  }
  running.delete(agentId);
  return true;
}

/** Snapshot of agent ids currently owning a live subprocess. */
export function runningAgents(): string[] {
  return Array.from(running.keys());
}

// ---------------------------------------------------------------------------
// runPrompt
// ---------------------------------------------------------------------------

/**
 * Run a single prompt against the Claude Code CLI on behalf of an agent.
 *
 * Persistence side effects:
 *   - role='user' message is appended BEFORE spawn.
 *   - role='assistant' message is appended AFTER on success.
 *   - role='system' message with the failure body is appended on error.
 *   - One `recordRequest` quota event for the prompt.
 *   - If a rate-limit is detected: `pauseUntil` records a `rate_limit_hit`
 *     event AND sets agent status='paused' with paused_until=resetAt; the
 *     subprocess is cancelled.
 *
 * Never throws. Returns a `RunResult` with `ok: false` on any failure.
 */
export async function runPrompt(db: DB, args: RunArgs): Promise<RunResult> {
  const start = Date.now();
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    appendMessage(db, {
      agent_id: args.agentId,
      role: "user",
      body: args.prompt,
      tokens_estimated: estimateTokens(args.prompt),
    });
    recordRequest(db, args.agentId, estimateTokens(args.prompt));
  } catch {
    // pre-spawn persistence failure shouldn't block the run
  }

  const cliArgs = buildCliArgs(args.sessionId);

  let subprocess: AnySubprocess;
  try {
    subprocess = execa(CLAUDE_BIN, [...cliArgs, "--", args.prompt], {
      cwd: args.cwd,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      timeout: timeoutMs,
      killSignal: "SIGTERM",
      reject: false,
      all: true,
      buffer: true,
      stdin: "ignore",
    }) as AnySubprocess;
  } catch (err) {
    return failResult({
      db,
      args,
      err,
      start,
      stderrSnippet: stringifyError(err).slice(0, STDERR_CAP_BYTES),
    });
  }

  running.set(args.agentId, subprocess);

  let assistantText = "";
  let sessionIdOut: string | undefined;
  let tokensFromResult: number | null = null;
  let rateLimit: RunRateLimit | null = null;
  let combinedBuffer = "";

  const cancelOnRateLimit = (): void => {
    if (rateLimit) {
      try {
        subprocess.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  };

  const onLine = (rawLine: string, source: "stdout" | "stderr"): void => {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0) return;
    combinedBuffer += line + "\n";

    if (source === "stdout" && line.trimStart().startsWith("{")) {
      const ev = safeParse(line.trim());
      if (ev) {
        const handled = handleEvent(ev);
        if (handled.assistantDelta) {
          assistantText += handled.assistantDelta;
          try {
            args.onChunk?.(handled.assistantDelta);
          } catch {
            // user callback throw must not break stream
          }
        }
        if (handled.sessionId && !sessionIdOut) sessionIdOut = handled.sessionId;
        if (handled.tokens !== null) tokensFromResult = handled.tokens;
        if (handled.fallbackText && assistantText.length === 0) {
          assistantText = handled.fallbackText;
          try {
            args.onChunk?.(handled.fallbackText);
          } catch {
            // ignore
          }
        }
        rateLimit = detectRateLimit(combinedBuffer, rateLimit);
        cancelOnRateLimit();
        return;
      }
    }

    rateLimit = detectRateLimit(combinedBuffer, rateLimit);
    cancelOnRateLimit();
  };

  const stdoutDone = readLines(subprocess, "stdout", (l) => onLine(l, "stdout"));
  const stderrDone = readLines(subprocess, "stderr", (l) => onLine(l, "stderr"));

  let exitCode: number | null = null;
  let stderr = "";
  try {
    const result = await subprocess;
    exitCode = result.exitCode ?? null;
    const resultStderr = typeof result.stderr === "string" ? result.stderr : "";
    if (resultStderr) {
      stderr = resultStderr;
      if (!combinedBuffer.includes(resultStderr)) {
        combinedBuffer += resultStderr;
        rateLimit = detectRateLimit(combinedBuffer, rateLimit);
      }
    }
    const resultStdout = typeof result.stdout === "string" ? result.stdout : "";
    if (resultStdout && !combinedBuffer.includes(resultStdout)) {
      for (const l of resultStdout.split(/\r?\n/)) onLine(l, "stdout");
    }
  } catch (err) {
    if (err instanceof ExecaError) {
      stderr = String(err.stderr ?? err.message ?? "");
      exitCode = err.exitCode ?? null;
      combinedBuffer += stderr;
      rateLimit = detectRateLimit(combinedBuffer, rateLimit);
    } else {
      stderr = stringifyError(err);
    }
  } finally {
    running.delete(args.agentId);
    void stdoutDone;
    void stderrDone;
  }

  const durationMs = Date.now() - start;
  const stderrSnippet = stderr.slice(0, STDERR_CAP_BYTES);

  if (rateLimit) {
    try {
      pauseUntil(db, args.agentId, rateLimit.resetAt, {
        resetAt: rateLimit.resetAt,
        rawSnippet: rateLimit.rawSnippet,
        confidence: rateLimit.confidence,
      });
    } catch {
      // ignore — keeps runner non-throwing
    }
  }

  const tokensEstimated =
    tokensFromResult ??
    (assistantText.length > 0
      ? estimateTokens(args.prompt) + estimateTokens(assistantText)
      : null);

  const ok = !rateLimit && exitCode === 0 && assistantText.length > 0;

  try {
    if (ok) {
      appendMessage(db, {
        agent_id: args.agentId,
        role: "assistant",
        body: assistantText,
        ...(tokensEstimated !== null ? { tokens_estimated: tokensEstimated } : {}),
      });
    } else {
      const errBody = rateLimit
        ? `Rate limit hit. Reset at ${new Date(rateLimit.resetAt).toISOString()}. Snippet: ${rateLimit.rawSnippet}`
        : `Subprocess failed (exitCode=${exitCode}). stderr: ${stderrSnippet}`;
      appendMessage(db, {
        agent_id: args.agentId,
        role: "system",
        body: errBody,
      });
    }
  } catch {
    // persistence errors must not throw
  }

  return {
    ok,
    text: assistantText,
    sessionId: sessionIdOut,
    tokensEstimated,
    rateLimit,
    durationMs,
    exitCode,
    stderrSnippet,
  };
}

// ---------------------------------------------------------------------------
// CLI argv assembly
// ---------------------------------------------------------------------------

function buildCliArgs(sessionId?: string): string[] {
  const argv = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    String(MAX_TURNS),
  ];
  if (sessionId) {
    argv.push("--resume", sessionId);
  }
  return argv;
}

// ---------------------------------------------------------------------------
// stream-json event handling
// ---------------------------------------------------------------------------

interface HandledEvent {
  assistantDelta: string;
  /** Fallback final text from a `result` event, used only if no assistant deltas were emitted. */
  fallbackText: string;
  sessionId: string | null;
  tokens: number | null;
  isError: boolean;
}

/**
 * Map one parsed stream-json event to runner-relevant state.
 *
 * Event shapes (confirmed in Agent SDK docs):
 *   - { type: "system", subtype: "init", session_id }
 *   - { type: "assistant", message: { content: [{ type: "text", text }] } }
 *   - { type: "result", subtype: "success"|"error_max_turns"|...,
 *       result, session_id, usage: { input_tokens, output_tokens, ... },
 *       num_turns, total_cost_usd, duration_ms, is_error }
 *   - { type: "error", ... }
 */
function handleEvent(ev: Record<string, unknown>): HandledEvent {
  const type = typeof ev.type === "string" ? ev.type : "";
  const subtype = typeof ev.subtype === "string" ? ev.subtype : "";

  const out: HandledEvent = {
    assistantDelta: "",
    fallbackText: "",
    sessionId: null,
    tokens: null,
    isError: false,
  };

  if (typeof ev.session_id === "string") {
    out.sessionId = ev.session_id;
  }

  if (type === "system" && subtype === "init") return out;

  if (type === "assistant") {
    out.assistantDelta = extractAssistantText(ev);
    return out;
  }

  if (type === "result") {
    const r = ev.result;
    if (typeof r === "string" && r.length > 0) out.fallbackText = r;
    out.tokens = extractTokens(ev);
    if (ev.is_error === true) out.isError = true;
    if (subtype === "error_rate_limit") out.isError = true;
    return out;
  }

  if (type === "error") {
    out.isError = true;
    return out;
  }

  return out;
}

function extractAssistantText(ev: Record<string, unknown>): string {
  const message = ev.message;
  if (!message || typeof message !== "object") return "";
  const m = message as Record<string, unknown>;
  const content = m.content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") out += b.text;
  }
  return out;
}

function extractTokens(ev: Record<string, unknown>): number | null {
  const usage = ev.usage;
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  let total = 0;
  let any = false;
  for (const k of [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ]) {
    const v = u[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      total += v;
      any = true;
    }
  }
  return any ? total : null;
}

// ---------------------------------------------------------------------------
// Stream helpers
// ---------------------------------------------------------------------------

function readLines(
  subprocess: AnySubprocess,
  which: "stdout" | "stderr",
  onLine: (line: string) => void,
): Promise<void> {
  const raw = (subprocess as unknown as Record<string, unknown>)[which];
  if (!raw || typeof raw !== "object") return Promise.resolve();
  const stream = raw as NodeJS.ReadableStream;
  if (typeof stream.on !== "function") return Promise.resolve();

  return new Promise<void>((resolve) => {
    let buf = "";
    stream.setEncoding?.("utf8");
    stream.on("data", (chunk: string | Buffer) => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        try {
          onLine(line);
        } catch {
          // handler errors must not break the stream loop
        }
      }
    });
    const finish = (): void => {
      if (buf.length > 0) {
        try {
          onLine(buf);
        } catch {
          // ignore
        }
        buf = "";
      }
      resolve();
    };
    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", finish);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParse(line: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(line);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function detectRateLimit(
  buffer: string,
  current: RunRateLimit | null,
): RunRateLimit | null {
  if (current) return current;
  const hit = parseRateLimit(buffer);
  if (!hit) return null;
  return {
    resetAt: hit.resetAt,
    rawSnippet: hit.rawSnippet,
    confidence: hit.confidence,
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}${err.stack ? "\n" + err.stack : ""}`;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function failResult(opts: {
  db: DB;
  args: RunArgs;
  err: unknown;
  start: number;
  stderrSnippet: string;
}): RunResult {
  const { db, args, err, start, stderrSnippet } = opts;
  try {
    appendMessage(db, {
      agent_id: args.agentId,
      role: "system",
      body: `Runner failure: ${stringifyError(err)}`,
    });
    updateAgentStatus(db, args.agentId, "crashed");
  } catch {
    // ignore
  }
  return {
    ok: false,
    text: "",
    sessionId: undefined,
    tokensEstimated: null,
    rateLimit: null,
    durationMs: Date.now() - start,
    exitCode: null,
    stderrSnippet,
  };
}

// ---------------------------------------------------------------------------
// Test-only hook (for resetting state between vitest runs)
// ---------------------------------------------------------------------------

export const __test__ = {
  reset: (): void => {
    running.clear();
  },
};
