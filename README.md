<div align="center">

# Dream Maker

### It interviews you before it writes code.

Most AI builders start from one sentence and hope. Dream Maker starts from an interview,
freezes what you actually agreed to, and only then lets agents build — because the expensive
mistake is never bad code, it is confident code for the wrong problem.

<a href="https://github.com/xiao18825501901-rgb/dream-maker/releases/download/v0.1.0/DreamMakerSuite-Portable-0.1.0.zip"><img alt="Download" src="https://img.shields.io/badge/download-v0.1.0%20portable-2ea44f?style=for-the-badge"></a>
<a href="#quick-start"><img alt="Quick start" src="https://img.shields.io/badge/quick%20start-3%20commands-1f6feb?style=for-the-badge"></a>

[![CI](https://github.com/xiao18825501901-rgb/dream-maker/actions/workflows/ci.yml/badge.svg)](https://github.com/xiao18825501901-rgb/dream-maker/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.16-339933.svg)](https://nodejs.org)
[![Default spend](https://img.shields.io/badge/default%20spend-%240-brightgreen.svg)](docs/ZERO_USAGE.md)
[![Status](https://img.shields.io/badge/status-early%20build-yellow.svg)](ROADMAP.md)

</div>

---

## The one difference that matters

| | Coding agent | Dream Maker |
|---|---|---|
| Starts from | your sentence | an interview |
| Requirements | implied | **frozen, versioned, hashed** |
| Wrong problem | discovered when you use it | caught before code is written |
| Model spend | open-ended | **$0 by default, enforced twice** |
| Your data | their cloud | **one SQLite file on your disk** |

Everything else — six harness lanes, four roles, portable packaging — exists to serve that ordering.

## How a run actually goes

```
you type an idea
      |
      v
  Seeker  asks one decision at a time (4 options + your own words)
      |   each answer becomes a star you can reopen and edit
      |   the current question is a hollow star that opens an explanation window
      v
  Prompt Optimizer  shows you the requirements it heard, in your own terms
      |   you edit, then confirm
      v
  spec frozen and hashed  --------------- nothing may build before this point
      |
      v
  Planner   tasks, each bound to a requirement id
  Executor  builds inside a leased workspace
  Reviewer  checks the produced tree against the frozen spec
      |
      +--> PASS   : delivered, with a hash you can verify
      +--> gaps   : back to the Seeker, which asks about that exact blocker
```

## Six lanes, one router

Any engineering role can run on a different harness and a different model. Routing goes through
Magpie, a gateway you own and run locally.

| Harness | Wire | |
|---|---|---|
| `dsh` | anthropic-messages | DeepSeek Harness lane |
| `claude` | anthropic-messages | Claude Code lane |
| `codex` | openai-responses | Codex lane |
| `pi` | messages / responses | Pi Agent, both protocols |
| `opencode` | openai-responses | OpenCode lane |
| `cline` | openai-responses | Cline lane |

Prework — the handoff contract between roles — is preserved on every lane.

## Classic by default, Custom when you deviate

A new project is **Classic**: product roles, Prework, Laya on.
Change any role harness or model and it becomes **Custom**, and the badge tells you why:

```json
{"engine":"custom","origin":"USER_OVERRIDE","decision":{"reasons":[
  {"role":"executor","field":"harness","code":"HARNESS_DEVIATES_FROM_DEFAULT",
   "configured":"opencode","fallback":"dsh"}]}}
```

"Restore defaults" writes the three product defaults back and returns to Classic with zero deviations.

## Quick start

### Windows, no install

```powershell
.\dream-maker.exe            # Dream Maker   http://127.0.0.1:4317
.\dream-maker.exe df         # DreamFlow     http://127.0.0.1:4318
.\Verify-Portable.ps1        # every file checked against its hash
```

Data lives in `data/<product>/` beside the exe. No registry writes, no user-profile writes.

### From source

```bash
git clone https://github.com/xiao18825501901-rgb/dream-maker.git
cd dream-maker && npm ci && npm run build
npm start                      # Dream Maker
npm run start:dreamflow        # DreamFlow
```

Node 22.16+. The boot URL contains a single-use token — open it once.

### Offline interview (optional)

```bash
ollama pull qwen2.5:7b        # recommended candidate, 4.7 GB
ollama pull bge-m3            # embeddings
```

Then choose `local / qwen2.5:7b` as the Seeker. Hardware gates are enforced, not advisory:

| Model | Min total RAM | Min *available* RAM | Cores |
|---|---|---|---|
| `qwen2.5:7b` | 16 GiB | 8 GiB | 4 |
| `qwen2.5:3b` | 8 GiB | 4 GiB | 2 |

## Zero spend is not a setting

A build handed to someone who has not agreed to spend money must not be able to spend it.
Two independent layers:

1. the price and authority files are **absent** from a distribution build;
2. a runtime guard throws **before** the budget reservation is attempted.

```http
POST /api/projects/<id>/next   ->  409
{"error":"ZERO_USAGE_DEPLOYMENT",
 "message":"This package runs in zero-usage mode (DM_ZERO_USAGE=1): every paid model call is
            refused, no request is sent, no budget is reserved."}
```

Verify it yourself: after a refusal, `UsageLedger` in the SQLite file must still be empty.
That is the real proof. [Design notes](docs/ZERO_USAGE.md).

## Verify the download

```
SHA-256  ef3ac9dad2392d38cfd87f727fc77a52169018677c9363fa2ba72ca32f7132ad
bytes    37,391,862
files    457 (after unpacking)
```

```powershell
Get-FileHash .\DreamMakerSuite-Portable-0.1.0.zip -Algorithm SHA256
.\Verify-Portable.ps1     # must print PASS_CORE_PORTABLE_ONLY
```

The archive is unsigned; Windows will warn about an unknown publisher. That warning is
accurate, and `signing/README_CN.md` explains why shipping unsigned beats a self-signed
signature that only changes the warning into an error.

## What is honestly not done

This is an early build. The list is in [ROADMAP.md](ROADMAP.md), and it includes:

- **No code-signing certificate yet.** Windows will say "unknown publisher". A self-signed
  signature was tested and made the status *worse* (`NotSigned` -> `UnknownError`), so the
  build ships unsigned on purpose. The signing path is ready in [`signing/`](signing/README_CN.md).
- **Paid model dispatch is refused by design** in a distribution build.
- A 7B local model completes the interview but its plan draft does not yet satisfy the contract.
- No MSI installer, no SBOM, no uninstaller.

## Repository map

```
src/server/     controller: store, engine, interviews, providers, release
src/web/        workbench: shell, projection, stage strip
src/shared/     contracts used by both sides
prompts/        frozen role prompts, hashed and audited
migrations/     SQLite schema, applied on boot
adapters/       harness adapters
skills/         skill registry with provenance
contracts/      JSON schemas for handoff and prework
signing/        pre-signing baseline and the eSigner path
tests/          node:test suites
```

## Verify anything on this page

Every claim above is checkable without trusting me:

```bash
npm run build && npm test                    # the suite
node scripts/native-audit.mjs                # sandbox and secret isolation
.\Verify-Portable.ps1                       # the shipped bytes
node scripts/test.mjs tests/revamp/zero-usage.test.mjs   # the zero-spend guarantee
```

## Contributing

Issues and PRs welcome. [CONTRIBUTING.md](CONTRIBUTING.md) has one rule: a behaviour change
comes with a test that goes red without it. Security reports: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE).