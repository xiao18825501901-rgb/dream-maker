# Architecture

## Process model

One Node process per product, bound to loopback:

```
dream-maker.exe      -> app/dist/server/main.js            port 4317
dream-maker.exe df   -> app/dist/server/dreamflow-main.js  port 4318
```

Both ports scan forward (+1 to +29) when occupied. There is no mode that listens on a public
interface, and no multi-tenant mode.

## Layers

```
browser  <-- HTTP/SSE -->  src/server/http.ts        routes, auth, CSRF, idempotency
                                  |
                            src/server/engine.ts     the run state machine
                                  |
              +-------------------+-------------------+
              |                   |                   |
        interviews.ts        native-owner.ts     release/portable
        the Seeker           paid dispatch       packaging
              |                   |
        plan-contract        providers/*
        requirements         harness lanes
              |
        store.ts  --> SQLite (data/<product>/dream-maker.sqlite)
```

## The run state machine

Every engineering run moves through named states, and every transition is appended to the record
table before it is acted on. A crash therefore leaves a readable trail instead of a mystery.

```
CREATED -> PLANNING -> PLANNED -> IMPLEMENTING -> IMPLEMENTED
                                       |
                                  REVIEWING -> ACCEPTED
                                       |
                                  REPAIRING -> ...
```

Terminal states are ACCEPTED, BLOCKED, ABANDONED. ACCEPTED requires all of:

1. a frozen spec version whose hash matches the plan;
2. an Executor tree hash recorded in the checkpoint;
3. Prework handoff present and unexpired;
4. Reviewer verdict PASS.

Any missing item yields a named blocker. The UI shows the blocker, and the Seeker can then ask the
user a question bound to that specific blocker instead of guessing.

## Data model, in five tables

| Table | Holds |
|---|---|
| projects | the idea, the mode, the frozen planner binding |
| specs | versioned requirements with acceptance criteria, never mutated in place |
| runs | the state machine instance, attempts, calls used |
| events | append-only transition log |
| records | JSON payloads by kind: attempts, ledgers, approvals, leases |

Requirements are immutable by construction: changing one creates a new spec version and
invalidates anything that depended on the old one.

## Why the interview is separate from planning

Because that is where the money and the failure are. A model that starts planning from a vague
sentence produces a plausible plan for the wrong problem, and every later gate still passes.

The Seeker therefore cannot dispatch an engineering run. It can only:

- ask a question,
- record an answer as a versioned star,
- produce a requirements draft,
- and, on explicit confirmation, freeze it.

## Isolation

Every Executor runs inside a leased workspace with its own tree hash. The lease is recorded, so a
crashed run leaves an inspectable lease rather than an ambiguous "somewhere on disk" edit.

scripts/native-audit.mjs drives a hostile sandbox command set and asserts each one is refused.
