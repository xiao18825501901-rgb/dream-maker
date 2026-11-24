# Roadmap

This file exists so that "not done" is a stated fact rather than an implied one.

## Working today

- The workbench: collapsible sidebar, DM and DF switch, project list, per-project menu.
- Seeker interview with grill-me: one decision per turn, four options plus free text.
- Stars: each answered question becomes a star on the right rail; the current one is a hollow
  slot that opens an explanation window instead of answering for you.
- Requirements draft via the prompt optimizer, editable, then frozen on explicit confirmation.
- Frozen spec plus plan contract: every task bound to a requirement id, every requirement covered
  by an acceptance criterion. Omissions are rejected by name.
- Four roles, six harness lanes, per-role model and harness edit, classic and custom mode with a
  reason-coded badge and a working "restore defaults".
- Zero-usage guarantee, enforced twice.
- Portable Windows package with a hash manifest and a self-check script.

## Not done yet

| Area | State |
|---|---|
| Code signing | tooling and a pre-signing baseline are in the repo; the CA certificate is pending review |
| Paid capability end to end | blocked on a price route and a probe receipt, by design |
| Seven-harness grid | every lane is selectable and routed; not every lane has a recorded real dispatch |
| Strong local interview | a 7B model completes the interview; its plan draft does not yet satisfy the contract |
| Windows installer | portable works; MSI and uninstall are not built |
| SBOM and redistribution review | not produced |
| Browser acceptance at every breakpoint | partial |

## Design commitments

These are not features, they are promises that constrain the implementation:

1. A paid call never happens without a receipt.
2. A requirement never changes in place.
3. A failure is always a named code, never a shrug.
4. Nothing is written outside the package folder.
5. A claim of "done" comes with a hash.
