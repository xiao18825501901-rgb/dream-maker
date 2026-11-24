# Zero-usage deployment

Dream Maker ships with paid model dispatch refused by default. A copy of the software that lands
on someone elses machine must not be able to spend money, even if an API key happens to be present
in their environment.

## Two independent layers

### Layer 1: the files are not there

A build produced for distribution does not contain:

```
app/config/native-owner.local.json    operator authority
app/.runtime/native/prices/*.json     price quotes per provider and model
app/.runtime/native/authority.json    spend authority
```

Without a price quote a paid turn cannot be reserved at all, so it cannot be dispatched.

### Layer 2: the runtime guard

```ts
// src/server/zero-usage.ts
export function assertPaidDispatchAllowed(local: boolean): void {
    if (local) return;                       // loopback runtime is unaffected
    if (zeroUsageEnabled())
        throw new DomainError("ZERO_USAGE_DEPLOYMENT", 409, ...);
}
```

It is called in two places, both before any reservation or network call:

| File | Position |
|---|---|
| src/server/providers/model.ts | immediately before this.paidGuard |
| src/server/providers/dsh.ts | before the dm/run gateway branch |

## How the switch is set

The Windows launcher injects it when nothing else is set:

```go
envs := os.Environ()
if os.Getenv("DM_ZERO_USAGE") == "" {
    envs = append(envs, "DM_ZERO_USAGE=1")
}
```

Accepted values are exactly 1 and true. Everything else is off:

| Value | Enabled |
|---|---|
| 1 | yes |
| true | yes |
| 0 | no |
| empty | no |
| yes | no |
| TRUE (trailing space) | no |
| 2 | no |

## What a refusal looks like

```http
POST /api/projects/<id>/next   ->  409
{"error":"ZERO_USAGE_DEPLOYMENT",
 "message":"This package runs in zero-usage mode (DM_ZERO_USAGE=1): every paid model call is
            refused, no request is sent, no budget is reserved."}
```

The response states all three facts on purpose: refused, no request sent, no budget reserved.

## How to verify it yourself

1. Start from a clean package folder.
2. Create a project and switch the Seeker to a paid provider.
3. Send a turn.
4. You should see 409 ZERO_USAGE_DEPLOYMENT.
5. Inspect data/dream-maker/dream-maker.sqlite and run:
```sql
SELECT COUNT(*) FROM records WHERE kind = 'UsageLedger';
```

Step 5 is the real proof. A refusal that still wrote a ledger row would mean money moved.

## Turning paid capability on

Do all of this deliberately:

1. Set DM_ZERO_USAGE=0 in the environment.
2. Place a signed price quote and spend authority under app/.runtime/native/.
3. Register an account source and complete the probe flow.
4. Only then does POST /next reach a provider.

If step 2 or 3 is missing you get a named error (NATIVE_PRICE_ROUTE_MISMATCH or
PROBE_EVIDENCE_UNVERIFIED), never a silent fallback to a cheaper or free path.
