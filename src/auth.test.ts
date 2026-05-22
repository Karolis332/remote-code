/**
 * Unit tests for src/auth.ts.
 *
 * Strategy: open an in-memory SQLite via the real db module so we exercise
 * the same SQL surface the production daemon uses. No telegraf, no network.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  clearPairingCode,
  consumePairingCode,
  getOrIssuePairingCode,
  isAuthorized,
} from "./auth.js";
import { type DB, migrate, openDB } from "./db/index.js";

function freshDb(): DB {
  const db = openDB(":memory:");
  migrate(db);
  return db;
}

describe("getOrIssuePairingCode", () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
  });

  it("returns a fresh 6-char alphanumeric code on first call", () => {
    const code = getOrIssuePairingCode(db);
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
  });

  it("is idempotent: same code on repeated calls until consumed", () => {
    const a = getOrIssuePairingCode(db);
    const b = getOrIssuePairingCode(db);
    const c = getOrIssuePairingCode(db);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("issues a new code after the previous one is consumed", () => {
    const first = getOrIssuePairingCode(db);
    const ok = consumePairingCode(db, first, 111);
    expect(ok).toBe(true);
    const second = getOrIssuePairingCode(db);
    expect(second).not.toBe(first);
    expect(second).toMatch(/^[A-Z2-9]{6}$/);
  });

  it("issues a new code after clearPairingCode", () => {
    const first = getOrIssuePairingCode(db);
    clearPairingCode(db);
    const second = getOrIssuePairingCode(db);
    expect(second).not.toBe(first);
  });
});

describe("consumePairingCode", () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
  });

  it("happy path: binds chat_id and clears the pending code", () => {
    const code = getOrIssuePairingCode(db);
    expect(consumePairingCode(db, code, 42, "phone")).toBe(true);
    // Second consume with the same code must fail (already consumed).
    expect(consumePairingCode(db, code, 43)).toBe(false);
  });

  it("rejects wrong code", () => {
    getOrIssuePairingCode(db);
    expect(consumePairingCode(db, "BADCOD", 7)).toBe(false);
  });

  it("rejects when no code is pending", () => {
    expect(consumePairingCode(db, "ANYCOD", 1)).toBe(false);
  });

  it("is case-insensitive and trims whitespace", () => {
    const code = getOrIssuePairingCode(db);
    const variant = `  ${code.toLowerCase()}  `;
    expect(consumePairingCode(db, variant, 8)).toBe(true);
  });

  it("rejects empty/garbage input", () => {
    getOrIssuePairingCode(db);
    expect(consumePairingCode(db, "", 1)).toBe(false);
    expect(consumePairingCode(db, "   ", 1)).toBe(false);
    // @ts-expect-error — runtime guard for non-string callers
    expect(consumePairingCode(db, undefined, 1)).toBe(false);
  });
});

describe("isAuthorized", () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
  });

  it("returns true for env-allowed chat_ids without pairing", () => {
    expect(isAuthorized(db, 100, [100, 200])).toBe(true);
    expect(isAuthorized(db, 200, [100, 200])).toBe(true);
  });

  it("returns false for unknown chat_ids when not env-allowed", () => {
    expect(isAuthorized(db, 999, [100])).toBe(false);
  });

  it("returns true after a successful pairing", () => {
    const code = getOrIssuePairingCode(db);
    consumePairingCode(db, code, 555);
    expect(isAuthorized(db, 555, [])).toBe(true);
    expect(isAuthorized(db, 556, [])).toBe(false);
  });

  it("env allowlist and pairing list compose", () => {
    const code = getOrIssuePairingCode(db);
    consumePairingCode(db, code, 1);
    expect(isAuthorized(db, 1, [])).toBe(true); // paired
    expect(isAuthorized(db, 2, [2])).toBe(true); // env-allowed
    expect(isAuthorized(db, 3, [2])).toBe(false); // neither
  });
});
