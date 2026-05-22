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

## Expanded requirements (added 2026-05-21)

### Overseer agent (v0)
A dedicated always-on agent of role `overseer` runs in the background separate from worker agents. Its job:
- Periodically run `claude` in code-review mode against any active worktree (look for uncommitted changes, syntax errors, TODOs, security smells).
- Watch worker agents' message history; flag anomalies (stuck >30 min, repeated errors, scope drift from original prompt).
- Send a daily digest to the operator on Telegram (configurable time, default 18:00 EET).
- One overseer per RemoteCode instance; cannot be `/kill`'d (just paused).

### Voice messages (v0.5)
Accept Telegram voice notes (`message.voice`):
- Download `.oga` via Bot API.
- Transcribe via OpenAI Whisper API (operator already has key) or local `whisper.cpp` if `OPENAI_API_KEY` absent.
- Treat transcript as a `/run` to the default agent (or parse leading `/cmd` prefix in transcript).

### Auto-start on boot (v1, but design v0 for it)
- Windows: `nssm install RemoteCode "C:\Program Files\RemoteCode\remote-code.exe"` registers as Windows service.
- macOS: `~/Library/LaunchAgents/com.remotecode.daemon.plist` with `RunAtLoad=true` + `KeepAlive=true`.
- Linux: `~/.config/systemd/user/remote-code.service` with `Restart=always` + `WantedBy=default.target`.
- Installer scripts (`scripts/install.{sh,ps1}`) handle registration.

### Always-online resilience (v0)
- Daemon recovers from any single-agent crash without restarting the bot.
- Per-agent watchdog: if subprocess dies, mark agent `crashed`, notify Telegram, optionally auto-respawn (configurable).
- Telegram long-poll has exponential backoff on `getUpdates` errors (network down).
- SQLite WAL mode + periodic checkpoint so state survives `kill -9`.
- Health probe at `/health` (HTTP, localhost-only) so external supervisor (systemd `WatchdogSec`) can detect hang.

## Account model — BYOK (Bring Your Own Claude)

RemoteCode does **not** resell Anthropic capacity. Users link their own Claude account on the daemon side. The daemon discovers and uses the user's already-installed `claude` CLI (which is authenticated against the user's Pro / Max / API subscription via the Anthropic CLI's own auth store).

Implications:
- **No LLM cost passthrough.** RemoteCode pricing is a flat tool subscription ($19/mo solo, $49/mo team, $199/mo agency). Compute cost is whatever the user already pays Anthropic.
- **No API key plumbing in our product.** We never see, store, or proxy the user's Claude credentials.
- **Each user's rate limits apply.** The quota tracker observes the user's CLI behavior (rate-limit errors, response times) — it doesn't talk to Anthropic billing.
- **First-run check:** daemon runs `claude --version` and `claude config get` (or current equivalent) to confirm the CLI is installed and authenticated. If not, it directs the user to https://claude.com/code install/login.
- **Privacy moat:** because we never touch the API key, we cannot exfiltrate it. This is a sales argument for security-conscious users.

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
