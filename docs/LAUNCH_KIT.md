# Launch kit

Copy-paste ready. Each variant is tuned to one channel; do not reuse one text everywhere,
the audiences overlap and repetitive wording gets filtered.

## 1. Hacker News (Show HN)

**Title** (<= 80 chars, no hype):

    Show HN: Dream Maker - interviews you before it writes code

**Body** (plain text, no marketing voice, first person):

    I kept running into the same failure with coding agents: I describe what I want, it builds
    something plausible, I use it, and then discover it solved a slightly different problem. The
    demo always looks fine. The problem is at the start, not the end.

    So I built the opposite order. You describe the idea. A role I call the Seeker interviews you
    one decision at a time until the idea becomes explicit requirements with acceptance criteria.
    You confirm them, and they get frozen and hashed. Only then does anything get planned or built.

    Three engineering roles follow: Planner (tasks bound to requirement ids), Executor (builds in a
    leased workspace), Reviewer (checks the produced tree against the frozen spec). If the reviewer
    finds a gap, it goes back to the Seeker, which asks you about that specific blocker instead of
    guessing.

    Two things I care about more than features:

    1. Paid model calls are refused by default. Distribution builds do not contain the price or
       authority files, and a runtime guard sits before the budget reservation. If it cannot
       justify the spend it throws a named error instead of quietly calling a model.
    2. It runs on 127.0.0.1 and stores one SQLite file in the app folder. No cloud mode exists.

    It is early. The interview, the frozen spec, the review loop and the zero-usage guarantee work
    and are tested. The roadmap lists what does not work yet: code signing is pending CA review,
    no MSI installer, and a 7B local model finishes the interview but its plan draft does not yet
    satisfy the contract.

    TypeScript, MIT, Windows portable build plus source for macOS/Linux.

    https://github.com/xiao18825501901-rgb/dream-maker

    Happy to answer anything about the requirement-freezing mechanism or the review loop.

## 2. Reddit r/programming or r/SideProject

**Title:**

    I built a coding agent that refuses to write code until it has interviewed you

**Body:**

    The failure mode I wanted to kill: agent builds the wrong thing convincingly.

    Dream Maker inverts the order. Seeker interviews you (one decision per turn, four options plus
    free text) until your idea becomes explicit requirements with acceptance criteria. You confirm,
    they get frozen and hashed, and only then do Planner / Executor / Reviewer run.

    The part I am least sure about: each answered question becomes a "star" on the right rail. You
    can reopen any past answer and edit it, but if a build is running, editing is server-side
    locked. I think that is right, but it is the kind of thing that only real use will settle.

    Also: zero spend by default, two layers, on purpose. Distribution builds are missing the price
    files, and a guard throws before the budget reservation. Making an open-source tool that cannot
    cost the downloader money felt non-negotiable.

    MIT, TypeScript, Windows package or run from source. Roadmap is honest about what is missing.

## 3. X / Twitter thread

    1/ Coding agents fail at the start, not the end.
       They build something plausible from one sentence, and you find out later it is the wrong
       something. Every later check passes, because the check was written after the mistake.

    2/ Dream Maker flips the order.
       A Seeker interviews you until your idea becomes explicit requirements with acceptance
       criteria. You confirm. They freeze, hashed. THEN Planner / Executor / Reviewer run.

    3/ The Reviewer verifies against the frozen spec, not against a fresh reading of your prompt.
       If it finds a gap, it goes back to the Seeker, which asks you about that exact blocker.

    4/ Two rules I would not compromise:
       - paid model calls refused by default (files absent + guard before reservation)
       - 127.0.0.1 only, SQLite in the app folder, no cloud mode

    5/ Early, MIT, TypeScript. Windows package or from source.
       Roadmap says what is broken. That felt more useful than a feature list.
       github.com/xiao18825501901-rgb/dream-maker

## 4. One-line descriptions by length

| Length | Text |
|---|---|
| 8 words | Interviews you before it writes any code |
| 15 words | A local workbench that freezes your requirements before four agents plan, build and review |
| 25 words | Dream Maker interviews you until your idea becomes frozen testable requirements, then has Seeker, Planner, Executor and Reviewer take it to a verified result |
| 40 words | Most AI coding tools start from one sentence and hope. Dream Maker interviews you until the idea becomes versioned requirements with acceptance criteria, freezes them, then runs four role agents against that frozen spec. Local only, zero spend by default, MIT |

## 5. What NOT to say

- Do not call it "production ready". It is not.
- Do not say "free AI" - no credits are included.
- Do not say "replaces developers". The Reviewer gate exists precisely because it does not.
- Do not compare by benchmark numbers. There are none, and inventing them would poison the
  honesty the project is built on.
