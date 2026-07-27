# Status layers

`arriero` reports the state of a model/instance at four scopes. They are
**not** four redundant enums — each is a projection of the same underlying
reality at a different scope, and one of them (`L4`) is a frozen external
contract. This document is the map: what each layer means, how they translate
into one another, and which differences are intentional so they are not
"unified away" by a later refactor.

## Two axes, not one ladder

Everything here decomposes into **two orthogonal axes**:

|  | Residency / lifecycle | Activity |
| --- | --- | --- |
| Nature | a ladder of states | counters |
| Question | "is it up? is the model in memory? can it serve?" | "how many requests is it doing right now?" |
| Values | not-running → process up → loading → ready / error / stale … | `activeRequests`, `queuedRequests` |
| Changes | seconds (load/unload is expensive) | per-request |

Folding activity **into** the residency ladder (a single `busy` state that
shadows `loaded`) was the original design mistake at the proxy layer — see the
history note below. Activity is always a separate count, never a residency
value. "Busy" is a derived view (`ready` **and** `activeRequests > 0`), not a
stored state.

## The four layers

| Layer | Type (`core`) | Scope | Produced by | Consumed for |
| --- | --- | --- | --- | --- |
| L1 | `Instance["status"]` | the OS child process | `process/supervisor.ts` (+ reconcile/stale) | lifecycle actions, run bookkeeping |
| L2 | `InstanceHealthSummary["status"]` | the instance's readiness to serve | `deriveStatus()` in `process/health-summary.ts` | UI health badge, action gating, feeds L3 |
| L3 | `ApiProxyModelState` | a proxy target in the runtime snapshot | `processRuntimeState`/`modelRuntimeState` in `proxy/runtime.ts` | scheduler decisions, feeds L4, admin dashboard |
| L4 | `ApiProxyPublicModelLoadState` | a public model in `GET /v1/models` | `proxy/model-status.ts` (aggregate over leaves) | **external API consumers** |

### L1 — process lifecycle

`stopped · starting · running · stopping · exited · stale · error`

The supervisor's view. Knows the OS process, **not** the model.
`starting → running` flips on the kernel `spawn` event (sub-second);
`running` means *the process is alive*, **not** that it can serve a request —
that is a different concept (see "intentional differences"). `exited` is a
clean requested stop, `error` an unexpected death; no consumer distinguishes
`exited` from `stopped`, it only carries run-history intent.

### L2 — instance health

`stopped · invalid · starting · stopping · loading · ready · degraded · stale · error`

`deriveStatus()` combines L1 + the `/health` probe + log/preflight signals into
"can this instance actually serve?". Adds health-only nuances with no analogue
elsewhere: `invalid` (blocking preflight — can't even start), `degraded`
(serving but with warnings: log errors, swap, NUMA skew), `stale` (a live
process this manager doesn't supervise). `starting` here is the same
sub-second blink as L1 (it requires `runtime.status === "starting"`); the real
"booting up" period — process up but `/health` not yet OK, whether the server
isn't listening yet or is answering `503` while loading weights — is reported
as `loading`. So in practice startup reads as `loading` throughout.

L2 has two cost modes for the same derivation: the dashboard computes it live
and full; the proxy request hot path reads a cheaper scheduling-mode variant
(no network start-preflight) from a background-reconciled cache. See
`docs/API_PROXY_FOUNDATION.md` → "Request hot path: scheduling vs diagnostics".

### L3 — proxy target state

`unknown · stopped · unloaded · loading · ready · error`

The proxy runtime snapshot's per-target residency. Spans **both** managed
instances (mapped from L2) **and** external API targets (which have no health
of their own — assumed `ready`). Distinctions the scheduler actually acts on:

- `stopped`/`unknown` → `start-instance` (process is down or unprobed)
- `unloaded` → `load-model` (router process is up, model not in memory) — this
  is why `unloaded` is **not** collapsed into `stopped`
- `loading` → `wait-model-ready`
- `ready` → routable (evictable if not busy)
- `error` → block the request

Activity is the separate `activeRequests` field on the same runtime record, not
a state. `isBusy` reads that count.

### L4 — public load state (FROZEN external contract)

`unloaded · loading · loaded · failed · partial · disabled`

Attached to every entry in `GET /v1/models`. This is **the external API** and is
modelled as an extended version of the **llama.cpp router** status set:

- `unloaded · loading · loaded · failed` come straight from llama.cpp and
  **must not be renamed** — clients and tooling depend on them.
- `partial` and `disabled` are ours. They have no analogue on L1–L3 **by
  nature**: `partial` only exists when a model fans out to ≥2 route leaves
  (a model-aggregation concept), and `disabled` is a model-config override
  (`enabled:false`). There is nothing to unify them with, and that is correct.

Plus the orthogonal activity counters `active_requests` / `queued_requests`.
See `docs/API_PROXY_FOUNDATION.md` for the wire shape.

## The boundary adapter

L4 is the only layer pinned to an external vocabulary. The translation from
internal L3 to public L4 lives in **`leafLoadFromTargetState` +
`aggregateApiProxyLoadState`** (`proxy/model-status.ts`):

```
L3 ready   → leaf loaded   ─┐
L3 loading → leaf loading   ├─ aggregate over a model's leaves → L4 value
L3 error   → leaf failed   ─┘   (+ partial for mixed ≥2 leaves, disabled override)
L3 else    → leaf unloaded
```

**This `ready → loaded` / `error → failed` rename is deliberate, not drift.**
Do **not** pull the llama.cpp vocabulary inward to "match" L4:

- L3 covers external-API targets where `loaded` is meaningless (there is no
  model to load) but `ready` is exact.
- A thin adapter at the public boundary is the right place for the external
  contract to live; leaking llama.cpp's dialect into the internal scheduler
  vocabulary would couple the engine to the wire format.

## Intentional cross-layer differences (do not "unify")

- **L1 `running` ≠ L2/L3 `ready`.** Process-alive is not serve-ready; the
  model may still be loading. Keep both words.
- **Internal `error` vs public `failed`.** Every internal layer uses `error`;
  only L4 says `failed` (the frozen llama.cpp term), via the adapter.
- **Internal `ready` vs public `loaded`.** Same: internal serve-readiness vs
  the frozen public term, via the adapter.
- **`partial` / `disabled` are L4-only** by nature (above).

After these, the internal layers are already consistent: L2 and L3 share
`ready` / `loading` / `error` / `stopped`. The only residual internal wart is
L2's `starting` blink, which could fold into `loading` (same argument as the L3
history note) — deliberately left alone as low-value.

## History

L3 `ApiProxyModelState` was originally a 9-value enum
(`unknown · stopped · starting · unloaded · loading · loaded · idle · busy ·
error`) that conflated the two axes: `busy` shadowed the residency value, and
the scheduler had to re-read `activeRequests` anyway. It was collapsed to the
6 values above — `idle`/`busy`/`loaded` → `ready` (activity is solely
`activeRequests`), `starting` → `loading`, and the never-produced `loaded`
removed. The value is runtime-derived and not persisted, so the change needed
no DB migration.
