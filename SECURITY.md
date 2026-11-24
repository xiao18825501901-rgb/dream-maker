# Security policy

## Scope

Dream Maker binds to 127.0.0.1 only. A report is in scope if it can be triggered by a local
process or a web page the user visits, for example:

- reading or writing files outside the package folder;
- reaching the controller API without a session cookie;
- leaking a credential into the page, a log, or a prompt;
- escaping a workspace lease;
- spending money in a zero-usage build.

Out of scope: anything requiring the attacker to already control the user account or the machine.

## Reporting

Open a private security advisory on the repository. Please include:

1. the exact error code you observed, if any;
2. the smallest reproduction you have;
3. whether a model call was made.

## What we already claim, and how it is checked

| Claim | Mechanism |
|---|---|
| loopback only | the server binds 127.0.0.1 and rejects a non-loopback Host header |
| single-use boot token | the token is consumed on first session exchange |
| no secrets in the page | keys are referenced by environment variable name, never serialised |
| secrets refused in prompts | SECRET_IN_PROMPT and MANAGED_DATA_SECRET_DENIED |
| zero spend by default | files absent plus a guard before the budget reservation |
| sandbox refusals | scripts/native-audit.mjs drives hostile commands and asserts refusal |

## Disclosure

We will confirm receipt within a week and aim to ship a fix or a documented mitigation for
confirmed reports before any public write-up.
