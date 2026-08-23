# remote-code

<!-- Project notes for AI agents. Body: stack, commands, conventions, constraints. -->

## Session Log

Rolling context so a fresh session — or a different model, account or tool — starts where the
last one stopped. Append one entry per completed unit of work (shipped code, a decision, an
artifact, a resolved incident); commit it with the work it describes.

```
### YYYY-MM-DD — <topic>
- **Did:** what shipped, with commit SHAs / file paths / IDs
- **Why:** the decision and the reason, especially where the obvious choice was rejected
- **Open:** what is unfinished, expiring, or deferred — with the trigger
```

Newest last, **last 10 entries only** — this file loads into context every session, so an
unbounded log would eat the smart zone it exists to protect. Promote anything still valuable
past that into the body above, or into `brain/`. No secrets or customer PII: this is committed.
