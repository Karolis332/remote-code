# RemoteCode

> Run a fleet of Claude Code agents on your PC. Control them from your phone via Telegram. Session-aware, quota-aware, multi-agent.

**Status:** v0 scaffold. Pre-alpha. Do not deploy to anything you care about yet.

## What it does

RemoteCode turns your computer into an **office of AI agents**:

- **Multi-agent.** Spawn N agents, each pinned to its own working directory, conversation history, and identity. They run in parallel.
- **Phone-controlled.** Drive all of them from one Telegram chat. `/run` a prompt, `/status` to see what's running, `/kill` if something hangs.
- **Session-aware.** RemoteCode tracks Claude Code's rate-limit windows (5h Pro/Max windows, API quotas). When a limit hits, agents auto-pause, the bot tells you on Telegram, and work resumes at the reset time.
- **Zero infra.** Telegram itself is the relay — no cloud server, no NAT punching. Your daemon polls the Bot API.

## Why

Coding agents are 24/7 workers stuck inside an 8-hour-a-day human at a desk. RemoteCode unbinds that. You go to lunch, agents keep working. You're on a train, you `/run review the PR`. You're asleep, agents hit their limit and wait politely, then pick back up.

## Architecture

```
[Phone] → Telegram Bot API
              ↓ long-poll
       [Your PC]
       RemoteCode daemon (Node + TS)
         ├── SQLite state (agents, messages, quotas)
         ├── Quota tracker (rolling 5h window)
         └── Agent pool
                ├── agent#1: claude --print  (cwd=/proj-A)
                ├── agent#2: claude --print  (cwd=/proj-B)
                └── agent#N: claude --print  (cwd=/proj-X)
```

## Telegram commands (v0)

| Command | What it does |
|---|---|
| `/pair <code>` | First-time pairing for your phone ↔ this PC |
| `/agents` | List all agents and their status |
| `/new <name> <cwd>` | Spawn a new agent in a working directory |
| `/run <agent> <prompt>` | Send a prompt to an agent |
| `/status` | Global status — running, idle, quota state |
| `/quota` | Show estimated quota remaining and reset time |
| `/kill <agent>` | Terminate an agent |

## Install

_Coming soon._ For now this is dev-only.

```bash
git clone https://github.com/Karolis332/remote-code
cd remote-code
npm install
cp .env.example .env  # fill in TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_IDS
npm run dev
```

## Roadmap

- **v0** — single-host daemon, Telegram bridge, multi-agent, basic quota detection, manual pairing.
- **v1** — cross-platform installer (Win/Mac/Linux), single-binary build via Bun, systemd/launchd/Windows-service registration.
- **v2** — paid tier: license keys, hosted relay for users behind strict NAT, multi-PC fleets, agent templates.

## License

MIT.
