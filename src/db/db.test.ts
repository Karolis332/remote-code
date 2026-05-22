/**
 * Unit tests for the SQLite persistence layer.
 *
 * All tests run against an in-memory database (`:memory:`) so they are
 * hermetic and require no filesystem.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type DB,
  appendMessage,
  appendSupervisorLog,
  close,
  createAgent,
  deleteAgent,
  getAgent,
  getMeta,
  isPaired,
  listAgents,
  listPaired,
  migrate,
  openDB,
  pair,
  quotaEventsSince,
  recentMessages,
  recentSupervisorLog,
  recordQuotaEvent,
  setMeta,
  touchAgent,
  unpair,
  updateAgentStatus,
} from "./index.js";

interface TableNameRow {
  name: string;
}

describe("db persistence layer", () => {
  let db: DB;

  beforeEach(() => {
    db = openDB(":memory:");
    migrate(db);
  });

  afterEach(() => {
    close(db);
  });

  it("creates every expected table on migration", () => {
    const rows = db
      .prepare<[], TableNameRow>(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      )
      .all();
    const names = rows.map((r) => r.name);

    expect(names).toContain("agents");
    expect(names).toContain("messages");
    expect(names).toContain("quota_events");
    expect(names).toContain("auth");
    expect(names).toContain("supervisor_log");
    expect(names).toContain("meta_kv");

    // schema_version marker set
    expect(getMeta(db, "schema_version")).toBe("1");
  });

  it("createAgent persists and getAgent returns the same row", () => {
    const created = createAgent(db, {
      id: "agent_a",
      name: "Alpha",
      cwd: "/repos/alpha",
    });

    expect(created.id).toBe("agent_a");
    expect(created.name).toBe("Alpha");
    expect(created.cwd).toBe("/repos/alpha");
    expect(created.status).toBe("idle");
    expect(created.paused_until).toBeNull();
    expect(typeof created.created_at).toBe("number");
    expect(typeof created.last_active_at).toBe("number");

    const fetched = getAgent(db, "agent_a");
    expect(fetched).not.toBeNull();
    expect(fetched?.cwd).toBe("/repos/alpha");
    expect(fetched?.status).toBe("idle");
  });

  it("getAgent returns null for unknown id", () => {
    expect(getAgent(db, "nope")).toBeNull();
  });

  it("listAgents orders by last_active_at DESC", () => {
    createAgent(db, { id: "a1", name: "one", cwd: "/a" });
    // Force a measurable time gap so ordering is deterministic.
    const original = Date.now;
    let t = original() + 1000;
    Date.now = () => t;
    createAgent(db, { id: "a2", name: "two", cwd: "/b" });
    t += 1000;
    touchAgent(db, "a1");
    Date.now = original;

    const list = listAgents(db);
    expect(list.map((a) => a.id)).toEqual(["a1", "a2"]);
  });

  it("appendMessage stores and recentMessages returns reverse-chronological", () => {
    createAgent(db, { id: "agent_b", name: "Bravo", cwd: "/repos/bravo" });

    const original = Date.now;
    let t = original();
    Date.now = () => t;

    appendMessage(db, { agent_id: "agent_b", role: "user", body: "first" });
    t += 10;
    appendMessage(db, {
      agent_id: "agent_b",
      role: "assistant",
      body: "second",
      tokens_estimated: 42,
    });
    t += 10;
    appendMessage(db, { agent_id: "agent_b", role: "tool", body: "third" });

    Date.now = original;

    const msgs = recentMessages(db, "agent_b");
    expect(msgs.map((m) => m.body)).toEqual(["third", "second", "first"]);
    expect(msgs[1]?.tokens_estimated).toBe(42);
    expect(msgs[0]?.tokens_estimated).toBeNull();
    expect(msgs[1]?.role).toBe("assistant");
  });

  it("recentMessages honors limit", () => {
    createAgent(db, { id: "agent_c", name: "Charlie", cwd: "/c" });
    for (let i = 0; i < 5; i++) {
      appendMessage(db, { agent_id: "agent_c", role: "user", body: `m${i}` });
    }
    const msgs = recentMessages(db, "agent_c", 2);
    expect(msgs).toHaveLength(2);
  });

  it("updateAgentStatus persists status and paused_until", () => {
    createAgent(db, { id: "agent_d", name: "Delta", cwd: "/d" });
    const resumeAt = Date.now() + 60_000;
    updateAgentStatus(db, "agent_d", "paused", resumeAt);

    const row = getAgent(db, "agent_d");
    expect(row?.status).toBe("paused");
    expect(row?.paused_until).toBe(resumeAt);

    // Clearing paused_until explicitly with null
    updateAgentStatus(db, "agent_d", "idle", null);
    const cleared = getAgent(db, "agent_d");
    expect(cleared?.status).toBe("idle");
    expect(cleared?.paused_until).toBeNull();
  });

  it("deleteAgent cascades to messages", () => {
    createAgent(db, { id: "agent_e", name: "Echo", cwd: "/e" });
    appendMessage(db, { agent_id: "agent_e", role: "user", body: "hi" });
    deleteAgent(db, "agent_e");

    expect(getAgent(db, "agent_e")).toBeNull();
    expect(recentMessages(db, "agent_e")).toHaveLength(0);
  });

  it("recordQuotaEvent stores meta as JSON and quotaEventsSince parses it", () => {
    recordQuotaEvent(db, {
      agent_id: "agent_x",
      kind: "rate_limit_hit",
      meta: { reset_at: 1234567890, window: "5h" },
    });
    recordQuotaEvent(db, { kind: "warn", meta: { pct: 0.8 } });
    recordQuotaEvent(db, { kind: "request" });

    const events = quotaEventsSince(db, 0);
    expect(events).toHaveLength(3);

    const limit = events.find((e) => e.kind === "rate_limit_hit");
    expect(limit?.agent_id).toBe("agent_x");
    expect(limit?.meta).toEqual({ reset_at: 1234567890, window: "5h" });

    const warn = events.find((e) => e.kind === "warn");
    expect(warn?.meta).toEqual({ pct: 0.8 });

    const req = events.find((e) => e.kind === "request");
    expect(req?.agent_id).toBeNull();
    expect(req?.meta).toBeNull();
  });

  it("quotaEventsSince filters by timestamp", () => {
    recordQuotaEvent(db, { kind: "request" });
    const cutoff = Date.now() + 10_000;
    const future = quotaEventsSince(db, cutoff);
    expect(future).toHaveLength(0);
  });

  it("pair / isPaired / unpair lifecycle", () => {
    expect(isPaired(db, 12345)).toBe(false);

    pair(db, 12345, "phone");
    expect(isPaired(db, 12345)).toBe(true);

    const paired = listPaired(db);
    expect(paired).toHaveLength(1);
    expect(paired[0]?.chat_id).toBe(12345);
    expect(paired[0]?.label).toBe("phone");

    // Re-pair updates label without throwing on PK conflict.
    pair(db, 12345, "tablet");
    expect(listPaired(db)[0]?.label).toBe("tablet");

    unpair(db, 12345);
    expect(isPaired(db, 12345)).toBe(false);
    expect(listPaired(db)).toHaveLength(0);
  });

  it("pair without label stores null", () => {
    pair(db, 999);
    const rows = listPaired(db);
    expect(rows[0]?.label).toBeNull();
  });

  it("migrate is idempotent", () => {
    expect(() => {
      migrate(db);
      migrate(db);
      migrate(db);
    }).not.toThrow();
    expect(getMeta(db, "schema_version")).toBe("1");
  });

  it("supervisor log append and recent retrieval", () => {
    appendSupervisorLog(db, "tick", "ok");
    appendSupervisorLog(db, "alert", "p1: agent stuck");

    const rows = recentSupervisorLog(db);
    expect(rows).toHaveLength(2);
    // most recent first
    expect(rows[0]?.kind).toBe("alert");
    expect(rows[1]?.kind).toBe("tick");
  });

  it("meta get/set round-trip with overwrite", () => {
    expect(getMeta(db, "k1")).toBeNull();
    setMeta(db, "k1", "v1");
    expect(getMeta(db, "k1")).toBe("v1");
    setMeta(db, "k1", "v2");
    expect(getMeta(db, "k1")).toBe("v2");
  });

  it("parseJsonSafe returns null for malformed meta (no throw)", () => {
    // Insert raw garbage in the meta column to exercise the safe parser.
    db.prepare(
      `INSERT INTO quota_events (agent_id, kind, at, meta) VALUES (NULL, 'request', ?, ?)`,
    ).run(Date.now(), "{not valid json");

    const events = quotaEventsSince(db, 0);
    expect(events).toHaveLength(1);
    expect(events[0]?.meta).toBeNull();
  });
});
