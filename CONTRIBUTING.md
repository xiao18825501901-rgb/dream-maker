# Contributing

Thanks for looking. Two things make review fast here.

## 1. A behaviour change needs a test that fails without it

Not "a test exists", but "this test goes red if you revert the change". Open the PR with that
stated explicitly:

```
Test: tests/revamp/zero-usage.test.mjs
Revert the guard in providers/model.ts -> the second test fails with
"Missing expected exception" -> confirms the test covers the change.
```

## 2. A failure gets a name

Every user-visible failure is a stable upper-snake code plus a human sentence. No bare
"something went wrong". If you add a throw, add the code to the error table in the docs.

## Running things

```bash
npm ci
npm run build
npm test
node scripts/test.mjs tests/revamp/chat-stages.test.mjs   # single file, much faster
npm run doctor
```

## Style

- TypeScript, ESM, no default exports in server code.
- Comments explain why, not what. A comment that restates the code is deleted in review.
- Prefer the smallest change that solves the problem over new machinery.
- No new runtime dependency without a stated reason in the PR body.

## Commits

Imperative subject, body explains the failure being fixed. If it fixes a named error code, put the
code in the subject.

## Security

Please do not open a public issue for a security problem. See SECURITY.md.
