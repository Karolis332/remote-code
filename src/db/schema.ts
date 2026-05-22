/**
 * SQL DDL for RemoteCode persistence layer (schema version 1).
 *
 * All timestamps are stored as unix milliseconds (INTEGER).
 * `meta` columns hold JSON-encoded strings.
 *
 * To add a future migration, do NOT mutate SCHEMA_SQL. Instead, add a new
 * SQL string keyed by version and append a step in `src/db/index.ts#migrate`.
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agents (
  id              TEXT    PRIMARY KEY,
  name            TEXT    NOT NULL,
  cwd             TEXT    NOT NULL,
  status          TEXT    NOT NULL CHECK (status IN ('idle','running','paused','crashed','killed')),
  paused_until    INTEGER,
  created_at      INTEGER NOT NULL,
  last_active_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id          TEXT    NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role              TEXT    NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  body              TEXT    NOT NULL,
  tokens_estimated  INTEGER,
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_agent_created
  ON messages (agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS quota_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id  TEXT,
  kind      TEXT    NOT NULL CHECK (kind IN ('request','rate_limit_hit','reset','warn')),
  at        INTEGER NOT NULL,
  meta      TEXT
);

CREATE INDEX IF NOT EXISTS idx_quota_events_at
  ON quota_events (at DESC);

CREATE TABLE IF NOT EXISTS auth (
  chat_id    INTEGER PRIMARY KEY,
  paired_at  INTEGER NOT NULL,
  label      TEXT
);

CREATE TABLE IF NOT EXISTS supervisor_log (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  kind  TEXT    NOT NULL,
  body  TEXT    NOT NULL,
  at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_supervisor_log_at
  ON supervisor_log (at DESC);

CREATE TABLE IF NOT EXISTS meta_kv (
  k  TEXT PRIMARY KEY,
  v  TEXT NOT NULL
);
`;
