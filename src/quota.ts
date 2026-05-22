/**
 * Quota tracker for the RemoteCode agent fleet.
 *
 * Responsibilities:
 *  - Parse Claude Code CLI output for rate-limit signals (stream-json + plain text).
 *  - Maintain a rolling window of request events per agent and globally.
 *  - Pause agents until their reset time and schedule one-shot resume callbacks.
 *
 * Sources consulted:
 *  - Anthropic Claude Code CLI reference:
 *      https://docs.anthropic.com/en/docs/claude-code/cli-reference
 *    Documents `--output-format=stream-json` (NDJSON event stream) and the
 *    default `--print` text mode. Error events in stream-json mode emit
 *    objects shaped like `{ "type": "error", ... }`. The exact `subtype`
 *    nomenclature for rate-limit events is best-effort: this parser matches
 *    `subtype === "rate_limit"` AND any error object whose `message`/`error`
 *    field mentions "rate limit".
 *  - Anthropic rate-limit docs:
 *      https://docs.anthropic.com/en/api/rate-limits
 *    Claude Pro/Max session windows are 5 hours; API rate-limits emit HTTP 429
 *    with reset hints. The CLI surfaces these as human-readable English in
 *    the default text mode ("Your rate limit has been reached. Please try
 *    again at HH:MM ..." or "in N minutes").
 *  - Telegram Bot API (downstream consumer of resume notifications):
 *      https://core.telegram.org/bots/api
 *
 * Patterns explicitly handled:
 *  1. JSON event:  { "type":"error", "subtype":"rate_limit", "reset_at":"...ISO..." }
 *  2. JSON event:  { "type":"error", "message":"rate limit ...", "retry_after_ms":N }
 *  3. Plain text:  "...try again at 22:00 PT..."     (clock-time, with TZ)
 *  4. Plain text:  "...retry after 2026-05-21T22:00:00Z..."  (ISO)
 *  5. Plain text:  "...in 41 minutes..." / "in 90 seconds"  (relative)
 *  6. Heuristic:   any unparsable mention of "rate limit", "quota", or "429"
 *                  → low-confidence 30-minute fallback.
 *
 * NOT yet handled (flagged for human testing — Anthropic CLI output can drift):
 *  - 12-hour clocks without AM/PM (ambiguous; we assume PM if hour <= 12 and
 *    the reset would otherwise be in the past).
 *  - Non-English locales (Claude CLI is English-only as of 2026-05).
 *  - The exact JSON envelope for stream-json rate-limit events — verify
 *    against the running CLI on first integration. The parser is intentionally
 *    permissive (matches by message content even if the structured fields
 *    differ).
 */

import type {
  DB,
  QuotaEventRow,
} from "./db/index.js";
import {
  getMeta,
  quotaEventsSince,
  recordQuotaEvent,
  setMeta,
  updateAgentStatus,
} from "./db/index.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RateLimitInfo {
  /** Best-effort parse of the model's reset time. Always >= now. */
  resetAt: number;
  /** Original CLI output line that triggered detection (truncated to 200 chars). */
  rawSnippet: string;
  /** Confidence: 'high' if structured marker found, 'medium' if regex, 'low' if heuristic. */
  confidence: "high" | "medium" | "low";
}

export interface QuotaSnapshot {
  windowMs: number;
  windowStartedAt: number;
  requestsInWindow: number;
  tokensEstimated: number;
  lastRateLimitAt: number | null;
  nextResetAt: number | null;
  warning: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Claude Pro/Max session window. 5 hours per Anthropic docs. */
export const DEFAULT_WINDOW_MS = 5 * 60 * 60 * 1000;

const SNIPPET_LEN = 200;
const HEURISTIC_FALLBACK_MS = 30 * 60 * 1000;
const WARNING_THRESHOLD = 0.8;
const MAX_PER_WINDOW_META_KEY = "quota:max_per_window";

// Time zone offsets (minutes east of UTC). Best-effort; production should
// use Intl/temporal for DST correctness. Only used to project clock-time
// resets ("22:00 PT") to absolute timestamps.
const TZ_OFFSET_MIN: Record<string, number> = {
  UTC: 0,
  GMT: 0,
  Z: 0,
  EET: 120,
  EEST: 180,
  CET: 60,
  CEST: 120,
  PT: -480, // PST; PDT would be -420. CLI tends to emit "PT" generically.
  PST: -480,
  PDT: -420,
  ET: -300,
  EST: -300,
  EDT: -240,
  CT: -360,
  CST: -360,
  CDT: -300,
  MT: -420,
  MST: -420,
  MDT: -360,
};

// ---------------------------------------------------------------------------
// parseRateLimit
// ---------------------------------------------------------------------------

/**
 * Parse a chunk of CLI stdout/stderr for a rate-limit signal.
 *
 * Returns null if no rate-limit indicator is present. The parser tries, in
 * order: JSON envelope → ISO timestamp → clock-time → relative duration →
 * heuristic fallback.
 */
export function parseRateLimit(
  text: string,
  now: number = Date.now(),
): RateLimitInfo | null {
  if (text == null || text.length === 0) return null;

  const snippet = text.slice(0, SNIPPET_LEN);

  // 1. JSON envelope. Stream-json emits one event per line.
  //    Try the first '{' on each line.
  const jsonHit = tryParseJsonEnvelope(text, now);
  if (jsonHit) return { ...jsonHit, rawSnippet: snippet };

  // Quick reject: if no rate-limit keyword anywhere, bail.
  const lowered = text.toLowerCase();
  const mentionsRateLimit =
    lowered.includes("rate limit") ||
    lowered.includes("rate-limit") ||
    lowered.includes("ratelimit") ||
    lowered.includes("quota") ||
    lowered.includes("429");
  if (!mentionsRateLimit) return null;

  // 2. ISO timestamp: "retry after 2026-05-21T22:00:00Z"
  const iso = matchIso(text);
  if (iso !== null) {
    const ts = Date.parse(iso);
    if (Number.isFinite(ts) && ts > now) {
      return { resetAt: ts, rawSnippet: snippet, confidence: "medium" };
    }
  }

  // 3. Relative duration: "try again in 41 minutes"
  const rel = matchRelative(text, now);
  if (rel !== null) {
    return { resetAt: rel, rawSnippet: snippet, confidence: "medium" };
  }

  // 4. Clock-time: "try again at 22:00 PT"
  const clock = matchClockTime(text, now);
  if (clock !== null) {
    return { resetAt: clock, rawSnippet: snippet, confidence: "medium" };
  }

  // 5. Heuristic fallback.
  return {
    resetAt: now + HEURISTIC_FALLBACK_MS,
    rawSnippet: snippet,
    confidence: "low",
  };
}

interface ParsedHit {
  resetAt: number;
  confidence: "high" | "medium" | "low";
}

function tryParseJsonEnvelope(text: string, now: number): ParsedHit | null {
  // Stream-json mode emits NDJSON; chunks may contain >1 line.
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line[0] !== "{") continue;

    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj === null || typeof obj !== "object") continue;

    const o = obj as Record<string, unknown>;
    const type = typeof o.type === "string" ? o.type : "";
    const subtype = typeof o.subtype === "string" ? o.subtype : "";
    const message = typeof o.message === "string" ? o.message : "";
    const errorField = typeof o.error === "string" ? o.error : "";
    const errorStatus =
      typeof o.status === "number"
        ? o.status
        : typeof o.code === "number"
          ? o.code
          : null;

    const isRateLimit =
      subtype === "rate_limit" ||
      subtype === "rate-limit" ||
      subtype === "rate_limit_error" ||
      /rate[\s_-]?limit|quota/i.test(message) ||
      /rate[\s_-]?limit|quota/i.test(errorField) ||
      errorStatus === 429;

    if (!isRateLimit) continue;
    if (type !== "" && type !== "error" && type !== "result") {
      // Allow type=error|result|<missing>; reject other obvious non-errors.
      if (type === "message" || type === "assistant") continue;
    }

    // High-confidence reset extraction.
    const resetAt =
      pickIsoField(o, ["reset_at", "resetAt", "retry_at", "retryAt"]) ??
      pickRelativeMs(o, ["retry_after_ms", "retryAfterMs"], now) ??
      pickRelativeSec(o, ["retry_after", "retryAfter", "retry_after_s"], now);

    if (resetAt !== null && resetAt > now) {
      return { resetAt, confidence: "high" };
    }

    // Fall back to scanning the message text for a reset hint inside the
    // structured envelope (medium confidence).
    const inner = `${message} ${errorField}`;
    const innerIso = matchIso(inner);
    if (innerIso !== null) {
      const ts = Date.parse(innerIso);
      if (Number.isFinite(ts) && ts > now) {
        return { resetAt: ts, confidence: "high" };
      }
    }
    const innerRel = matchRelative(inner, now);
    if (innerRel !== null) {
      return { resetAt: innerRel, confidence: "high" };
    }
    const innerClock = matchClockTime(inner, now);
    if (innerClock !== null) {
      return { resetAt: innerClock, confidence: "high" };
    }

    // Structured rate-limit event but no parseable reset → heuristic fallback,
    // but keep high confidence because we DID identify the kind.
    return { resetAt: now + HEURISTIC_FALLBACK_MS, confidence: "high" };
  }
  return null;
}

function pickIsoField(
  o: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string") {
      const ts = Date.parse(v);
      if (Number.isFinite(ts)) return ts;
    }
    if (typeof v === "number" && Number.isFinite(v)) {
      // Either unix ms or unix seconds.
      return v > 1e12 ? v : v * 1000;
    }
  }
  return null;
}

function pickRelativeMs(
  o: Record<string, unknown>,
  keys: readonly string[],
  now: number,
): number | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      return now + v;
    }
  }
  return null;
}

function pickRelativeSec(
  o: Record<string, unknown>,
  keys: readonly string[],
  now: number,
): number | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      return now + v * 1000;
    }
    if (typeof v === "string") {
      const n = Number.parseFloat(v);
      if (Number.isFinite(n) && n > 0) return now + n * 1000;
    }
  }
  return null;
}

function matchIso(text: string): string | null {
  // Match strings like "retry after 2026-05-21T22:00:00Z" or
  // "reset at 2026-05-21T22:00:00.123+03:00".
  const re =
    /(?:retry(?:\s+after)?|reset(?:\s+at)?|try\s+again\s+at)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/i;
  const m = re.exec(text);
  return m && m[1] ? m[1] : null;
}

function matchRelative(text: string, now: number): number | null {
  // "in 41 minutes", "in 90 seconds", "in 2 hours", "retry after 30 seconds".
  const re =
    /(?:in|after)\s+(\d+(?:\.\d+)?)\s+(hours?|hrs?|minutes?|mins?|seconds?|secs?|h|m|s)\b/i;
  const m = re.exec(text);
  if (!m || !m[1] || !m[2]) return null;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2].toLowerCase();
  let ms: number;
  if (unit.startsWith("h")) ms = n * 60 * 60 * 1000;
  else if (unit.startsWith("min") || unit === "m") ms = n * 60 * 1000;
  else ms = n * 1000;
  return now + ms;
}

function matchClockTime(text: string, now: number): number | null {
  // "try again at 22:00 PT", "at 10:30 AM UTC", "at 2:15pm".
  const re =
    /(?:try\s+again\s+at|at)\s+(\d{1,2}):(\d{2})\s*(am|pm)?\s*([A-Z]{2,5})?/i;
  const m = re.exec(text);
  if (!m || !m[1] || !m[2]) return null;

  let hour = Number.parseInt(m[1], 10);
  const minute = Number.parseInt(m[2], 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  const meridiem = m[3]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;

  const tz = m[4]?.toUpperCase();
  const tzOffsetMin = tz && TZ_OFFSET_MIN[tz] !== undefined
    ? TZ_OFFSET_MIN[tz]
    : 0;

  // Compute today's UTC midnight, then add (hour:minute - tzOffset).
  const nowDate = new Date(now);
  const utcMidnight = Date.UTC(
    nowDate.getUTCFullYear(),
    nowDate.getUTCMonth(),
    nowDate.getUTCDate(),
  );
  const localMs = (hour * 60 + minute - tzOffsetMin) * 60 * 1000;
  let ts = utcMidnight + localMs;
  // If already past, roll to tomorrow.
  if (ts <= now) ts += 24 * 60 * 60 * 1000;
  return ts;
}

// ---------------------------------------------------------------------------
// recordRequest
// ---------------------------------------------------------------------------

/**
 * Record a request against the rolling window. Lightweight — call on every
 * prompt sent. Persists a `request` quota event with optional token estimate.
 */
export function recordRequest(
  db: DB,
  agentId: string,
  tokensEstimated?: number,
): void {
  const meta: Record<string, unknown> = {};
  if (tokensEstimated !== undefined && Number.isFinite(tokensEstimated)) {
    meta.tokens_estimated = tokensEstimated;
  }
  recordQuotaEvent(db, {
    agent_id: agentId,
    kind: "request",
    meta: Object.keys(meta).length > 0 ? meta : undefined,
  });
}

// ---------------------------------------------------------------------------
// pauseUntil
// ---------------------------------------------------------------------------

/**
 * Pause an agent until `resetAt`. Writes a `rate_limit_hit` quota event and
 * updates the agent row to status='paused' with paused_until=resetAt.
 */
export function pauseUntil(
  db: DB,
  agentId: string,
  resetAt: number,
  info: RateLimitInfo,
): void {
  recordQuotaEvent(db, {
    agent_id: agentId,
    kind: "rate_limit_hit",
    meta: {
      resetAt,
      confidence: info.confidence,
      rawSnippet: info.rawSnippet,
    },
  });
  updateAgentStatus(db, agentId, "paused", resetAt);
}

// ---------------------------------------------------------------------------
// snapshot / snapshotForAgent
// ---------------------------------------------------------------------------

/** Read the rolling window state for the whole daemon. */
export function snapshot(
  db: DB,
  windowMs: number = DEFAULT_WINDOW_MS,
): QuotaSnapshot {
  return computeSnapshot(db, windowMs, undefined);
}

/** Read window state for a specific agent. */
export function snapshotForAgent(
  db: DB,
  agentId: string,
  windowMs: number = DEFAULT_WINDOW_MS,
): QuotaSnapshot {
  return computeSnapshot(db, windowMs, agentId);
}

function computeSnapshot(
  db: DB,
  windowMs: number,
  agentId: string | undefined,
): QuotaSnapshot {
  const now = Date.now();
  const windowStartedAt = now - windowMs;
  const events = quotaEventsSince(db, windowStartedAt);

  let requestsInWindow = 0;
  let tokensEstimated = 0;
  let lastRateLimitAt: number | null = null;
  let nextResetAt: number | null = null;

  for (const ev of events) {
    if (agentId !== undefined && ev.agent_id !== agentId) continue;
    if (ev.kind === "request") {
      requestsInWindow += 1;
      const t = ev.meta && typeof ev.meta.tokens_estimated === "number"
        ? ev.meta.tokens_estimated
        : 0;
      tokensEstimated += t;
    } else if (ev.kind === "rate_limit_hit") {
      if (lastRateLimitAt === null || ev.at > lastRateLimitAt) {
        lastRateLimitAt = ev.at;
        const candidate =
          ev.meta && typeof ev.meta.resetAt === "number"
            ? ev.meta.resetAt
            : null;
        if (candidate !== null) nextResetAt = candidate;
      }
    }
  }

  // Historical max for warning threshold. Track in meta_kv so we don't have
  // to scan all history on every snapshot.
  const historicalMaxRaw = getMeta(db, MAX_PER_WINDOW_META_KEY);
  let historicalMax = historicalMaxRaw !== null
    ? Number.parseInt(historicalMaxRaw, 10)
    : 0;
  if (!Number.isFinite(historicalMax)) historicalMax = 0;

  if (requestsInWindow > historicalMax) {
    historicalMax = requestsInWindow;
    setMeta(db, MAX_PER_WINDOW_META_KEY, String(historicalMax));
  }

  const warning =
    historicalMax > 0 && requestsInWindow / historicalMax >= WARNING_THRESHOLD;

  return {
    windowMs,
    windowStartedAt,
    requestsInWindow,
    tokensEstimated,
    lastRateLimitAt,
    nextResetAt,
    warning,
  };
}

// ---------------------------------------------------------------------------
// scheduleResume
// ---------------------------------------------------------------------------

/**
 * Schedule a one-shot wake at `resetAt`. Returns an unschedule function.
 *
 * The bot wires this to a re-poll of the agent's status and a Telegram
 * notification. If `resetAt` is in the past, the callback fires on the next
 * macrotask (setTimeout(0)).
 */
export function scheduleResume(
  agentId: string,
  resetAt: number,
  onWake: (args: { agentId: string; resetAt: number }) => void,
): () => void {
  const now = Date.now();
  const delay = Math.max(0, resetAt - now);

  // setTimeout caps at ~24.8 days (2**31 - 1 ms); clamp to that and re-arm.
  // Two-stage to keep the public API a single Timeout.
  const MAX_DELAY = 0x7fffffff;
  let cleared = false;
  let timer: NodeJS.Timeout | undefined;

  const arm = (remaining: number): void => {
    timer = setTimeout(() => {
      if (cleared) return;
      const left = resetAt - Date.now();
      if (left > 0) {
        arm(Math.min(left, MAX_DELAY));
        return;
      }
      try {
        onWake({ agentId, resetAt });
      } catch {
        // Caller is responsible for its own error handling; do not crash.
      }
    }, Math.min(remaining, MAX_DELAY));
    // Don't hold the event loop open just for a resume timer.
    if (typeof timer.unref === "function") timer.unref();
  };

  arm(delay);

  return () => {
    cleared = true;
    if (timer) clearTimeout(timer);
  };
}

// ---------------------------------------------------------------------------
// Re-exports for convenience (tests / callers that don't want to import db)
// ---------------------------------------------------------------------------

export type { QuotaEventRow };
