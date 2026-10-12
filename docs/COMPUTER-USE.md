# Computer Use — Spec

> **Goal:** drive the user's PC from Telegram using the existing local `claude`
> CLI as the brain. No Anthropic API key. No extra subscription.
>
> **Loop:** screenshot → Claude reads it → Claude emits structured action → daemon
> executes → screenshot → repeat → done.

This document is the build brief for the `dev` agent. Read it, build the
files in the order listed, run the tests after each section, ship.

---

## 1. Constraints (non-negotiable)

- **Brain = local `claude` CLI subprocess.** Uses the user's existing Pro/Max
  subscription auth. Never call the Anthropic API directly.
- **Image input via filesystem.** Write screenshot to `<cwd>/.tmp/screen.png`,
  reference the path inside the prompt. Claude Code reads local files
  natively — no `--image` flag needed.
- **Session continuity via `--resume <session-id>`.** First turn creates a
  session; persist the ID and reuse it for the rest of the loop.
- **Approval gate.** Every destructive action (send, delete, post, pay, run
  shell command) MUST surface an inline ✅/✕ button on Telegram and block
  until the operator answers. Idle clicks/typing inside the user's own apps
  do NOT require approval.
- **No Anthropic SDK in dependencies.** Adding `@anthropic-ai/sdk` for this
  feature breaks the architectural promise. Keep it CLI-only.

---

## 2. Architecture

```
┌─────────────┐    /control "send invoice to ACME"
│   Phone     │ ───────────────────────────────────►
└─────────────┘
       ▲                                            ┌──────────────┐
       │ screenshot + ✅/✕ approval                 │  daemon      │
       │                                            │              │
       │             ┌─────── screenshot ───────────┤  loop.ts     │
       │             ▼                              │              │
       │      ┌──────────────┐                      └──────┬───────┘
       │      │ .tmp/screen  │                             │
       │      │     .png     │                             │
       │      └──────────────┘                             │
       │             │                                     │ spawn claude -p
       │             │  read file                          │ --resume <id>
       │             ▼                                     ▼
       │      ┌──────────────────────────────────────────────────┐
       │      │   claude CLI subprocess (user's subscription)    │
       │      │   reads screenshot, emits one JSON action        │
       │      └──────────────────────────────────────────────────┘
       │             │
       │             │  { "action":"click", "x":120, "y":900 }
       │             ▼
       │      ┌──────────────┐
       │      │  nut-js      │  mouse + keyboard
       └──────┤  executor    │
              └──────────────┘
```

---

## 3. Files to create

| File                             | Purpose                                            | Est lines |
| -------------------------------- | -------------------------------------------------- | --------- |
| `src/computer/screenshot.ts`     | Capture desktop → PNG bytes + file write           | 60        |
| `src/computer/executor.ts`       | nut-js wrapper: click, type, scroll, key, drag     | 120       |
| `src/computer/actions.ts`        | Action JSON schema (zod) + parser + validator      | 90        |
| `src/computer/loop.ts`           | Main loop: screenshot → claude → parse → execute   | 180       |
| `src/computer/prompt.ts`         | System prompt + per-turn user prompt construction  | 80        |
| `src/computer/approval.ts`       | Telegram inline ✅/✕ confirmation flow             | 100       |
| `src/db/computer-sessions.ts`    | DB table + helpers: persist Claude session IDs     | 80        |
| `src/bot.ts` (edit)              | New `/control <goal>` command + NL intent          | +40       |
| Tests for each above             | vitest, mocked subprocess + mocked nut-js          | ~400      |

Total ~1,150 lines + tests. Realistic 2-3 day spike.

---

## 4. Action schema

The CLI must reply with **exactly one JSON object per turn**, no prose. Use
zod for parsing.

```ts
type Action =
  | { type: "click"; x: number; y: number; button?: "left" | "right" }
  | { type: "double_click"; x: number; y: number }
  | { type: "type"; text: string }
  | { type: "key"; key: string } // e.g. "Enter", "Ctrl+A", "Win"
  | { type: "scroll"; x: number; y: number; dy: number }
  | { type: "drag"; from: [number, number]; to: [number, number] }
  | { type: "wait"; ms: number }
  | { type: "approval_required"; summary: string; risk: "low" | "high" }
  | { type: "done"; summary: string }
  | { type: "blocked"; reason: string };
```

`approval_required` and `blocked` halt the loop and surface to the operator.

---

## 5. System prompt (verbatim — put in `src/computer/prompt.ts`)

```text
You are the controller of a Windows PC. The operator gave you a goal. You can
see the current screen via the screenshot at `.tmp/screen.png` (read it).
After each action the daemon takes a new screenshot and replays the loop.

OUTPUT FORMAT:
Reply with EXACTLY ONE JSON object on a single line. No prose, no markdown,
no code fences. The object must match this schema:

{type: "click" | "double_click" | "type" | "key" | "scroll" | "drag" |
       "wait" | "approval_required" | "done" | "blocked", ...}

RULES:
1. Coordinates are screen pixels, origin top-left.
2. Read .tmp/screen.png BEFORE every reply. Resolutions can change.
3. Never invent a coordinate you cannot see. If unsure, emit
   {"type":"approval_required","summary":"...","risk":"high"}.
4. Destructive actions (send email, delete file, run shell, pay, post)
   ALWAYS use approval_required first. After approval is granted the
   operator will message you "approved" — then proceed.
5. If the goal is impossible from the current state, emit
   {"type":"blocked","reason":"<short>"}.
6. When the goal is fully achieved, emit
   {"type":"done","summary":"<one sentence>"}.
7. Keyboard keys use the nut-js naming: "Enter", "Tab", "Backspace",
   "Escape", "Up", "Down", "Left", "Right", "F1"-"F12". Modifiers join
   with "+": "Ctrl+C", "Ctrl+Shift+T", "Win+E".
8. Prefer typing visible UI labels over guessing coordinates. If you can
   open a search/command palette (Ctrl+Shift+P, Win, etc.), use it.
9. If the screenshot shows a CAPTCHA, login screen, or 2FA prompt, ALWAYS
   emit approval_required.
```

---

## 6. Loop pseudocode

```ts
async function runControlLoop(goal: string, deps: Deps): Promise<Outcome> {
  let sessionId: string | null = null;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    await screenshot.captureTo(".tmp/screen.png");
    const prompt = buildPrompt({ goal, turn });
    const reply = await runClaude({
      cwd: deps.cwd,
      prompt,
      resume: sessionId,
      onSessionId: (id) => (sessionId = id),
    });
    const action = actions.parse(reply);
    if (action.type === "done") return { ok: true, summary: action.summary };
    if (action.type === "blocked") return { ok: false, reason: action.reason };
    if (action.type === "approval_required") {
      const ok = await approval.ask(action.summary, action.risk);
      if (!ok) return { ok: false, reason: "user denied" };
      // After approval, next turn proceeds.
      continue;
    }
    await executor.run(action);
    await delay(150); // let UI settle
  }
  return { ok: false, reason: "max turns exceeded" };
}
```

`MAX_TURNS = 40` by default. Operator-overridable via env.

---

## 7. Telegram surface

### New command: `/control <goal>`

Example: `/control open notepad and write hello world`

Lifecycle:
1. Bot replies: `🎯 Goal locked: "open notepad and write hello world"`
2. After every executed action: bot edits a status message with the latest screenshot + last action.
3. On `approval_required`: inline keyboard `✅ Approve | ✕ Deny` blocks the loop.
4. On `done` or `blocked`: final summary + final screenshot.

### Natural-language route

Add to the NLP system prompt (in `src/nlp.ts`):
```
- {"command":"control","goal":"<verbatim>"} — user wants the bot to drive the PC
```

Trigger phrases: "do X for me", "open Y and do Z", "control the PC and ...",
"make Notepad show hello world", etc.

---

## 8. Safety

- **Killswitch.** `/abort` cancels the in-flight loop. Bind to `Ctrl+Alt+Q`
  on the host PC as a hardware-level abort (`globalkey` package).
- **Workspace fence.** Loop runs ONLY when an operator-paired chat sent
  `/control`. No autonomous activation.
- **Destructive-action whitelist.** Hard-coded list of keywords in
  approval.ts that force approval_required regardless of model output:
  `delete`, `format`, `rm `, `git push`, `pay`, `send to`, `transfer`,
  `publish`, `deploy`.
- **Max turn cap.** Loop dies at 40 turns to bound damage from an
  infinite-loop bug.

---

## 9. Test plan

- **screenshot.test.ts** — mock fs, assert PNG header bytes; assert correct
  cwd-relative path.
- **executor.test.ts** — mock nut-js, assert each action shape produces the
  right SDK call; assert blacklisted keys (Win+L, Ctrl+Alt+Del) are
  rejected.
- **actions.test.ts** — parse 30+ JSON strings: valid, invalid, missing
  fields, extra fields, fenced output, prose-around-JSON.
- **loop.test.ts** — stub claude-runner to return a scripted sequence of
  actions; assert executor was called in the right order and the loop
  terminated on `done`.
- **approval.test.ts** — stub Telegram ctx; assert ✅ resolves to true, ✕
  to false, timeout (60s) to false.
- **end-to-end smoke** — `npm run probe:computer` opens Notepad, types
  "hello", screenshots, kills Notepad. Runs only when `COMPUTER_SMOKE=1`.

Target: 25 new tests, ~95% line coverage on the new module.

---

## 10. Dependencies to add

```json
{
  "dependencies": {
    "@nut-tree-fork/nut-js": "^4.2.0",
    "screenshot-desktop": "^1.15.0",
    "sharp": "^0.34.0"
  }
}
```

Why these:
- `@nut-tree-fork/nut-js` — actively maintained fork of the original nut.js,
  Windows mouse/keyboard + screen reading.
- `screenshot-desktop` — single function `screenshot({ format: "png" })`,
  cross-platform, works on Win/Mac/Linux. No native build dance.
- `sharp` — downscale screenshots to 1280×720 max before saving so Claude
  doesn't pay context tax on full-HD pixels. Optional but recommended.

---

## 11. Build order for `dev` agent

Build, test, commit, move on. Do not skip ahead.

1. `src/computer/screenshot.ts` + test
2. `src/computer/actions.ts` + test (no daemon work yet — pure schema)
3. `src/computer/executor.ts` + test (mocked nut-js)
4. `src/computer/prompt.ts` (no test, it's a constant)
5. `src/computer/approval.ts` + test (mocked telegram ctx)
6. `src/db/computer-sessions.ts` + migration + test
7. `src/computer/loop.ts` + test (stubbed claude-runner)
8. `src/bot.ts` edit: register `/control` + wire `approval.ask` to live
   inline keyboard. Add an integration test that fakes one full turn.
9. Update `src/nlp.ts` system prompt + tests.
10. README section + `docs/COMPUTER-USE.md` quickstart for end users.

After each step: `npm test && npm run typecheck`. Both green before commit.

---

## 12. Known risks

- **JSON parse failures.** Claude occasionally wraps output in fences or adds
  prose. The parser must strip fences and extract the first valid JSON
  object. Acceptable failure rate: <5%. If higher, add a one-shot retry
  with "Reply with JSON only, no prose." in the next prompt.
- **Coordinate drift.** Multi-monitor + DPI scaling on Windows cause click
  offset bugs. Test on the operator's primary 1920×1080 monitor first.
  Multi-monitor is out of scope for the MVP.
- **Rate limit.** Each loop turn = 1 Claude CLI call. 40 turns = 40 calls.
  Plan budget: ~5 control runs per hour on Pro before hitting caps. Max
  plan raises this to ~25. Document this in the README.
- **Latency.** End-to-end per-turn: screenshot 200ms + Claude 4-8s +
  execute 200ms = ~5-9s/turn. A 10-step task = ~1 minute. Acceptable.
- **Security.** A compromised bot token = full PC control. Mitigations:
  ALLOWED_CHAT_IDS gate (already exists), approval prompts on destructive
  actions, hardware killswitch, max turn cap.

---

## 13. Out of scope for MVP

- Multi-monitor support.
- macOS/Linux (Windows-first; nut-js works elsewhere but untested).
- Voice input.
- Async approval (operator must respond within 60s or loop fails).
- Recipe library / saved goals.
- Playback / undo.

These are sprint 2.
