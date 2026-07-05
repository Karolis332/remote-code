---
name: audit-work
description: Grade completed or delegated work against its initiative spec and rubric. Use this skill whenever a subagent or worker model finishes a task, when the user says "audit this", "grade the output", "check the worker's work", "is this done correctly", or before merging any SUPERVISED-tier work from an orchestrated initiative. Also use it to audit Claude's own completed batches at the end of an orchestrated task. Pairs with the orchestrate skill, which produces the rubric this skill enforces.
---

# Audit Work

Delegation without auditing is just hoping with extra steps. This skill is the closing half of the orchestration loop: work comes back, gets graded against the rubric that was written *before* the work started, and either passes, gets exact revision instructions, or gets rejected. The rubric-first sequence matters — grading against criteria invented after seeing the output is how standards quietly erode.

## Step 1 — Load the contract

Locate the initiative's spec at `orchestration/[initiative-slug]/spec.md`. The audit runs against artifact 5 (the rubric) and artifact 2 (the guardrails), plus the repo's CLAUDE.md. If no spec exists — the work wasn't orchestrated — say so, then fall back to auditing against CLAUDE.md and the code-review skill alone, and note the audit is running without an initiative-specific rubric.

## Step 2 — The audit passes (all of them, in order)

1. **Rubric scoring** — every criterion scored 0–10 with a one-line justification each. No skipped criteria; "N/A" requires a stated reason.
2. **Guardrail sweep** — list every violation of artifact 2 and CLAUDE.md, quoting the offending passage or diff hunk. Zero-violation results state "guardrail sweep: clean" explicitly, not implicitly.
3. **Uncertainty check** — review every `[UNCERTAIN]` flag: was it legitimate? Then the harder half: scan for *silent guessing* — confident-sounding claims or values the worker could not actually have verified (invented API behavior, assumed formats, unverified numbers). Missed uncertainty is a worse failure than flagged uncertainty.
4. **Verification evidence check** — done-claims require shown evidence (test output, eval reports, screenshots per the spec). "Should work" without evidence is an automatic finding. If the spec's critical flows require an eval or contract-test run and none is attached, demand it — its absence is an auto-reject where the rubric says so.
5. **Auto-reject list** — check each item on the rubric's auto-reject list explicitly, one line per item, pass/fail.
6. **Code quality dimension** — for code deliverables, invoke the code-review skill's five-pass method (correctness, product fit, security, tests, maintainability) and fold its findings into the scoring rather than duplicating a separate review.

## Step 3 — Verdict and consequences

```
# Audit — [initiative] / [task] — [date]
Scores: (criterion: n/10 — justification)
Guardrail sweep: clean | violations listed
Auto-reject checks: item-by-item pass/fail
Verdict: PASS / REVISE / REJECT
```

- **PASS** — merges/ships. Log the audit to `orchestration/[slug]/audits.md`.
- **REVISE** — write correction instructions precise enough that the worker cannot misinterpret them: file, location, what's wrong, what correct looks like. Vague feedback ("improve error handling") to a weak model produces a second bad attempt; specific feedback produces a fix.
- **REJECT** — the approach itself is wrong or a RESERVED boundary was crossed. Do not iterate; return to the orchestrate skill to re-plan the task, possibly at a higher tier.

**Repeated-failure rule:** the same failure appearing in a second audit is no longer the worker's bug — it's the worker prompt's bug. Propose the structural amendment to artifact 4 in the spec that prevents it, and apply it before the next delegation.

## Honesty rules

- Never soften a verdict because the work is "mostly fine," took long, or was produced by the user or by Claude itself. REQUEST-CHANGES-shaped work gets REVISE, full stop.
- Never inflate findings to appear rigorous; "two minor issues, clean sweep, PASS" is a legitimate and common outcome.
- When auditing Claude's own work, apply MORE suspicion: re-derive expectations from the spec rather than re-reading the reasoning that produced the work, and prioritize executing/verifying over re-explaining.
- The audit log is append-only history — never edit past audits to match a later, kinder narrative.
