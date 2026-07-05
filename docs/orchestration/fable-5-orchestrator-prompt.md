# The Fable 5 Orchestrator Prompt
### Use your strongest model to build guardrails, reasoning systems, and quality gates that keep weaker models in check

---

## The Strategy

The pattern here is **spec with the strong model, execute with the cheap model, audit with the strong model.** Fable 5 does the expensive thinking once — full project analysis, guardrails, rubrics — and packages it into artifacts that constrain lower-tier models (Haiku, Sonnet, GPT-mini class, etc.) during execution. Then Fable 5 audits the output against its own rubric.

Weaker models fail in predictable ways: they drift from scope, invent facts under pressure, skip verification, and sound confident while doing it. The fix isn't hoping they behave — it's giving them a contract they can't easily wander out of, plus an audit loop that catches them when they do.

---

## The Master Prompt (paste into Fable 5)

```
Adopt the role of a Senior AI Systems Architect and Quality Gatekeeper.

You are the strongest model in a multi-model pipeline. Your job is NOT to
execute this project — it is to analyze it completely and produce the
control system that lower-capability models will operate inside.

Here is my project:
[DESCRIBE YOUR PROJECT — goals, context, constraints, deliverables, audience]

The worker model(s) that will execute tasks: [e.g., Claude Haiku, GPT-4o-mini]

Produce the following five artifacts:

═══ 1. FULL PROJECT ANALYSIS ═══
- Restate the objective and define measurable success criteria
- Decompose the project into discrete workstreams and tasks
- Map dependencies between tasks (what must happen before what)
- Identify the 5 most likely failure modes and their early warning signs
- Classify every task as: DELEGATE (safe for a weaker model),
  SUPERVISED (weaker model drafts, strong model reviews), or
  RESERVED (requires strong-model reasoning — do not delegate)
- Flag any ambiguities in my brief and state the assumptions you're making

═══ 2. HARD GUARDRAILS ═══
Write explicit, non-negotiable rules for the worker model:
- NEVER rules (fabricating sources, expanding scope, changing formats,
  making claims without marking them verified/unverified, etc.)
- ALWAYS rules (cite the provided context, preserve terminology,
  stay within the task boundary, etc.)
- Output contracts: exact structure, format, and length limits per
  deliverable type — specific enough that violations are detectable
- Refusal conditions: situations where the worker must STOP and
  escalate instead of guessing

═══ 3. REASONING SYSTEM ═══
Write the reasoning protocol the worker must follow on every task:
1. DECOMPOSE the task into sub-steps before answering
2. SOLVE each step, assigning explicit confidence (0.0–1.0)
3. VERIFY: check logic, factual grounding, completeness, hidden assumptions
4. SYNTHESIZE using confidence weighting
5. Self-check against the guardrails in Section 2 before outputting
Include the escalation rule: any step below 0.7 confidence must be
flagged in the output as [UNCERTAIN: reason], never silently included.

═══ 4. WORKER SYSTEM PROMPT ═══
Combine Sections 2 and 3 into a single, ready-to-paste system prompt
for the worker model. Write it in direct, imperative language a smaller
model can follow reliably: short rules, concrete examples of compliant
vs. non-compliant output, no abstract philosophy. Assume the worker
will take shortcuts wherever the prompt is vague.

═══ 5. AUDIT RUBRIC ═══
Create a scoring rubric I can use (or you can use) to grade worker
outputs:
- 5–8 criteria, each scored 0–10, each with a one-line definition of
  what a 3, a 7, and a 10 look like
- A pass threshold and an auto-reject list (violations that fail the
  output regardless of other scores)
- The 3 checks most likely to catch THIS worker model's typical
  failure modes on THIS project

Format everything so Sections 4 and 5 can be copied out and used
standalone. Ask me clarifying questions ONLY if the project brief is
too ambiguous to produce meaningful guardrails — otherwise proceed.
```

---

## The Audit Prompt (paste back into Fable 5 later)

Once a worker model produces output, bring it back for grading:

```
Adopt the role of the Quality Gatekeeper who authored the attached
rubric and guardrails for this project.

Here is the worker model's output:
[PASTE OUTPUT]

Audit it:
1. Score it against every rubric criterion, with a one-line justification each
2. List every guardrail violation, quoting the offending passage
3. Check all [UNCERTAIN] flags — were they legitimate, and were any
   uncertainties missed (silent guessing)?
4. Verdict: PASS / REVISE / REJECT
5. If REVISE: write the exact correction instructions to send back to
   the worker — specific enough that it cannot misinterpret them
6. If the same failure has appeared repeatedly, propose an amendment
   to the worker system prompt to prevent it structurally
```

---

## The Workflow

1. **Spec** — Run the Master Prompt in Fable 5 with your project brief. Save all five artifacts.
2. **Deploy** — Paste Section 4 (the worker system prompt) into your cheaper model. Feed it one task at a time from the DELEGATE list.
3. **Audit** — Run worker outputs through the Audit Prompt in Fable 5. PASS moves on; REVISE goes back to the worker with the correction instructions.
4. **Escalate** — Anything on the RESERVED list, or anything that fails audit twice, gets done by Fable 5 directly.
5. **Tighten** — When the audit finds a repeated failure, update the worker system prompt with the amendment Fable 5 proposes. The guardrails get stronger as the project runs.

---

## Why This Works (and where it doesn't)

- **Delegation classification is the highest-leverage part.** Most quality disasters come from giving a weak model a task that needed strong reasoning. Forcing an explicit DELEGATE / SUPERVISED / RESERVED call up front prevents that.
- **Small models follow concrete rules far better than principles.** That's why the master prompt demands imperative language and compliant/non-compliant examples in the worker prompt — "never exceed 300 words" beats "be concise."
- **Honest limits:** guardrails reduce failures, they don't eliminate them — weaker models will still occasionally violate explicit rules, which is exactly why the audit loop exists. And confidence scores remain directional signals, not calibrated probabilities; treat [UNCERTAIN] flags as pointers for where to look, not as statistics.
- Naming "Fable 5" in the prompt doesn't unlock hidden abilities — the leverage comes from *where* you spend the strong model's reasoning: on specification and audit, the two places weak models can't police themselves.
