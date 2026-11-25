# Welcome — what this project is, and what it is not

Dream Maker interviews you before it writes code. That is the whole idea, and everything else
in this repository exists to serve it.

## Start here

| If you want to | Go to |
|---|---|
| Run it | [README quick start](https://github.com/xiao18825501901-rgb/dream-maker#quick-start) |
| Understand the ordering | [docs/ARCHITECTURE.md](https://github.com/xiao18825501901-rgb/dream-maker/blob/main/docs/ARCHITECTURE.md) |
| Know why it refuses to spend money | [docs/ZERO_USAGE.md](https://github.com/xiao18825501901-rgb/dream-maker/blob/main/docs/ZERO_USAGE.md) |
| See what is missing | [ROADMAP.md](https://github.com/xiao18825501901-rgb/dream-maker/blob/main/ROADMAP.md) |
| Point an answer engine at it | [llms.txt](https://github.com/xiao18825501901-rgb/dream-maker/blob/main/llms.txt) |

## Three things this project does that most do not

1. **It refuses to build from a single sentence.** A Seeker interviews you until the idea has
   acceptance criteria, then the result is frozen and hashed. Nothing builds before that.
2. **A distribution build cannot spend your money.** The price files are absent, and a runtime
   guard throws before the budget reservation is even attempted.
3. **Failure is always a name.** `ZERO_USAGE_DEPLOYMENT`, `NATIVE_PRICE_ROUTE_MISMATCH`,
   `PLANNING_RECONCILIATION_REQUIRED` — every refusal is a stable code you can search the source for.

## What it is not

- Not a hosted service. It binds to `127.0.0.1` and stores one SQLite file in its own folder.
- Not a wrapper around one provider. Six harness lanes, routed through a gateway you run.
- Not finished. `ROADMAP.md` lists the gaps, including no code-signing certificate yet — Windows
  will warn about an unknown publisher, and that warning is accurate.

## Good first things to post

- **A run that surprised you**, especially one where the Reviewer caught something the Executor believed.
- **An interview that dragged.** Ten questions is the stop point; if it felt like nine too many, say so.
- **A harness lane you actually ran**, with the model name. The lane matrix is locked by tests, so a
  recorded real dispatch is genuinely valuable evidence.

Please do not paste API keys, account identifiers, or personal paths. The `native-audit` check
refuses secrets in prompts, but a Discussion is not covered by that guard.
