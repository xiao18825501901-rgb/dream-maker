# Frequently asked questions

## Is it free?

The software is MIT licensed and free. Model usage is separate: by default Dream Maker refuses
paid model calls entirely, so a fresh install costs nothing. Local models through Ollama are free
and fully supported for the interview stage.

## Does it send my data anywhere?

Not by default. The server binds to 127.0.0.1, the database is a file in the application folder,
and no telemetry is collected. A model call only happens if you explicitly configure a provider
and, for a paid one, complete the account and probe flow.

## Which operating systems?

Windows is the packaged target today (a portable folder plus a single exe launcher). The server
and web layers are plain Node and run on macOS and Linux from source.

## Do I need an API key?

No. The interview works with a local Ollama model (qwen2.5:7b is the recommended candidate). An
API key is only needed if you want a cloud model to do the interviewing or the engineering.

## How is this different from just prompting a coding agent?

A coding agent starts from your sentence. Dream Maker refuses to start from your sentence: it
interviews you first, freezes the result as versioned requirements with acceptance criteria, and
verifies the output against that frozen version. The difference shows up when the first
implementation is subtly wrong, which is the normal case.

## What are the four roles?

Seeker (interviews and freezes requirements), Planner (designs tasks bound to requirements),
Executor (builds in a leased workspace), Reviewer (checks the result against the frozen spec and
returns findings to the Seeker). Historical wire ids planner1 and planner2 are kept so old
evidence stays valid.

## What is a harness lane?

The runtime that actually performs a role turn. Six are supported: dsh, claude, codex, pi,
opencode, cline. Each role can use a different lane and a different model, and traffic is routed
through a local Magpie gateway so lanes can be swapped without rewriting prompts.

## Can it spend my money by accident?

No. Two independent mechanisms prevent it: the price and authority files are absent from a
distribution build, and a runtime guard throws ZERO_USAGE_DEPLOYMENT before the budget
reservation is even attempted.

## Is it production ready?

No. ROADMAP.md lists exactly what works and what does not. Code signing is pending CA review,
the Windows installer is not built, and a 7B local model completes the interview but does not yet
produce a plan draft that satisfies the contract.
