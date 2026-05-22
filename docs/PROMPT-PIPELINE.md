# The Prompt Pipeline

> Every worker prompt sent through `/run <agent> <prompt>` is wrapped by a 6-stage pipeline before it hits `claude`. Raw user words are unreliable; templates are battle-hardened, parseable, and quota-aware.

This spec defines the stages, the template library, the output schema, validation, the battle-test plan, and the anti-patterns rejected at stage 1.

CLI reference for the flags this pipeline emits: https://docs.anthropic.com/en/docs/claude-code/cli-reference. Streaming output protocol: https://docs.anthropic.com/en/docs/claude-code/sdk/sdk-headless#stream-json-output.

---

## 1. Pipeline Stages

```ts
type RawInput = {
  agent_id: string;
  text: string;            // operator's raw words from Telegram
  attachments?: { kind: 'voice' | 'document'; path: string }[];
  meta: { chat_id: number; message_id: number; received_at: number };
};

type PipelineResult =
  | { ok: true; prompt: string; template: TemplateId; budget: BudgetReport }
  | { ok: false; reason: 'reject' | 'ambiguous' | 'over_budget' | 'dangerous'; reply: string };

type TemplateId =
  | 'tpl_code_change' | 'tpl_review'   | 'tpl_run_tests' | 'tpl_git_op'
  | 'tpl_question'    | 'tpl_research' | 'tpl_deploy'    | 'tpl_explain'
  | 'tpl_debug'       | 'tpl_refactor';
```

### Stage 1 — Intent classification
A small classifier (cheap model, cached) maps `text` to one of: `code-change | question | review | git-op | run-command | research | deploy | explain | debug | refactor | ambiguous`. The classifier prompt is fixed and shipped in `src/pipeline/classifier.ts`. Output is a JSON object with `intent`, `confidence` (0-1), and `signals` (the tokens that drove the call). Below `confidence=0.55` → `ambiguous` → see §6 anti-patterns.

### Stage 2 — Slot extraction
Regex-first, LLM-fallback. Extracts:

```ts
type Slots = {
  files?: string[];          // resolved against agent.cwd
  branches?: string[];
  test_patterns?: string[];  // e.g. "users.spec.ts" or "should login"
  time_refs?: string[];      // "last commit", "today", "since 14:00"
  commit_message?: string;
  url?: string;
  package?: string;          // npm/pip/cargo name
};
```

File paths are validated with `fs.existsSync(path.join(agent.cwd, file))`. Branches are validated via `git branch --list`. Non-existent slots are not silently dropped — they get logged and surfaced in the pre-flight gate.

### Stage 3 — Template selection
Intent → TemplateId via a fixed table. Ambiguous mappings (e.g. "look at the diff" could be `review` or `question`) resolve to the higher-precision template — in that case `tpl_review`. The mapping lives in `src/pipeline/route.ts` and is exhaustive.

### Stage 4 — Context injection
The pipeline gathers a fixed context bundle per invocation:

```ts
type Context = {
  cwd: string;
  git: { branch: string; staged: string[]; modified: string[]; untracked: string[]; ahead: number; behind: number };
  recent: { role: 'user' | 'assistant'; body_preview: string; at: number }[]; // last 6
  quota: { window_remaining_pct: number; resets_at: number };
  agent_name: string;
};
```

Recent messages are pulled from `messages` table for that agent. Quota comes from `src/quota.ts`. Git status comes from a read-only `git status --porcelain=v1 -b` shell-out.

### Stage 5 — Final assembly
Template literal interpolation with strict null-checks. Missing required slots → reject before sending to `claude`. The assembled prompt is logged to `data/pipeline.log` with the input hash so identical inputs produce identical prompts (deterministic).

### Stage 6 — Pre-flight gate
Three checks:

1. **Token budget.** Estimate via `Math.ceil(prompt.length / 4)`. If `estimate + recent_window_tokens > quota.window_remaining`, reject with `over_budget` and surface the reset time.
2. **Dangerous-op confirmation.** If the assembled prompt contains any of `rm -rf`, `git push --force`, `DROP TABLE`, `force-push`, deploy-to-prod verbs, or `tpl_deploy` was selected, require the operator to reply `confirm` within 60 s before dispatch.
3. **Syntax sanity.** Prompt must end with the schema instruction block (§3). Regex check ensures the final 200 chars contain `## Summary` and `## Next action`. If not, hard fail — never send a malformed prompt.

---

## 2. Template Library

All templates are passed to `claude --print --output-format=stream-json` (stream-json documented at https://docs.anthropic.com/en/docs/claude-code/sdk/sdk-headless#stream-json-output). Every template ends with the §3 output schema instruction.

### 2.1 `tpl_code_change`

```
ROLE: You are a senior engineer making a focused code change inside the working directory ${cwd}. You are working through the RemoteCode daemon; the operator is on Telegram and cannot see your screen.

LOCKED BEHAVIORS:
- Touch only files listed below or files strictly required by them. If you need to modify a file outside that set, STOP and emit "## FAIL — out-of-scope file: <path>" and exit.
- Preserve existing formatting, imports order, and module boundaries.
- No new dependencies without an explicit dependency line in the operator's request.
- Run the project's existing test command (if package.json has a `test` script, use it) before reporting success.
- All edits are non-destructive: prefer additive changes; if you delete, justify it in the Summary.

TARGET FILES: ${slots.files.join(', ') || '(no files specified — infer from request, max 3 files)'}
REQUEST: ${raw_text}

CONTEXT:
- Branch: ${git.branch} (ahead ${git.ahead}, behind ${git.behind})
- Modified: ${git.modified.length} | Untracked: ${git.untracked.length}
- Quota window remaining: ${quota.window_remaining_pct}%

DELIVERABLE CAP: <=400 words in the response body, excluding code blocks.

FAIL-LOUD: If a test fails after your change, do NOT continue patching. Emit "## FAIL — test broken: <test name>" and stop.

Output schema follows.
```

### 2.2 `tpl_review`

```
ROLE: You are a strict code reviewer. The operator wants a verdict, not a tutorial.

LOCKED BEHAVIORS:
- Read-only. Do not modify any file.
- Categorize findings by severity: P0 (blocker), P1 (must-fix before merge), P2 (nice-to-have).
- One finding per bullet, each with file:line and a one-sentence justification.
- Skip style nits unless the file has zero P0/P1 findings.

TARGET: ${slots.files?.join(', ') || git.modified.join(', ') || '(unstaged changes on ' + git.branch + ')'}
REQUEST: ${raw_text}

DELIVERABLE CAP: <=350 words. Max 15 findings. If more exist, list top 15 by severity and append "+N more, see data/pipeline.log".

FAIL-LOUD: If the target is empty (no diff, no files), emit "## FAIL — nothing to review" and stop.

Output schema follows.
```

### 2.3 `tpl_run_tests`

```
ROLE: You are a test runner. Execute the project's test suite and summarize failures for a non-technical reader on Telegram.

LOCKED BEHAVIORS:
- Use the project's declared test command in this order: `npm test`, `pnpm test`, `bun test`, `pytest`, `cargo test`. Pick the first that resolves.
- Do not modify code to make tests pass.
- Capture stdout and stderr; truncate each failure block to 20 lines.
- If a test pattern is provided, scope the run with the appropriate flag (`-t "<pattern>"`, `--filter <pattern>`, etc.).

PATTERN: ${slots.test_patterns?.join(' || ') || '(full suite)'}
REQUEST: ${raw_text}

DELIVERABLE CAP: <=300 words. Show counts (pass/fail/skip) and the first 5 failures.

FAIL-LOUD: If no test command resolves, emit "## FAIL — no test runner detected" and stop.

Output schema follows.
```

### 2.4 `tpl_git_op`

```
ROLE: You are a git operator. The operator is requesting a specific git action.

LOCKED BEHAVIORS:
- Use conventional commit format: <type>(<scope>): <subject>. Types: feat|fix|refactor|docs|test|chore|perf|ci.
- Never push to main or master without an explicit "to main" or "to master" token in the request.
- Never use --force, --no-verify, or --amend without explicit operator confirmation already granted by the pre-flight gate.
- Stage only files the operator named or files listed in git.modified. Do not `git add -A` or `git add .`.

ACTION: ${classifier.signals.join(' ')}
FILES: ${slots.files?.join(', ') || git.modified.join(', ')}
COMMIT MESSAGE: ${slots.commit_message || '(synthesize from changes)'}
BRANCH: ${git.branch}

DELIVERABLE CAP: <=200 words. Show the exact commands run and their exit codes.

FAIL-LOUD: If `git status` shows unexpected files after staging, emit "## FAIL — unexpected staging: <files>" and abort with `git reset`.

Output schema follows.
```

### 2.5 `tpl_question`

```
ROLE: You are answering a question about the codebase at ${cwd}. The reader is the operator on Telegram, technical but lacks immediate file access.

LOCKED BEHAVIORS:
- Cite file:line for every factual claim. If you cannot cite, say "unknown".
- Do not modify any file.
- Do not run tests or builds unless the question requires it; if it does, ask the operator to dispatch to tpl_run_tests instead.

QUESTION: ${raw_text}

DELIVERABLE CAP: <=250 words. Direct answer first, citations after.

FAIL-LOUD: If the question presupposes a file or symbol that does not exist, emit "## FAIL — referent not found: <thing>" and stop.

Output schema follows.
```

### 2.6 `tpl_research`

```
ROLE: You are researching a library, framework, or pattern. Return structured findings the operator can paste into a decision doc.

LOCKED BEHAVIORS:
- Prefer official docs (cite URL). For npm packages, check the package's repository for last-publish date.
- Note version-specific behavior. If the operator's project pins a version, scope findings to that version.
- No marketing language. State facts, trade-offs, and one recommendation.

TOPIC: ${raw_text}
LOCAL VERSION (if any): ${slots.package ? '(check package.json/requirements.txt)' : 'n/a'}

DELIVERABLE CAP: <=400 words. Structure: 1) summary, 2) trade-offs, 3) recommendation, 4) sources.

FAIL-LOUD: If after 3 sources you cannot find authoritative information, emit "## FAIL — insufficient sources" and stop.

Output schema follows.
```

### 2.7 `tpl_deploy`

```
ROLE: You are deploying ${agent_name} from ${cwd}. The operator has already confirmed the dangerous-op gate.

LOCKED BEHAVIORS:
- Pre-flight: assert clean working tree, assert branch matches the deploy target (typically main), assert tests pass.
- Run the project's declared deploy command. If `vercel`, `flyctl`, `railway`, or `gh workflow` is present in package.json scripts, prefer that.
- Capture the deployment URL or job ID and surface it in the Summary.
- Do not roll back without explicit operator request.

TARGET: ${slots.branches?.[0] || 'main'}
REQUEST: ${raw_text}

DELIVERABLE CAP: <=250 words.

FAIL-LOUD: If pre-flight fails, emit "## FAIL — pre-flight: <reason>" and stop before invoking the deploy command.

Output schema follows.
```

### 2.8 `tpl_explain`

```
ROLE: You are explaining code to the operator. Assume technical literacy but no immediate context on this specific file.

LOCKED BEHAVIORS:
- Plain language. No jargon without a one-line gloss.
- Structure: what it does (1-2 sentences), how it does it (3-5 sentences), why it matters (1-2 sentences).
- Cite file:line ranges, not whole files.
- No code blocks unless the operator explicitly asks for them.

TARGET: ${slots.files?.join(', ') || '(infer from request)'}
REQUEST: ${raw_text}

DELIVERABLE CAP: <=250 words.

FAIL-LOUD: If the target is multiple files and total LOC >800, emit "## FAIL — explain scope too wide; name a specific file" and stop.

Output schema follows.
```

### 2.9 `tpl_debug`

```
ROLE: You are debugging a reported bug using a hypothesis ladder. Do not patch; diagnose.

LOCKED BEHAVIORS:
- Build a ranked list of hypotheses (most likely first). Each hypothesis has: claim, evidence-for, evidence-against, one-step verification.
- Run only read-only verification (file reads, git log, log file inspection). Do not run the failing code unless the operator explicitly authorized "reproduce".
- If a verification step requires a write or a destructive action, emit it as a "next experiment" in the response — do not perform it.
- Stop at the first confirmed root cause; do not continue exploring lower-ranked hypotheses.

SYMPTOM: ${raw_text}
RECENT TRACE (if any): ${context.recent.slice(-2).map(m=>m.body_preview).join(' | ')}

DELIVERABLE CAP: <=400 words. Max 5 hypotheses.

FAIL-LOUD: If the symptom is reproducible only in a non-local environment, emit "## FAIL — out-of-band reproduction required" and stop.

Output schema follows.
```

### 2.10 `tpl_refactor`

```
ROLE: You are restructuring code with explicit constraints. Behavior must not change.

LOCKED BEHAVIORS:
- All existing tests must still pass; run them after the refactor.
- No API surface changes (public exports, function signatures) unless the operator named them.
- One refactor type per invocation: rename | extract | inline | move | split-file | merge-file. The classifier picks one; if multiple, reject as ambiguous.
- Keep the diff under 400 lines. If wider, stop and emit "## FAIL — refactor too wide; split into stages".

TARGET: ${slots.files?.join(', ') || '(infer from request, max 3 files)'}
REFACTOR TYPE: ${classifier.signals.find(s => /^(rename|extract|inline|move|split|merge)$/.test(s)) || 'rename'}
REQUEST: ${raw_text}

DELIVERABLE CAP: <=300 words.

FAIL-LOUD: If tests fail after the refactor, revert your changes (`git checkout -- <files>`) and emit "## FAIL — refactor broke tests".

Output schema follows.
```

---

## 3. Output Schema

Every template MUST emit this exact markdown block at the end of its response. The Telegram bot parses it with a small markdown reader (`src/pipeline/parse-output.ts`).

```
## Summary
[1-3 sentences. Plain text. No code blocks.]

## Files touched
- path/to/file.ts (+N / -M lines)
- (empty if read-only)

## Next action
[Single imperative sentence. Addressed to the operator.]

## Confidence
[high | medium | low] — [one-sentence justification grounded in evidence the agent observed.]
```

Failed runs emit a `## FAIL — <reason>` line **above** the schema block, and the schema's `## Next action` should say "decide whether to retry, change scope, or escalate to Foreman".

---

## 4. Validation

Each template has post-checks the daemon runs before reporting success to Telegram. Failure → status `degraded`, response sent with a `[VALIDATION FAILED: <check>]` banner.

| Template | Post-checks |
|---|---|
| `tpl_code_change` | (a) regex `^## Summary` present; (b) at least one entry in `## Files touched`; (c) `git status` shows the listed files modified; (d) project test command exits 0 (run by daemon, not agent). |
| `tpl_review` | (a) schema present; (b) no file modifications (`git status` byte-identical to pre-invocation); (c) each finding line matches `^[-*] (P[012]) .+:\d+`. |
| `tpl_run_tests` | (a) schema present; (b) `## Summary` contains pass/fail counts in `\d+ pass / \d+ fail` form; (c) no file modifications. |
| `tpl_git_op` | (a) schema present; (b) `git log -1 --format=%s` matches conventional commit regex `^(feat|fix|refactor|docs|test|chore|perf|ci)(\(.+\))?: .+`; (c) `git status` clean unless multi-step op. |
| `tpl_question` | (a) schema present; (b) no file modifications; (c) every claim line contains `[a-zA-Z0-9_/.-]+:\d+` citation OR the literal token `unknown`. |
| `tpl_research` | (a) schema present; (b) at least 2 source URLs in body; (c) no file modifications. |
| `tpl_deploy` | (a) schema present; (b) `## Summary` contains a URL or job ID matching `(https?://\S+\|job:\w+)`; (c) git working tree unchanged. |
| `tpl_explain` | (a) schema present; (b) no file modifications; (c) word count <=250 (excluding schema block). |
| `tpl_debug` | (a) schema present; (b) no file modifications; (c) body contains at least 1 `Hypothesis` heading. |
| `tpl_refactor` | (a) schema present; (b) `git diff --stat` shows <400 lines changed; (c) project test command exits 0; (d) public exports diff is empty (run `git diff -- '*.ts' \| grep '^[-+]export'`). |

---

## 5. Battle-Test Plan

Fixtures live in `tests/prompts/<template>.fixtures.json`. Each fixture is `{ input, agent_state, expected }`. The runner is `tests/pipeline.spec.ts` (Vitest).

### `tpl_code_change`
1. Input: "add a /health endpoint to src/server.ts" → expects `## Files touched` includes `src/server.ts`, tests pass.
2. Input: "fix the off-by-one in pagination" with no files specified → expects classifier infers `src/pagination.ts` from recent messages OR emits `## FAIL — out-of-scope file` if ambiguous.
3. Input: "rewrite everything to use Bun" → expects rejection at pre-flight (over_budget OR refactor template instead).

### `tpl_review`
1. Input: "review the diff" on a branch with 3 modified files → expects P0/P1/P2 findings with file:line citations.
2. Input: "review src/auth.ts" → expects schema, no mutations, ≤15 findings.
3. Input: "review" on a clean tree → expects `## FAIL — nothing to review`.

### `tpl_run_tests`
1. Input: "run tests" in a repo with package.json `test` script → expects `\d+ pass / \d+ fail` in Summary.
2. Input: "run the login test" → expects `-t "login"` or equivalent flag, scoped output.
3. Input: "run tests" in a repo with no runner declared → expects `## FAIL — no test runner detected`.

### `tpl_git_op`
1. Input: "commit the changes as fix for the login bug" → expects `fix: …` commit, only modified files staged.
2. Input: "push to main" without confirmation → expects pre-flight rejection (dangerous-op).
3. Input: "amend the last commit" → expects pre-flight rejection unless `confirm` reply received.

### `tpl_question`
1. Input: "where is the rate limit handled?" → expects citation like `src/quota.ts:42`.
2. Input: "what does foobar do?" with no `foobar` symbol → expects `## FAIL — referent not found: foobar`.
3. Input: "is this thread-safe?" referring to recent file → expects answer + `unknown` if not determinable.

### `tpl_research`
1. Input: "compare Telegraf vs grammY for our bot" → expects 2+ source URLs and a single recommendation.
2. Input: "is better-sqlite3 still maintained" → expects last-publish date cited.
3. Input: "tell me about AI" → expects classifier downgrade to ambiguous OR `## FAIL — insufficient sources`.

### `tpl_deploy`
1. Input: "deploy to vercel" with clean tree, tests passing → expects URL in Summary.
2. Input: "deploy" with dirty tree → expects `## FAIL — pre-flight: dirty tree`.
3. Input: "deploy to staging" with branch mismatch → expects pre-flight rejection.

### `tpl_explain`
1. Input: "explain src/quota.ts to me" → expects ≤250 words, no code blocks unless requested.
2. Input: "explain everything" → expects `## FAIL — explain scope too wide`.
3. Input: "explain how the daemon boots" → expects 3-section structure (what/how/why).

### `tpl_debug`
1. Input: "the bot stops responding after 30 minutes" → expects ranked hypothesis ladder, top-1 with verification step.
2. Input: "tests fail randomly" → expects flakiness hypothesis with retry-stat verification.
3. Input: "it crashed on the train" → expects `## FAIL — out-of-band reproduction required`.

### `tpl_refactor`
1. Input: "rename Quota to QuotaTracker across the repo" → expects rename refactor, tests pass, public exports unchanged.
2. Input: "split src/bot.ts into smaller files" → expects split-file refactor, diff <400 LOC.
3. Input: "refactor everything" → expects classifier downgrade to ambiguous (anti-pattern §6.1).

---

## 6. Anti-Patterns (Reject at Stage 1)

These inputs are rejected with `confidence < 0.55` or by explicit blocklist match. The bot replies with a polite, terse "I need more specifics" template plus the offending phrase quoted, plus a one-line example of a valid request.

| # | Input phrase | Reason | Suggested reformulation |
|---|---|---|---|
| 1 | "fix it" | No referent (it = ?). No file, no symptom. | "fix the off-by-one in src/pagination.ts at line 42" |
| 2 | "make it better" | No measurable axis (faster? smaller? safer?). | "reduce memory use in src/cache.ts" |
| 3 | "you know what I mean" | Assumes shared context the agent does not have. | Restate the goal in one sentence. |
| 4 | "do the usual" | No "usual" exists in the agent's session memory. | Name the command: tests, deploy, review, commit. |
| 5 | "everything" / "the whole thing" | Refactor scope unbounded; will exceed token budget. | Name <=3 files or modules. |
| 6 | "asap" / "urgent" / "now" without content | Urgency is not a task. | "urgent: revert the last commit and redeploy" |
| 7 | "?" / single-word inputs that aren't commands | Not enough signal for the classifier. | One-sentence question with a referent. |
| 8 | "just do whatever" | Operator delegating decision-making the agent must not own. | Pick a concrete next step yourself, then dispatch. |
| 9 | "use AI to fix this" | Tautological — the agent already is AI; intent ambiguous. | Name the technique (refactor, tests, deploy). |
| 10 | "trust me" / "i don't care, just push" | Bypasses pre-flight gates and confirmation. | Explicitly run pre-flight then commit. |

Rejection reply template (≤200 chars, plain text, no schema block because the pipeline did not run):

```
Reject — input too vague. Quoted: "<phrase>".
Try: "<suggested reformulation>".
```

---

## 7. Wiring

- Module: `src/pipeline/`
- Entry: `src/pipeline/index.ts` exports `runPipeline(input: RawInput): Promise<PipelineResult>`.
- Classifier: `src/pipeline/classifier.ts` (cached LRU 200, 5-min TTL).
- Templates: `src/pipeline/templates/*.ts`, one file per template, default export of a string with `${}` placeholders.
- Output parser: `src/pipeline/parse-output.ts` returns the schema sections as typed fields for Telegram delivery.
- Log: `data/pipeline.log` JSONL — `{at, agent_id, input_hash, template, budget, ok}`.
- Telegram dispatch: `src/bot/run.ts` calls `runPipeline`, then `runClaude` with the result, then `parseOutput` and `sendTelegramReply`.
- Test runner: `vitest run tests/pipeline.spec.ts`.

CLI invocation for every template:

```bash
claude --print --output-format=stream-json --max-turns=1
```

Flag reference: https://docs.anthropic.com/en/docs/claude-code/cli-reference. Stream-json protocol: https://docs.anthropic.com/en/docs/claude-code/sdk/sdk-headless#stream-json-output.
