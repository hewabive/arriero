# Resource management

`arriero` schedules models onto scarce hardware. Resources split into **two
orthogonal axes** — conflating them was the original design mistake (the old
`resourceGroupId` treated "won't fit together" and "only one at a time" as the
same thing).

|  | Memory axis (residency) | Compute axis (contention) |
| --- | --- | --- |
| Nature | quantitative capacity | competition for time among already-resident models |
| Question | "does it fit? who do we evict?" | "who computes now, who waits?" |
| Levers | start/stop/load/unload + slot save/restore | hold back dispatch / abort+retry |
| Timescale | seconds (load/unload is expensive) | per-request (cheap) |
| Owner | the manager (proxy is one consumer) | the proxy |

The memory axis is a manager-level concern so it also guards **manual** instance
starts, not only proxy-driven autostart. The compute axis is purely a proxy
request-ordering concern.

## Memory model

### Pools

A **memory pool** is a quantity of bytes with a capacity and a reservation. v1
populates one pool per detected GPU (VRAM) plus a single aggregate `host` pool
(RAM). `budget = capacityBytes - reservedBytes`; `reservedBytes` is the operator's
carve-out for the OS, games, and headroom.

Pools live in file-backed config `data/config/resources.json`
(`apps/api/src/resources/repository.ts`, in-memory cache + atomic write-through).
They are **not** seeded from repo-root `config/*.json` because capacities are
machine-specific (same rule as `path-catalog`). On first run
`ensureResourcePoolsScaffold()` generates defaults from `system/resources.ts`
(NVIDIA NVML + `/proc/meminfo`); `refreshAutoCapacities()` re-syncs capacity for
pools with `autoCapacity` on every startup and shows drift otherwise. A GPU
detected after the initial scaffold is added to `resources.json` immediately,
so instances can reference it without leaving portable configuration dangling;
capacity-only refreshes remain in memory to avoid routine Git churn.

A gpu pool whose `deviceRef` no longer matches a detected device keeps its
last-known capacity and is surfaced with a derived `orphaned` flag
(`listMemoryPoolsWithStatus`). The flag is computed at the API read boundary,
never persisted, and set only when NVML reports the device list authoritatively
(`ready`/`no-devices` states) — a driver failure must not mark live pools
orphaned. Orphaned pools deliberately keep participating in the ledger
unchanged; the flag is informational. `DELETE /api/resources/pools/:id` (and
the Delete button on `#/resources`) removes a pool only when it is orphaned and
no instance declares a draw on it — pools for present hardware are re-created
by `refreshAutoCapacities()` on the next startup, so deleting them is refused
rather than silently undone.

The API loads `libnvidia-ml.so.1` through Koffi and keeps one NVML session for
the lifetime of the process. Static device identity is read once, live GPU
metrics are cached for three seconds, and per-process VRAM is cached separately
for two seconds. `nvidia-smi` is not spawned or required.

### Draws

An instance declares its footprint as a list of draws (`InstanceMemoryDraw`:
`{ poolId, bytes }`) on its config record. Multi-pool draws are first-class so
tensor-split (`{gpu0, gpu1}`) and partial offload (`{gpu0, host}`) model cleanly.
An empty `memory` means "footprint not declared" — such an instance is not counted
against any budget and capacity checks are skipped for it. Auto-derivation from
launch args / observed `InstanceMemoryLayout` is a later step; today declarations
are hand-authored (assisted by the suggested sizes the UI can surface).

### Ledger

The capacity math is a pure, side-effect-free pair in `@arriero/core`
(`buildResourceLedger`, `checkDrawAdmission`) so the manager (preflight) and the
proxy (eviction planning) share one definition. `apps/api/src/resources/ledger.ts`
wraps them over the live set of running instances (`starting`/`running` = resident).

## Compute model

A **compute domain** is a set of execution units that contend. Domains are **not**
a separate config entity: a managed target resolves to an instance, and **every
memory pool it draws from is a compute domain** — a GPU VRAM pool is that GPU's
compute, the `host` pool is CPU compute. A split instance (gpu + host draws)
occupies several domains at once and is arbitrated on each.

CPU contention is arbitrated exactly like GPU contention (the per-domain priority
queue below). The v1 simplification (the draw model does not yet parse
`--n-gpu-layers`): an instance is assumed to compute on every pool it declares a
draw on, so a fully GPU-offloaded instance should declare only its VRAM draw —
declaring host overhead would take a (mostly harmless) CPU lease. Precise
CPU-vs-GPU compute attribution arrives with draw auto-derivation from launch args.

## Mandate & occupancy

The proxy shares the machine but only moves what it has a mandate over. It must
_see_ the full pool occupancy (the ledger sum of every resident instance's
declared draw) yet may only _evict_ a subset. Occupancy splits into three tiers:

- **Immovable** — a resident instance with no proxy target (router preset,
  manually started, or a non-arriero process). Counts against the budget;
  the proxy never unloads it. If it blocks a request, the proxy waits.
- **Protected** — a proxy target with `preemptible:false`. The proxy may start
  and route to it, but never evicts it for another request. Counts; also a
  reason to wait.
- **Preemptible** — a proxy target with `preemptible:true` and lower priority
  than the requester. The only tier the proxy moves (unload + slot save/restore),
  in priority order.

"Given to manage" = a proxy target exists for the instance. Target
`preemptible` is an upper bound: the persisted instance policy can reduce it to
`never`, or to `idle-only` while active requests are present. The same ledger numbers feed both the manager's
passive manual-start admission (warn/block, moves nothing) and the proxy's active
planning (evict the preemptible tier).

Truly-external usage (a game, a foreign process — not a arriero instance)
never enters the ledger; the static `reservedBytes` is the only buffer against it
in v1 (live NVML subtraction is a v2 concern). When a request cannot fit
and the obstacle is immovable/protected, it queues and waits rather than 503-ing;
the wait is bounded only by the request's own timeout/abort.

## How the axes drive the proxy

- **Memory (scheduler):** the scheduler does quantitative fit
  (`apps/api/src/proxy/scheduler.ts`, `planMemoryEvictions`). If a target's declared
  draw fits the per-pool headroom (`budget − usedByOthers − kept residents`), just
  start/load. If not, greedily evict residents of the contended pools — **idle**
  ones first (`preemptible`, priority ≤ requester), then, when `allowBusyEviction`
  is set, **busy** ones (`preemptible`, priority < requester, surfaced as
  `preemptTargetIds`) — until it fits, else the request queues (`ok:false`). The
  fit pass is **inert until draws are declared** (empty `memory` ⇒ skipped).
- **Compute (coordinator):** the `ComputeDomainCoordinator` is keyed on the
  compute domains a request draws from (gpu **and** host pools). A new request of
  priority `P` waits while any in-flight request of priority `> P` runs on a shared
  domain; equal priorities run concurrently (the GPU or CPU time-slices). In-flight
  lower-priority requests are **not** interrupted for the compute axis — only new
  dispatch is held. The `decide()` policy (`proxy/domain-admission.ts`) folds this
  hold together with the memory plan, so a single admission either admits
  concurrently, preempts a busy preemptible lower-priority holder (abort → slot save
  → swap → resume), or queues.

Bare concurrency was always available — two resident `llama-server` processes
time-slice on the device, and a request whose instance declares **no** memory
draws takes no lease (`requestComputeDomains` returns none), so such requests
dispatch in parallel. What Phase 3 added is **arbitration**: the multi-holder,
individually-preemptible, priority-gated domain gate that lets fitting models
coexist, holds low priority behind high, and preempts a busy resident to reclaim
memory — uniformly across GPU and CPU domains.

## Contention hardening (GPU context-switch thrash)

Symptom (real): three instances share one GPU that fits two; a client needs models
B and C concurrently while A sits idle. A naive per-request greedy plan evicted B
(still needed) to load C, then failed to reload B with `target_not_ready`. Four
layers — each a separate seam — fix it; `proxy/contention.test.ts` drives the whole
scheduler + coordinator + swap-lock stack on this scenario.

1. **Demand-aware eviction (scheduler).** `ApiProxySchedulerPlanRequest.protectedTargetIds`
   = the coordinator's `wantedTargetIds()` (holders ∪ waiters), populated once in
   `buildApiProxyPlanRequest`. `planMemoryEvictions` sorts victims **unprotected-first**
   (leading key), so a model with an in-flight or queued request is never evicted while
   an unwanted idle peer exists; it falls back to a wanted peer only when every
   candidate is wanted (graceful, no deadlock under saturation).
2. **Exclusive swap per domain (executor).** `domain-swap-coordinator.ts` serializes
   swaps on a compute domain: `executeApiProxyTargetReadiness` takes the per-domain
   lock and **re-previews fresh state under it** before mutating, so two executors
   never overlap a load/unload (no transient over-subscription, no stale plan) and the
   re-preview re-reads the wanted-set (a swap won't evict a target that just became
   in-flight). Resident-model requests (no readiness actions) skip the lock and stay
   parallel — the fast path adds no latency.
3. **Queue, don't 503 (executor).** A plan blocked at execution time is almost always
   transient (a peer mid-preemption, a sibling swap holding the lock): the executor
   waits and re-previews (`public-executor.ts:waitForPlanUnblock`, decoupled from the
   pass counter, abortable via the client signal) and returns `plan_blocked` only on a
   genuine timeout or client abort — so "evict A, then reload B in its place" happens
   transparently instead of erroring.
4. **Affinity batching + engine concurrency cap (coordinator).** `scheduleAdmission` admits
   resident (affine — target already a holder on an overlapping domain) waiters ahead
   of swap-needing waiters at equal priority, draining a model's queue before paying a
   swap; a fairness window (`swapFairnessMs`, default 2 s) lifts the preference once a
   swap waiter has starved. `decide()` caps concurrent same-target holders at the
   descriptor-selected concurrency argument (`--parallel`/`-np`, vLLM
   `--max-num-seqs`, or SGLang `--max-running-requests`), so excess queues in
   the proxy (priority-ordered, observable) instead of blindly inside the engine.

**Observability.** Each request trace carries `displacedTargetIds` — the targets it
unloaded/stopped to fit (idle eviction or busy preemption) — beside `schedulerActions`
and `queueMs`, surfaced in the Stats traces tooltip, so a failed battle is diagnosable
(which request displaced which model, and whether it queued). Captured from the
admission plan, so it reflects the *planned* displacement.

**Deferred (await a real signal, not intuition):**
- The gateway 503s pre-lease on a blocked initial preview (`gateway.ts`), computed
  without `allowBusyEviction`; a busy-saturation request the coordinator *could* resolve
  by preemption never reaches the queue. Idle eviction (the symptom above) passes the
  gate, so this only bites when every resident is busy.
- True time-slicing across N>capacity hot models: the affinity-fairness ordering exists,
  but a starved swap waiter still can't evict a wanted resident (layer 1 protects it),
  so genuine over-subscription does not round-robin yet.

## How it was built (and what the seams are)

Every phase below has landed; the sequence is recorded because the seams it
created are the ones a change has to respect.

- **Core schemas + pure ledger.** `MemoryPool`, `InstanceMemoryDraw`,
  `buildResourceLedger`/`checkDrawAdmission` in `@arriero/core`, the `resources`
  domain and the `config/resources.json` scaffold/refresh. `instance.memory` is
  threaded through the repository with poolId reference validation.
- **Manual-start admission.** `POST /api/instances/:id/start` takes `{ force }`
  and runs the ledger; over-budget returns a confirmable `409` carrying the
  `ResourceAdmission` shortfall, and the UI offers Start-anyway/Cancel. Proxy
  autostart bypasses this gate — it is planned by the scheduler instead. A
  capacity `warning` surfaces in the preflight endpoints (form preview). Bulk
  start is still ungated.
- **Scheduler memory axis.** The scheduler snapshot carries per-target `draws`
  and per-pool `{budgetBytes, usedByOthersBytes}`
  (`resources/ledger.ts:computeSchedulerPoolInputs`,
  `proxy/resource-domains.ts`), where `usedByOthers` is exactly the residents the
  proxy does not manage. `planMemoryEvictions` does quantitative fit plus greedy
  idle eviction, inert until draws are declared.
- **Coordinator redesign + compute QoS.** `requestComputeDomains` derives the
  per-request lease keys; `ComputeDomainCoordinator`
  (`proxy/domain-coordinator.ts`) is a multi-holder, multi-domain,
  individually-preemptible gate whose admission policy is an injected `decide()`
  (admit | preempt[leaseIds] | wait). The scheduler proposes busy-resident
  eviction (`preemptTargetIds`, gated by `allowBusyEviction`) and
  `buildDomainAdmissionDecider` (`proxy/domain-admission.ts`) is the
  scheduler-backed `decide`: a compute-QoS hold behind a strictly
  higher-priority running holder, then a live holder overlay (running ⇒ busy,
  suspended ⇒ freed) plus a pure re-plan to decide fit and which busy holders to
  preempt. The live path — `protocol-endpoint`, `fusion`, idle maintenance, the
  runtime snapshot — runs through the coordinator; no gpu draws ⇒ no domain ⇒ no
  lease, preserving unmanaged concurrency.
- **Dropped along the way:** the target `resourceGroupId` and the legacy
  `ResourceGroupCoordinator`. Zod strips the field from stored configs on read.

## Future axes

NUMA / dual-socket: **manual pinning has landed** — an instance can bind to one
NUMA node, enforced via a cgroup v2 cpuset sibling slice (`docs/NUMA_PINNING.md`).
Topology and GPU→node affinity are exposed through `SystemResources`. Still
deferred: VRAM pools are unaffected; the `host` pool splits into per-node pools,
each becoming its own compute domain **automatically** — a domain is just the
poolId a draw touches, so no coordinator rework is needed. Per-node host budgets
are only meaningful with pinning (now present), but admission still treats `host`
as one pool, so over-subscribing a node's RAM is on the operator until the split
lands. Auto-deriving a binding from a GPU's PCIe-local node is also a later phase.
