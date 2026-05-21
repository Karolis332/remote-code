# RemoteCode Architecture

## Goal

Run an "office" of Claude Code agents on a single PC. Each agent is a long-lived `claude` CLI subprocess with its own working directory, history, and quota accounting. Phone → Telegram → daemon → agents. No cloud relay; Telegram is the bus.

## Components

### 1. Daemon (`src/index.ts`)
Long-running Node process. Boots on system start (later: systemd/launchd/Win service). Opens a Telegram long-poll, opens a SQLite handle, loads agents from state.

### 2. Auth (`src/auth.ts`)
- First-run: prints a 6-digit pairing code on stdout.
- User sends `/pair <code>` from their phone — daemon binds that `chat_id` to allowed list, persists.
- Every subsequent message: chat_id must be in `ALLOWED_CHAT_IDS` or it's silently dropped.

### 3. Bot (`src/bot.ts`)
Telegraf handlers map slash-commands to internal RPCs. Long outputs (Telegram limit: 4096 chars/message) get auto-paginated. Files >4 KB sent as document upload.

### 4. Agent runner (`src/claude-runner.ts`)
- Spawns `claude --print --output-format=stream-json` (or whatever the current Claude Code stream protocol is — verify against installed CLI on first run).
- One subprocess per agent. Stdin piped for prompts; stdout/stderr captured and streamed back to Telegram.
- Detects rate-limit errors in CLI output (regex on stderr + JSON error envelope).
- Persists every (prompt, response) pair to SQLite.

### 5. Quota tracker (`src/quota.ts`)
- Rolling 5-hour window of detected interactions.
- Counts: messages-this-window, tokens-estimated, last-reset-time.
- On rate-limit detection from CLI: parse reset timestamp, mark agent `paused-until=<ts>`, schedule resume via setTimeout. Notify chat.
- Soft warning threshold at 80% of estimated quota.

### 6. State (`src/db.ts`)
SQLite via `better-sqlite3`. Schema:

```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL,         -- 'idle' | 'running' | 'paused' | 'killed'
  paused_until INTEGER,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL,           -- 'user' | 'assistant' | 'system'
  body TEXT NOT NULL,
  tokens_estimated INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(agent_id) REFERENCES agents(id)
);

CREATE TABLE quota_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT,
  kind TEXT NOT NULL,           -- 'request' | 'rate_limit_hit' | 'reset'
  at INTEGER NOT NULL,
  meta TEXT                     -- JSON
);

CREATE TABLE auth (
  chat_id INTEGER PRIMARY KEY,
  paired_at INTEGER NOT NULL,
  label TEXT
);
```

### 7. Installer (`scripts/install.{sh,ps1}`)
Detects platform, downloads Node/Bun if missing, clones repo, registers service. Out of scope for v0 build but scaffold the files.

## Data flow (single message)

1. User on phone: `/run myproj "fix the failing test"`
2. Telegraf handler resolves agent `myproj` → checks `paused_until` → routes to runner.
3. Runner writes prompt to agent subprocess stdin.
4. Stdout stream: tokenized JSON events. Runner buffers, sends progress updates every N seconds (or final on stream close).
5. Quota tracker increments counters; if rate-limit JSON detected: agent → `paused`, response → "Limit hit at HH:MM, resuming HH:MM."
6. On schedule timer fire: agent → `idle`, ready for next prompt.

## Non-goals (v0)

- Hosted relay (zero-infra design = Telegram only).
- Encryption beyond Telegram's transport.
- Multi-user license keys (v2).
- Web dashboard (v2).
- Mobile push outside Telegram (v2).

## Open questions (verify during build)

- Exact CLI flag for streaming JSON output from current `claude` (training data may be stale; check `claude --help`).
- Whether `claude` exits after each `--print` invocation or stays interactive (changes process model: one-shot per prompt vs persistent stdin).
- Reset-time format in Claude rate-limit errors (HH:MM PT vs ISO vs unix ts).
