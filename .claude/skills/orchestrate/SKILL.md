---
name: orchestrate
description: Five-artifact planning and delegation system for sizeable initiatives. Use this skill BEFORE starting any multi-file, multi-session, or delegable chunk of work — triggers include "plan this feature", "spec this out", "orchestrate", "let's build [module/stage]", "delegate this", or starting any P-stage or comparable initiative. Produces full analysis, guardrails, a reasoning protocol, a worker system prompt, and an audit rubric, then routes tasks by risk tier. Do not use for trivial single-file tasks.
---

# Orchestrate

Sizeable work fails in a predictable way: execution starts before the spec exists, weak reasoning (a cheaper model, a subagent, or a rushed session) touches something it shouldn't, and nobody defined what "done and correct" means until the audit argument afterward. This skill front-loads the expensive thinking: produce the control system first, then execute inside it.

## Proportionality check (do this first)

Orchestration has overhead. Use it when the initiative spans multiple files/sessions, will be partly delegated (subagents, cheaper models, or autopilot execution), or touches RESERVED areas. For a single-file fix or a <30-minute task, skip this skill and just work under CLAUDE.md — orchestrating trivia is its own failure mode.

## Step 1 — Produce the five artifacts (before any code)

Write them to `orchestration/[initiative-slug]/spec.md` in the repo:

**1. FULL ANALYSIS** — objective and measurable success criteria; task decomposition with dependencies; top 5 failure modes with early warning signals; and a per-task classification:
- **DELEGATE** — safe for a weaker model/subagent (test scaffolding, fixtures with synthetic data, docs, config plumbing)
- **SUPERVISED** — weaker model drafts, strong model reviews before merge
- **RESERVED** — strong model only, often with explicit user approval

The repo's CLAUDE.md defines what is RESERVED here — read it and inherit its list; never downgrade something CLAUDE.md marks sensitive. State any assumptions made about ambiguous requirements.

**2. HARD GUARDRAILS** — NEVER/ALWAYS rules for this initiative, output contracts specific enough that violations are detectable, and stop-and-escalate conditions. Must be consistent with CLAUDE.md: cite it, never contradict it.

**3. REASONING SYSTEM** — the protocol every task follows: decompose → solve with explicit confidence 0.0–1.0 → verify (logic, factual grounding, completeness, hidden assumptions) → synthesize → self-check against the guardrails. Any step below 0.7 confidence is flagged `[UNCERTAIN: reason]` in the output — silent guessing is the failure this whole system exists to prevent.

**4. WORKER SYSTEM PROMPT** — artifacts 2+3 combined into one paste-ready prompt in imperative language, with one compliant and one non-compliant output example. Write it assuming the worker shortcuts anything vague, because it will. This is what gets pasted into a subagent or cheaper model verbatim.

**5. AUDIT RUBRIC** — 5–8 criteria scored 0–10 with one-line definitions of what a 3, 7, and 10 look like; a pass threshold; and an auto-reject list (violations that fail the work regardless of other scores — must include: any RESERVED area touched without approval, untested code paths in critical flows, missing `[UNCERTAIN]` flags where guessing occurred).

## Step 2 — Get sign-off where it matters

If any task is RESERVED or the initiative changes user-facing behavior, show the spec to the user before executing. DELEGATE-only initiatives may proceed directly.

## Step 3 — Execute by tier

- DELEGATE tasks → hand to subagents/worker models with artifact 4 as their system prompt, one task per worker, full context included (workers have no memory of this conversation).
- SUPERVISED tasks → worker drafts, then the audit-work skill grades before anything merges.
- RESERVED tasks → strong model executes directly, still following artifact 3's reasoning protocol.
- Every completed task, regardless of tier, goes through the audit-work skill before it counts as done.

## Step 4 — Keep the spec alive

The spec is version-controlled and living: when audits reveal a repeated worker failure, amend artifact 4 in the spec (structural fix beats repeated correction). When scope changes mid-initiative, update artifact 1 rather than silently drifting. At initiative end, append a short retrospective: what the failure-mode predictions got right, what they missed — that's calibration data for the next spec.

## Honesty rules

- Never begin executing before the spec exists "to save time" — that is the exact anti-pattern.
- Never reclassify a RESERVED task to SUPERVISED because it's inconvenient; escalate the inconvenience instead.
- If the initiative description is too vague to produce meaningful guardrails, ask — a spec built on guesses is theater, not control.
