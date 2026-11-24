<div align="center">

# Dream Maker

**从一个想法，走向可以使用的作品。**

A local-first workbench that turns a vague idea into a frozen, testable specification,
then hands it to four role agents that plan, build, and review the result.

[![CI](https://github.com/xiao18825501901-rgb/dream-maker/actions/workflows/ci.yml/badge.svg)](https://github.com/xiao18825501901-rgb/dream-maker/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.16-339933)](https://nodejs.org)
[![Zero usage by default](https://img.shields.io/badge/default-zero--usage-brightgreen)](docs/ZERO_USAGE.md)

</div>

---

## Why this exists

Every "AI builds your app" tool has the same failure: it starts building before anyone agrees on
what "done" means. You get a demo, then discover the demo solved the wrong problem.

Dream Maker puts the hard part first. A **Seeker** interviews you until your vague idea becomes
explicit, testable requirements with acceptance criteria. Only then does a **Planner** design it,
an **Executor** build it, and a **Reviewer** check it against the requirements you actually confirmed.

If the Reviewer finds a gap, the result goes **back to the Seeker**, which asks you about the
specific blocker instead of guessing.

## What makes it different

| | Other tools | Dream Maker |
|---|---|---|
| Requirements | implied by a prompt | **interviewed, frozen, versioned, immutable** |
| Model spend | unlimited by default | **zero by default**, each paid call needs a verified receipt |
| Verification | "looks done" | must match the frozen spec hash + Prework handoff + Reviewer PASS |
| Harness lock-in | one provider | **six lanes**, freely routed through a local Magpie gateway |
| Your data | their cloud | **your disk**, SQLite in the package folder |

## The four roles

```
  you  -->  Seeker      interviews you, names the project, freezes the spec
              |
              v
           Planner     designs tasks, each bound to a requirement id
              |
              v
           Executor    builds inside a leased workspace
              |
              v
           Reviewer    checks the tree hash against the frozen spec
              |
         +----+----+
      PASS       findings
         |           |
      deliver        +--> back to Seeker: "here is the blocker, confirm the requirement"
```

Role names are stable; the wire ids (`planner1`, `planner2`) are kept so historical evidence stays valid.

## Six harness lanes, one router

The three engineering roles can each run on a different harness and a different model:

| Harness | Wire | Notes |
|---|---|---|
| `dsh` | anthropic-messages | DeepSeek Harness lane |
| `claude` | anthropic-messages | Claude Code lane |
| `codex` | openai-responses | Codex lane |
| `pi` | messages / responses | Pi Agent, both protocols |
| `opencode` | openai-responses | OpenCode lane |
| `cline` | openai-responses | Cline lane |

Cross-harness and cross-model routing goes through **Magpie**, a local gateway you own.
Prework (the handoff contract) is preserved on both lanes.

## Two modes, one switch

- **Classic** - the default. Native product roles, Prework, Laya on.
- **Custom** - the moment you change any role harness or model, the project leaves Classic.

The badge tells you which one you are in, and *why*:

```json
{"engine":"custom","origin":"USER_OVERRIDE","decision":{"reasons":[
  {"role":"executor","field":"harness","code":"HARNESS_DEVIATES_FROM_DEFAULT",
   "configured":"opencode","fallback":"dsh"}]}}
```

"Restore defaults" writes the three product defaults back and returns to Classic with zero deviations.

## Zero usage by default

**A copy of this software must not be able to spend your money by accident.**

Paid dispatch is refused before any network call or budget reservation:

```
POST /api/projects/<id>/next   ->  409
{"error":"ZERO_USAGE_DEPLOYMENT",
 "message":"This package runs in zero-usage mode (DM_ZERO_USAGE=1): every paid model call is
            refused, no request is sent, no budget is reserved."}
```

Two independent layers enforce it: the price and authority files are **not in the package**, and a
runtime guard sits **before** the budget guard. Loopback local models are unaffected.

Opting in is explicit: `DM_ZERO_USAGE=0` plus a completed account and probe flow.
See [docs/ZERO_USAGE.md](docs/ZERO_USAGE.md).

## Quick start

### Portable (Windows, no install)

```powershell
# unpack the release zip, then:
.\dream-maker.exe            # Dream Maker   http://127.0.0.1:4317
.\dream-maker.exe df         # DreamFlow     http://127.0.0.1:4318
.\Verify-Portable.ps1        # every file checked against its hash
```

Data lives in `data/<product>/` next to the exe. Nothing is written to the registry.


### Download

[**v0.1.0 portable build**](https://github.com/xiao18825501901-rgb/dream-maker/releases/download/v0.1.0/DreamMakerSuite-Portable-0.1.0.zip) - 35.7 MB, no installer.

SHA-256 of the zip:


7b4fc18e4ca01cc2a7c1c9a725a0657700ec1f0a450ee898c6a178f133f75306


After unpacking, run Verify-Portable.ps1 first. It checks every file in the folder against
RELEASE_MANIFEST.json and prints PASS_CORE_PORTABLE_ONLY when the bytes are intact.

Windows will warn that the publisher is unknown. Code signing is pending CA review; the build is
not signed yet and pretending otherwise would be worse than the warning.
### From source

```bash
git clone https://github.com/xiao18825501901-rgb/dream-maker.git
cd dream-maker
npm ci
npm run build
npm start                      # Dream Maker
npm run start:dreamflow        # DreamFlow
```

Requires **Node >= 22.16**. The boot URL contains a single-use token, so open it once.

### Optional local model

Interviewing works fully offline if you have Ollama:

```bash
ollama pull qwen2.5:7b        # the recommended candidate, 4.7 GB
ollama pull bge-m3            # embeddings
```

Then pick `local / qwen2.5:7b` as the Seeker. Hardware gates are enforced, not advisory:

| Model | Min total RAM | Min *available* RAM | Cores |
|---|---|---|---|
| `qwen2.5:7b` | 16 GiB | 8 GiB | 4 |
| `qwen2.5:3b` | 8 GiB | 4 GiB | 2 |

## Repository layout

```
src/server/       controller: store, engine, interviews, providers, release
src/web/          chat workbench: shell, projection, stage strip
src/shared/       contracts shared by both sides
prompts/          the frozen role prompts (hashed and audited)
migrations/       SQLite schema, applied on boot
adapters/         harness adapters
skills/           skill registry with provenance
contracts/        JSON schemas for handoff and prework
tests/            node:test suites
scripts/          build, test, audit, isolation helpers
```

## Testing

```bash
npm test                                                  # full suite
node scripts/test.mjs tests/revamp/chat-stages.test.mjs    # one file
npm run doctor                                            # environment diagnosis
node scripts/native-audit.mjs                             # sandbox and secret isolation audit
```

## Security posture

- **Loopback only.** The server binds `127.0.0.1`; there is no remote mode.
- **Single-use boot token.** The URL printed at startup can be consumed exactly once.
- **No secrets in the browser.** Keys are read from the server environment by name, never sent to the page.
- **Secrets are refused in prompts.** `SECRET_IN_PROMPT` and `MANAGED_DATA_SECRET_DENIED` block pasted credentials.
- **Managed data is metadata-only.** The store never records your project content as model context.
- **Audited isolation.** `scripts/native-audit.mjs` proves hostile sandbox commands are refused.

## Status

Early but honest. The workbench, the interview, the frozen spec, the review loop, and the
zero-usage guarantee all work and are tested. What is **not** done yet is listed in
[ROADMAP.md](ROADMAP.md) instead of being implied away.

## Contributing

Issues and PRs welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first. The one rule is
that a behaviour change comes with a test that fails without it.

## License

[MIT](LICENSE).