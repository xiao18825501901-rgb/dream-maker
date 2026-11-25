## What this changes

<!-- One paragraph. What behaviour is different after this PR? -->

## Why

<!-- The failure being fixed, or the need being met. Link the issue if there is one. -->

## The test that proves it

<!--
Required, and it must go red if the change is reverted. Paste the file and the assertion,
or the command and its output. "Tests pass" alone is not enough.
-->

```text
File: tests/...
Revert check: reverting <file> makes <test> fail with <message>.
```

## Checklist

- [ ] `npm run build` succeeds
- [ ] `npm test` was run (paste the totals)
- [ ] The change adds no new runtime dependency, or the description says why it must
- [ ] If a new user-visible failure was added, it has a stable UPPER_SNAKE code
- [ ] No credential, token, personal path or account identifier is in the diff

## Totals

```text
ℹ tests N   ℹ pass N   ℹ fail 0
```
