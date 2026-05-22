/**
 * SQLite persistence layer for RemoteCode.
 *
 * Public API is locked - peer modules (bot, claude-runner, quota, supervisor)
 * depend on these signatures. Do not change them without coordinating across
 * the codebase.
 *
 * Storage model:
 *  - File default: ~/.remotecode/state.db
 *  - WAL journaling, synchronous=NORMAL, foreign_keys=ON, busy_timeout=5000ms
 *  - All timestamps are Unix milliseconds (Date.now())
 *  - `meta` columns are JSON strings; helpers parse safely (null on failure)
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { SCHEMA_SQL } from "./schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DB = Database.Database;

export type AgentStatus = "idle" | "running" | "paused" | "crashed" | "killed";
export type MessageRole = "user" | "assistant" | "system" | "tool";
export type QuotaKind = "request" | "rate_limit_hit" | "reset" | "warn";

export interface AgentRow {
  id: string;
  name: string;
  cwd: string;
  status: AgentStatus;
  paused_until: number | null;
  created_at: number;
  last_active_at: number;
}

export interface MessageRow {
  id: number;
  agent_id: string;
  role: MessageRole;
  body: string;
  tokens_estimated: number | null;
  created_at: number;
}

export interface QuotaEventRow {
  id: number;
  agent_id: string | null;
  kind: QuotaKind;
  at: number;
  meta: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Internal row shapes (as returned by better-sqlite3 before normalization)
// ---------------------------------------------------------------------------

interface RawAgentRow {
  id: string;
  name: string;
  cwd: string;
  status: AgentStatus;
  paused_until: number | null;
  created_at: number;
  last_active_at: number;
}

interface RawMessageRow {
  id: number;
  agent_id: string;
  role: MessageRole;
  body: string;
  tokens_estimated: number | null;
  created_at: number;
}

interface RawQuotaEventRow {
  id: number;
  agent_id: string | null;
  kind: QuotaKind;
  at: number;
  meta: string | null;
}

interface RawAuthRow {
  chat_id: number;
  paired_at: number;
  label: string | null;
}

interface RawSupervisorLogRow {
  id: number;
  kind: string;
  body: string;
  at: number;
}

interface RawMetaRow {
  v: string;
}

// ---------------------------------------------------------------------------
// Open / close / migrate
// ---------------------------------------------------------------------------

const CURRENT_SCHEMA_VERSION = "1";

const META_KV_DDL = `CREATE TABLE IF NOT EXISTS meta_kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
)`;

/**
 * Open (or create) the SQLite database at `path`.
 *
 * Special values:
 *  - undefined  -> ~/.remotecode/state.db (parent dir auto-created)
 *  - ":memory:" -> in-memory database (used by tests)
 */
export function openDB(path?: string): DB {
  const resolved = resolveDbPath(path);

  if (resolved !== ":memory:") {
    mkdirSync(dirname(resolved), { recursive: true });
  }

  const db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

function resolveDbPath(path?: string): string {
  if (path === undefined) {
    return join(homedir(), ".remotecode", "state.db");
  }
  return path;
}

/**
 * Split a SQL script into individual statements on `;` boundaries.
 * Simple splitter: our SCHEMA_SQL has no embedded semicolons in strings,
 * so a naive split is safe and avoids needing multi-statement APIs.
 */
function splitStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function runScript(db: DB, sql: string): void {
  for (const stmt of splitStatements(sql)) {
    db.prepare(stmt).run();
  }
}

/**
 * Run migrations to bring the schema up to CURRENT_SCHEMA_VERSION.
 * Idempotent - safe to call on every boot.
 */
export function migrate(db: DB): void {
  // meta_kv must exist before we can read schema_version. Create it
  // independently of SCHEMA_SQL so we can branch on its contents.
  db.prepare(META_KV_DDL).run();

  const current = getMeta(db, "schema_version");

  if (current === null) {
    // Fresh database - install full schema in a single transaction.
    const tx = db.transaction(() => {
      runScript(db, SCHEMA_SQL);
      setMeta(db, "schema_version", CURRENT_SCHEMA_VERSION);
    });
    tx();
    return;
  }

  if (current === CURRENT_SCHEMA_VERSION) {
    return;
  }

  // Future: chain migrations here (v1 -> v2 -> v3 ...).
  throw new Error(
    `Unsupported schema_version "${current}"; expected "${CURRENT_SCHEMA_VERSION}".`,
  );
}

export function close(db: DB): void {
  db.close();
}

// ---------------------------------------------------------------------------
// Safe JSON helpers
// ---------------------------------------------------------------------------

function parseJsonSafe(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function stringifyMeta(
  meta: Record<string, unknown> | undefined | null,
): string | null {
  if (meta === undefined || meta === null) return null;
  try {
    return JSON.stringify(meta);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export function createAgent(
  db: DB,
  args: { id: string; name: string; cwd: string },
): AgentRow {
  const now = Date.now();
  db.prepare(
    `INSERT INTO agents (id, name, cwd, status, paused_until, created_at, last_active_at)
     VALUES (?, ?, ?, 'idle', NULL, ?, ?)`,
  ).run(args.id, args.name, args.cwd, now, now);

  const row = getAgent(db, args.id);
  if (row === null) {
    throw new Error(
      `createAgent: row vanished immediately after insert (id=${args.id})`,
    );
  }
  return row;
}

export function getAgent(db: DB, id: string): AgentRow | null {
  const row = db
    .prepare<[string], RawAgentRow>(
      `SELECT id, name, cwd, status, paused_until, created_at, last_active_at
         FROM agents
        WHERE id = ?`,
    )
    .get(id);
  return row ? normalizeAgent(row) : null;
}

export function listAgents(db: DB): AgentRow[] {
  const rows = db
    .prepare<[], RawAgentRow>(
      `SELECT id, name, cwd, status, paused_until, created_at, last_active_at
         FROM agents
        ORDER BY last_active_at DESC`,
    )
    .all();
  return rows.map(normalizeAgent);
}

export function updateAgentStatus(
  db: DB,
  id: string,
  status: AgentStatus,
  paused_until?: number | null,
): void {
  const pausedValue = paused_until === undefined ? null : paused_until;
  db.prepare(
    `UPDATE agents
        SET status = ?, paused_until = ?, last_active_at = ?
      WHERE id = ?`,
  ).run(status, pausedValue, Date.now(), id);
}

export function touchAgent(db: DB, id: string): void {
  db.prepare(`UPDATE agents SET last_active_at = ? WHERE id = ?`).run(
    Date.now(),
    id,
  );
}

export function deleteAgent(db: DB, id: string): void {
  // ON DELETE CASCADE cleans messages.
  db.prepare(`DELETE FROM agents WHERE id = ?`).run(id);
}

function normalizeAgent(row: RawAgentRow): AgentRow {
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    status: row.status,
    paused_until: row.paused_until ?? null,
    created_at: row.created_at,
    last_active_at: row.last_active_at,
  };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export function appendMessage(
  db: DB,
  args: {
    agent_id: string;
    role: MessageRole;
    body: string;
    tokens_estimated?: number;
  },
): MessageRow {
  const now = Date.now();
  const tokens = args.tokens_estimated ?? null;
  const info = db
    .prepare(
      `INSERT INTO messages (agent_id, role, body, tokens_estimated, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(args.agent_id, args.role, args.body, tokens, now);

  // Bump agent activity in the same logical operation.
  db.prepare(`UPDATE agents SET last_active_at = ? WHERE id = ?`).run(
    now,
    args.agent_id,
  );

  const id = Number(info.lastInsertRowid);
  return {
    id,
    agent_id: args.agent_id,
    role: args.role,
    body: args.body,
    tokens_estimated: tokens,
    created_at: now,
  };
}

export function recentMessages(
  db: DB,
  agent_id: string,
  limit = 50,
): MessageRow[] {
  const rows = db
    .prepare<[string, number], RawMessageRow>(
      `SELECT id, agent_id, role, body, tokens_estimated, created_at
         FROM messages
        WHERE agent_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(agent_id, limit);
  return rows.map((r) => ({
    id: r.id,
    agent_id: r.agent_id,
    role: r.role,
    body: r.body,
    tokens_estimated: r.tokens_estimated ?? null,
    created_at: r.created_at,
  }));
}

// ---------------------------------------------------------------------------
// Quota events
// ---------------------------------------------------------------------------

export function recordQuotaEvent(
  db: DB,
  args: {
    agent_id?: string | null;
    kind: QuotaKind;
    meta?: Record<string, unknown>;
  },
): void {
  const agentId = args.agent_id ?? null;
  const meta = stringifyMeta(args.meta ?? null);
  db.prepare(
    `INSERT INTO quota_events (agent_id, kind, at, meta) VALUES (?, ?, ?, ?)`,
  ).run(agentId, args.kind, Date.now(), meta);
}

export function quotaEventsSince(db: DB, since_ts: number): QuotaEventRow[] {
  const rows = db
    .prepare<[number], RawQuotaEventRow>(
      `SELECT id, agent_id, kind, at, meta
         FROM quota_events
        WHERE at >= ?
        ORDER BY at DESC, id DESC`,
    )
    .all(since_ts);
  return rows.map((r) => ({
    id: r.id,
    agent_id: r.agent_id ?? null,
    kind: r.kind,
    at: r.at,
    meta: parseJsonSafe(r.meta),
  }));
}

// ---------------------------------------------------------------------------
// Auth (Telegram pairing)
// ---------------------------------------------------------------------------

export function isPaired(db: DB, chat_id: number): boolean {
  const row = db
    .prepare<[number], { one: number }>(
      `SELECT 1 AS one FROM auth WHERE chat_id = ?`,
    )
    .get(chat_id);
  return row !== undefined;
}

export function pair(db: DB, chat_id: number, label?: string): void {
  const labelValue = label ?? null;
  db.prepare(
    `INSERT INTO auth (chat_id, paired_at, label)
     VALUES (?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       paired_at = excluded.paired_at,
       label = excluded.label`,
  ).run(chat_id, Date.now(), labelValue);
}

export function unpair(db: DB, chat_id: number): void {
  db.prepare(`DELETE FROM auth WHERE chat_id = ?`).run(chat_id);
}

export function listPaired(
  db: DB,
): Array<{ chat_id: number; paired_at: number; label: string | null }> {
  const rows = db
    .prepare<[], RawAuthRow>(
      `SELECT chat_id, paired_at, label
         FROM auth
        ORDER BY paired_at DESC`,
    )
    .all();
  return rows.map((r) => ({
    chat_id: r.chat_id,
    paired_at: r.paired_at,
    label: r.label ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Supervisor log
// ---------------------------------------------------------------------------

export function appendSupervisorLog(db: DB, kind: string, body: string): void {
  db.prepare(
    `INSERT INTO supervisor_log (kind, body, at) VALUES (?, ?, ?)`,
  ).run(kind, body, Date.now());
}

export function recentSupervisorLog(
  db: DB,
  limit = 100,
): Array<{ id: number; kind: string; body: string; at: number }> {
  const rows = db
    .prepare<[number], RawSupervisorLogRow>(
      `SELECT id, kind, body, at
         FROM supervisor_log
        ORDER BY at DESC, id DESC
        LIMIT ?`,
    )
    .all(limit);
  return rows.map((r) => ({ id: r.id, kind: r.kind, body: r.body, at: r.at }));
}

// ---------------------------------------------------------------------------
// Meta key/value
// ---------------------------------------------------------------------------

export function getMeta(db: DB, k: string): string | null {
  const row = db
    .prepare<[string], RawMetaRow>(`SELECT v FROM meta_kv WHERE k = ?`)
    .get(k);
  return row ? row.v : null;
}

export function setMeta(db: DB, k: string, v: string): void {
  db.prepare(
    `INSERT INTO meta_kv (k, v)
     VALUES (?, ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
  ).run(k, v);
}
