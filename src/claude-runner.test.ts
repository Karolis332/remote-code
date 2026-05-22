/**
 * Unit tests for `src/claude-runner.ts`.
 *
 * Strategy: mock `execa` so no real subprocess runs. The mock returns a
 * Promise-shaped object whose `stdout`/`stderr`/`exitCode` we control per-test.
 * We do NOT exercise the line-by-line stream readers; instead we rely on the
 * defensive re-process path at the end of `runPrompt` that re-feeds
 * `result.stdout` through `onLine` when it wasn't seen via streams.
 *
 * Each test uses an in-memory SQLite DB (via the peer `openDB(":memory:")` +
 * `migrate`) so persistence side effects are observable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock state — vi.hoisted runs before the vi.mock factories.
const mockState = vi.hoisted(() => {
  return {
    impl: (
      _file: string,
      _args: readonly string[],
      _opts: Record<string, unknown>,
    ): unknown => {
      throw new Error("execa mock not initialized");
    },
  };
});

vi.mock("execa", () => {
  class FakeExecaError extends Error {
    exitCode?: number;
    stderr?: string;
    stdout?: string;
  }

  return {
    execa: (
      file: string,
      args: readonly string[],
      opts: Record<string, unknown>,
    ) => mockState.impl(file, args, opts),
    ExecaError: FakeExecaError,
  };
});

import {
  __test__,
  killAgent,
  probeCli,
  runPrompt,
  runningAgents,
} from "./claude-runner.js";
import {
  type DB,
  appendMessage,
  close,
  createAgent,
  getAgent,
  migrate,
  openDB,
  quotaEventsSince,
  recentMessages,
} from "./db/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake execa subprocess Promise that exposes the fields runPrompt
 * reads (`stdout`, `stderr`, `exitCode`, `kill`). Streams are omitted; the
 * runner falls back to re-processing `result.stdout` when no stream events
 * arrived.
 */
function makeSubprocess(opts: {
  stdout: string;
  stderr?: string;
  exitCode?: number;
  throws?: Error;
}) {
  const killed = { value: false };
  const sub: Promise<unknown> & {
    kill: (sig?: string) => void;
    stdout: null;
    stderr: null;
  } = Object.assign(
    opts.throws
      ? Promise.reject(opts.throws)
      : Promise.resolve({
          stdout: opts.stdout,
          stderr: opts.stderr ?? "",
          exitCode: opts.exitCode ?? 0,
        }),
    {
      kill: (_sig?: string): void => {
        killed.value = true;
      },
      stdout: null,
      stderr: null,
    },
  );
  // Swallow unhandled rejections in case the test doesn't await.
  sub.catch(() => undefined);
  return { sub, killed };
}

function freshDb(): DB {
  const db = openDB(":memory:");
  migrate(db);
  return db;
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe("probeCli", () => {
  beforeEach(() => {
    __test__.reset();
  });

  it("returns { installed: false } when `claude` is not installed (ENOENT)", async () => {
    const enoent = new Error("spawn claude ENOENT") as Error & {
      code: string;
    };
    enoent.code = "ENOENT";

    mockState.impl = () => Promise.reject(enoent);

    const res = await probeCli();
    expect(res.installed).toBe(false);
    expect(res.raw).toContain("ENOENT");
    expect(res.version).toBeUndefined();
  });

  it("returns installed/version/authed when both probes succeed", async () => {
    mockState.impl = (_file, args) => {
      if (args[0] === "--version") {
        return Promise.resolve({
          stdout: "claude 2.1.118",
          stderr: "",
          exitCode: 0,
        });
      }
      if (args[0] === "auth" && args[1] === "status") {
        return Promise.resolve({
          stdout: "logged in as user@example.com",
          stderr: "",
          exitCode: 0,
        });
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    };

    const res = await probeCli();
    expect(res.installed).toBe(true);
    expect(res.version).toBe("2.1.118");
    expect(res.authed).toBe(true);
    expect(res.raw).toContain("claude 2.1.118");
  });
});

describe("runPrompt — happy path", () => {
  let db: DB;

  beforeEach(() => {
    __test__.reset();
    db = freshDb();
    createAgent(db, { id: "agent-1", name: "A1", cwd: "/tmp" });
  });

  afterEach(() => {
    close(db);
  });

  it("ok=true, persists user+assistant messages, captures sessionId and tokens", async () => {
    const streamJson = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "sess-abc",
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello, " }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "world." }] },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "Hello, world.",
        session_id: "sess-abc",
        is_error: false,
        usage: { input_tokens: 12, output_tokens: 7 },
      }),
    ].join("\n");

    const { sub } = makeSubprocess({ stdout: streamJson, exitCode: 0 });
    mockState.impl = () => sub;

    const chunks: string[] = [];
    const res = await runPrompt(db, {
      agentId: "agent-1",
      cwd: "/tmp",
      prompt: "say hi",
      onChunk: (c) => chunks.push(c),
    });

    expect(res.ok).toBe(true);
    expect(res.text).toBe("Hello, world.");
    expect(res.sessionId).toBe("sess-abc");
    expect(res.tokensEstimated).toBe(19);
    expect(res.rateLimit).toBeNull();
    expect(res.exitCode).toBe(0);
    expect(chunks.join("")).toBe("Hello, world.");

    const msgs = recentMessages(db, "agent-1", 10);
    expect(msgs.length).toBe(2);
    const roles = msgs.map((m) => m.role).sort();
    expect(roles).toEqual(["assistant", "user"]);

    const events = quotaEventsSince(db, 0);
    expect(events.some((e) => e.kind === "request")).toBe(true);
  });
});

describe("runPrompt — rate limit", () => {
  let db: DB;

  beforeEach(() => {
    __test__.reset();
    db = freshDb();
    createAgent(db, { id: "agent-rl", name: "RL", cwd: "/tmp" });
  });

  afterEach(() => {
    close(db);
  });

  it("populates rateLimit, pauses the agent, records rate_limit_hit", async () => {
    const stderr =
      'Error: rate_limit_error — Claude usage limit reached. Try again at 22:00 UTC.';
    const stdout = JSON.stringify({
      type: "error",
      subtype: "rate_limit",
      message: 'rate limit reached. retry after 2030-01-01T00:00:00Z',
    });

    const { sub } = makeSubprocess({ stdout, stderr, exitCode: 1 });
    mockState.impl = () => sub;

    const res = await runPrompt(db, {
      agentId: "agent-rl",
      cwd: "/tmp",
      prompt: "do thing",
    });

    expect(res.ok).toBe(false);
    expect(res.rateLimit).not.toBeNull();
    expect(res.rateLimit?.resetAt).toBeGreaterThan(Date.now());
    expect(res.rateLimit?.confidence).toMatch(/^(high|medium|low)$/);

    const agent = getAgent(db, "agent-rl");
    expect(agent?.status).toBe("paused");
    expect(agent?.paused_until).not.toBeNull();
    expect(agent?.paused_until).toBe(res.rateLimit?.resetAt);

    const events = quotaEventsSince(db, 0);
    expect(events.some((e) => e.kind === "rate_limit_hit")).toBe(true);
  });
});

describe("runPrompt — non-zero exit without rate limit", () => {
  let db: DB;

  beforeEach(() => {
    __test__.reset();
    db = freshDb();
    createAgent(db, { id: "agent-err", name: "ERR", cwd: "/tmp" });
  });

  afterEach(() => {
    close(db);
  });

  it("returns ok=false with stderrSnippet populated and a system message persisted", async () => {
    const { sub } = makeSubprocess({
      stdout: "",
      stderr: "fatal: working directory missing",
      exitCode: 2,
    });
    mockState.impl = () => sub;

    const res = await runPrompt(db, {
      agentId: "agent-err",
      cwd: "/nope",
      prompt: "go",
    });

    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(2);
    expect(res.rateLimit).toBeNull();
    expect(res.stderrSnippet).toContain("fatal");
    expect(res.text).toBe("");

    const msgs = recentMessages(db, "agent-err", 10);
    const sys = msgs.find((m) => m.role === "system");
    expect(sys).toBeDefined();
    expect(sys?.body).toContain("exitCode=2");
  });
});

describe("killAgent / runningAgents", () => {
  beforeEach(() => {
    __test__.reset();
  });

  it("registers a running agent during runPrompt and clears it on kill", async () => {
    const db = freshDb();
    createAgent(db, { id: "agent-kill", name: "K", cwd: "/tmp" });

    let killCalls = 0;
    // Hold the subprocess pending so we can observe the running map.
    let resolveSub: (v: unknown) => void = () => undefined;
    const pending = new Promise<unknown>((r) => {
      resolveSub = r;
    });
    const sub: Promise<unknown> & {
      kill: () => void;
      stdout: null;
      stderr: null;
    } = Object.assign(pending, {
      kill: (): void => {
        killCalls += 1;
        resolveSub({ stdout: "", stderr: "killed", exitCode: null });
      },
      stdout: null,
      stderr: null,
    });
    mockState.impl = () => sub;

    const runPromise = runPrompt(db, {
      agentId: "agent-kill",
      cwd: "/tmp",
      prompt: "long",
    });

    // Let runPrompt register the subprocess in the running map.
    await new Promise((r) => setImmediate(r));

    expect(runningAgents()).toContain("agent-kill");

    const wasKilled = killAgent("agent-kill");
    expect(wasKilled).toBe(true);
    expect(killCalls).toBe(1);

    // Running map clears immediately on killAgent (and again when runPrompt
    // finishes, idempotent).
    expect(runningAgents()).not.toContain("agent-kill");

    await runPromise;
    expect(runningAgents()).not.toContain("agent-kill");
    expect(killAgent("agent-kill")).toBe(false);

    close(db);
  });
});

describe("appendMessage sanity (DB peer contract)", () => {
  it("openDB(:memory:) + migrate + appendMessage round-trips", () => {
    const db = freshDb();
    createAgent(db, { id: "smoke", name: "S", cwd: "/tmp" });
    appendMessage(db, {
      agent_id: "smoke",
      role: "user",
      body: "hello",
      tokens_estimated: 1,
    });
    const got = recentMessages(db, "smoke", 1);
    expect(got.length).toBe(1);
    expect(got[0]?.body).toBe("hello");
    close(db);
  });
});
