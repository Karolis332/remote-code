# Meta-Cognitive Reasoning Prompt Guide
### Make any AI decompose, verify, and score its own answers before you trust them

---

## The Core Idea

Most prompting is one-shot: you ask, the AI answers, and you have no idea how reliable that answer is. Meta-cognitive prompting forces the model to think *about* its own thinking — breaking problems apart, checking its work from multiple angles, and telling you where it's uncertain instead of bluffing.

This is loosely inspired by MIT research on Recursive Language Models (RLMs), where a model decomposes a big problem into sub-problems, solves each one, and recursively combines the results. The full RLM technique requires a code environment, but you can capture the *reasoning pattern* with a single prompt.

---

## The Master Prompt (copy-paste this)

```
Adopt the role of a Meta-Cognitive Reasoning Expert.

For every complex problem:
1. DECOMPOSE: Break the problem into distinct sub-problems.
2. SOLVE: Address each sub-problem, assigning an explicit confidence score (0.0–1.0).
3. VERIFY: Check each answer for logical validity, factual grounding, completeness, and hidden assumptions or bias.
4. SYNTHESIZE: Combine the sub-answers, weighting by confidence.
5. REFLECT: If overall confidence is below 0.8, identify the weakest link, and retry that part.

For simple questions, skip all of this and answer directly.

Always output:
- A clear final answer
- Your overall confidence level
- Key caveats and where you're most uncertain
```

---

## How Each Step Works

**1. Decompose** — A vague question like "should I pivot my business model?" becomes: What's the current model's trajectory? What are the pivot options? What are the switching costs? What does the market data say? Each piece is easier to answer well than the whole.

**2. Solve with confidence scores** — Every sub-answer gets a 0.0–1.0 score:
- **Below 0.4** → Rejected. The reasoning is too weak to use.
- **Above 0.8** → Trusted. Solid enough to build on.
- **In between** → Flagged. The AI says "I'm not sure, and here's why."

**3. Verify from multiple perspectives** — Four checks on every answer:
- Does the logic actually hold?
- Are the facts grounded?
- Is anything missing?
- Are there hidden assumptions?

Most weak AI answers fail at least one of these. This step catches errors before they reach you.

**4. Synthesize** — High-confidence pieces carry more weight in the final answer. Shaky pieces get flagged rather than silently blended in.

**5. Reflect and retry** — If the combined answer is still below the 0.8 threshold, the AI identifies its weakest reasoning and takes another pass at just that part.

**Built-in efficiency:** "What's 2+2?" gets a direct answer. "Should I pivot my business model?" activates the full architecture. The system matches complexity to the problem — no wasted cycles.

---

## How to Use It with Any AI

**Option 1 — Per-conversation:** Paste the master prompt at the start of any chat, then ask your question. Works in ChatGPT, Claude, Gemini, or any model.

**Option 2 — Standing instructions:** Add it to Custom Instructions (ChatGPT), a Project's instructions or Styles (Claude), or a system prompt (API) so it applies automatically.

**Option 3 — On-demand verification:** For an answer you already got, follow up with:
```
Verify your previous answer: check the logic, facts, completeness,
and hidden assumptions. Score your confidence 0.0–1.0 on each claim
and flag anything below 0.8.
```

**Option 4 — Manual recursion (closest to the MIT approach):** For very large problems, run the decomposition yourself:
1. Ask the AI to break the problem into sub-questions (don't answer yet).
2. Ask each sub-question in a *fresh* conversation.
3. Bring the answers back and ask the AI to verify and synthesize them, noting conflicts.

Fresh conversations prevent earlier answers from biasing later ones — that's the "recursive" part.

---

## When to Use It

**Good fits:** business strategy decisions, technical debugging, research synthesis, investment analysis, any high-stakes decision where a confidently wrong answer costs you.

**Skip it for:** simple factual lookups, quick drafts, casual questions. The prompt already tells the model to skip the framework for these, but don't bother pasting it at all if the stakes are low.

---

## Honest Limitations (worth knowing)

- **Self-reported confidence isn't calibrated.** When an AI says "0.85 confidence," that's a useful *relative* signal of where it feels shaky — not a measured probability. Treat scores as flags for where to dig deeper, not as statistics.
- **The model grades its own homework.** Self-verification catches many errors but not all; a model can be confidently wrong through every step. For high-stakes facts, verify externally.
- **This is a prompt pattern, not the actual MIT system.** True Recursive Language Models run code to split and recursively query text — this guide captures the reasoning *style*, which is still a genuine upgrade over one-shot prompting.

---

## The One-Line Summary

Stop accepting AI answers at face value. Demand decomposition, multi-angle verification, confidence scores, and transparent reasoning — and let the AI show its work.
