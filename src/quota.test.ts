/**
 * Tests for the quota tracker.
 *
 * Covers the locked public API:
 *  - parseRateLimit (json + plain text + relative + heuristic)
 *  - recordRequest + snapshot accounting
 *  - pauseUntil persists status='paused' + paused_until
 *  - scheduleResume fires the callback at the scheduled time
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAgent,
  getAgent,
  migrate,
  openDB,
  type DB,
} from "./db/index.js";
import {
  parseRateLimit,
  pauseUntil,
  recordRequest,
  scheduleResume,
  snapshot,
  snapshotForAgent,
} from "./quota.js";

function freshDb(): DB {
  const db = openDB(":memory:");
  migrate(db);
  return db;
}

describe("parseRateLimit", () => {
  it("returns null on empty text", () => {
    expect(parseRateLimit("")).toBeNull();
    expect(parseRateLimit("everything is fine here")).toBeNull();
  });

  it("returns null when no rate-limit keyword is present", () => {
    expect(parseRateLimit("Tokens used: 100. All good.")).toBeNull();
  });

  it("catches structured JSON envelope with reset_at ISO field", () => {
    const now = Date.UTC(2026, 4, 21, 18, 0, 0);
    const resetIso = "2026-05-21T22:00:00Z";
    const chunk = JSON.stringify({
      type: "error",
      subtype: "rate_limit",
      message: "Rate limit exceeded for the 5h window.",
      reset_at: resetIso,
    });
    const info = parseRateLimit(chunk, now);
    expect(info).not.toBeNull();
    expect(info!.confidence).toBe("high");
    expect(info!.resetAt).toBe(Date.parse(resetIso));
    expect(info!.rawSnippet.length).toBeLessThanOrEqual(200);
  });

  it("catches JSON envelope with retry_after_ms", () => {
    const now = 1_700_000_000_000;
    const chunk = JSON.stringify({
      type: "error",
      message: "You have hit a rate limit. Please retry shortly.",
      retry_after_ms: 60_000,
    });
    const info = parseRateLimit(chunk, now);
    expect(info).not.toBeNull();
    expect(info!.confidence).toBe("high");
    expect(info!.resetAt).toBe(now + 60_000);
  });

  it("catches 429 status code in JSON envelope", () => {
    const now = 1_700_000_000_000;
    const chunk = JSON.stringify({
      type: "error",
      status: 429,
      message: "Too many requests.",
      retry_after: 30,
    });
    const info = parseRateLimit(chunk, now);
    expect(info).not.toBeNull();
    expect(info!.confidence).toBe("high");
    expect(info!.resetAt).toBe(now + 30_000);
  });

  it("catches plain-text clock time 'try again at 22:00 PT'", () => {
    // Anchor "now" at 2026-05-21 18:00 UTC; PT (PST=-8h) means 22:00 PT == 06:00 UTC next day.
    const now = Date.UTC(2026, 4, 21, 18, 0, 0);
    const text =
      "Your rate limit has been reached. Please try again at 22:00 PT (in 12 hours).";
    const info = parseRateLimit(text, now);
    expect(info).not.toBeNull();
    expect(info!.confidence).toBe("medium");
    expect(info!.resetAt).toBeGreaterThan(now);
    // 22:00 PT (UTC-8) is 06:00 UTC; from 18:00 UTC that is +12h.
    const expected = Date.UTC(2026, 4, 22, 6, 0, 0);
    expect(info!.resetAt).toBe(expected);
  });

  it("catches plain-text relative form 'in 41 minutes'", () => {
    const now = 1_700_000_000_000;
    const text =
      "Error: rate limit exceeded. Please try again in 41 minutes.";
    const info = parseRateLimit(text, now);
    expect(info).not.toBeNull();
    expect(info!.confidence).toBe("medium");
    expect(info!.resetAt).toBe(now + 41 * 60 * 1000);
  });

  it("catches ISO 'retry after <timestamp>'", () => {
    const now = Date.UTC(2026, 4, 21, 18, 0, 0);
    const iso = "2026-05-21T19:30:00Z";
    const text = `Error: rate limit exceeded. retry after ${iso}.`;
    const info = parseRateLimit(text, now);
    expect(info).not.toBeNull();
    expect(info!.confidence).toBe("medium");
    expect(info!.resetAt).toBe(Date.parse(iso));
  });

  it("falls back to low confidence for unparsable 429 mention", () => {
    const now = 1_700_000_000_000;
    const text = "HTTP 429: please slow down. (no further info)";
    const info = parseRateLimit(text, now);
    expect(info).not.toBeNull();
    expect(info!.confidence).toBe("low");
    expect(info!.resetAt).toBe(now + 30 * 60 * 1000);
  });

  it("truncates rawSnippet to 200 chars", () => {
    const now = 1_700_000_000_000;
    const long =
      "Quota exceeded. " + "x".repeat(500) + " try again in 5 minutes.";
    const info = parseRateLimit(long, now);
    expect(info).not.toBeNull();
    expect(info!.rawSnippet.length).toBeLessThanOrEqual(200);
  });
});

describe("recordRequest + snapshot", () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
    createAgent(db, { id: "agent-1", name: "a1", cwd: "/tmp/a1" });
    createAgent(db, { id: "agent-2", name: "a2", cwd: "/tmp/a2" });
  });

  it("counts requests in the rolling window", () => {
    recordRequest(db, "agent-1", 100);
    recordRequest(db, "agent-1", 200);
    recordRequest(db, "agent-2", 50);

    const global = snapshot(db);
    expect(global.requestsInWindow).toBe(3);
    expect(global.tokensEstimated).toBe(350);
    expect(global.windowMs).toBeGreaterThan(0);
    expect(global.lastRateLimitAt).toBeNull();
    expect(global.nextResetAt).toBeNull();
  });

  it("filters per-agent in snapshotForAgent", () => {
    recordRequest(db, "agent-1", 100);
    recordRequest(db, "agent-1", 200);
    recordRequest(db, "agent-2", 50);

    const a1 = snapshotForAgent(db, "agent-1");
    const a2 = snapshotForAgent(db, "agent-2");
    expect(a1.requestsInWindow).toBe(2);
    expect(a1.tokensEstimated).toBe(300);
    expect(a2.requestsInWindow).toBe(1);
    expect(a2.tokensEstimated).toBe(50);
  });

  it("ignores events outside the window", () => {
    // Use 1ms window: by the time we snapshot, all events are aged out.
    recordRequest(db, "agent-1", 100);
    // wait a couple ms to make sure at >= sinceMs cutoff drops the event.
    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy wait
    }
    const snap = snapshot(db, 1);
    expect(snap.requestsInWindow).toBe(0);
    expect(snap.tokensEstimated).toBe(0);
  });

  it("sets warning when usage >=80% of historical max", () => {
    // First window: 10 requests. historicalMax becomes 10.
    for (let i = 0; i < 10; i++) recordRequest(db, "agent-1");
    const first = snapshot(db);
    // At first observation, requestsInWindow == historicalMax, so warning fires.
    expect(first.warning).toBe(true);
    expect(first.requestsInWindow).toBe(10);
  });
});

describe("pauseUntil", () => {
  it("updates agent status to paused with paused_until set", () => {
    const db = freshDb();
    createAgent(db, { id: "agent-x", name: "x", cwd: "/tmp/x" });
    const now = Date.now();
    const resetAt = now + 30 * 60 * 1000;
    const info = {
      resetAt,
      rawSnippet: "rate limit hit; try again in 30 minutes",
      confidence: "medium" as const,
    };
    pauseUntil(db, "agent-x", resetAt, info);

    const row = getAgent(db, "agent-x");
    expect(row).not.toBeNull();
    expect(row!.status).toBe("paused");
    expect(row!.paused_until).toBe(resetAt);

    // And the rate_limit_hit event is queryable via snapshot.
    const snap = snapshotForAgent(db, "agent-x");
    expect(snap.lastRateLimitAt).not.toBeNull();
    expect(snap.nextResetAt).toBe(resetAt);
  });
});

describe("scheduleResume", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("invokes the callback at the scheduled time", () => {
    const onWake = vi.fn();
    const resetAt = Date.now() + 5_000;
    const cancel = scheduleResume("agent-1", resetAt, onWake);

    expect(onWake).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4_999);
    expect(onWake).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(onWake).toHaveBeenCalledWith({ agentId: "agent-1", resetAt });

    cancel();
  });

  it("cancel() prevents the callback from firing", () => {
    const onWake = vi.fn();
    const resetAt = Date.now() + 1_000;
    const cancel = scheduleResume("agent-1", resetAt, onWake);
    cancel();
    vi.advanceTimersByTime(2_000);
    expect(onWake).not.toHaveBeenCalled();
  });

  it("fires immediately when resetAt is in the past", () => {
    const onWake = vi.fn();
    const resetAt = Date.now() - 1_000;
    scheduleResume("agent-1", resetAt, onWake);
    vi.advanceTimersByTime(1);
    expect(onWake).toHaveBeenCalledTimes(1);
  });
});
