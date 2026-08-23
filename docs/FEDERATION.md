# Federation (multi-machine control plane)

`arriero` started as a **local single-user control plane**. Federation
extends it to a **single-operator, multi-host** control plane: you point your
browser at one node and from that one address you observe and manage instances,
models, builds and resources across every machine on your network, with the proxy
routing to remote instances as if they were native.

This is the foundation; **distributed RPC inference rides on top of it later**
(see `docs/NUMA_PINNING.md` neighbours and the RPC build support already shipped:
`GGML_RPC` + the `rpc-server` binary). RPC's hard parts — remote process
lifecycle, remote hardware detection, machine-scoped pools — *are* the federation
problem, so we solve federation first and treat an `rpc-server` worker as just a
remote instance in a later phase.

## Why federation-first is also lower-risk

The scary part of any distributed scheduler is **cross-machine lease atomicity**:
a single request needing memory on two machines at once. That situation **only
arises with RPC** (one model sharded across hosts). Without RPC, **no request ever
crosses a machine boundary** — it is served by one instance on one host.

Consequences that shape the whole design:

- Each node stays **authoritative over its own** processes, resources and compute
  lease — exactly the local logic that exists today (supervisor, scheduler,
  domain-coordinator). Nothing reaches across a machine to spawn or evict.
- The node you connect to is a **thin coordinator** over its peers' **existing
  HTTP APIs**. No new agent, no SSH, no bespoke cluster protocol.

## Core principle: aggregate reads, route writes

> Aggregate **reads** broadly. Route **writes** to the owning node.

The reason is physical: an editable artifact lives on **one node's disk** —
`config/instances/<name>.json`, GGUF files, the llama.cpp checkout, the
machine-specific `path-catalog`, that node's `resources.json`. Editing an instance
on node B needs node B's path catalog, model list, NUMA nodes and pools. An
aggregated "all instances of the network" *editing* grid would have to juggle N
local contexts at once — high complexity, negative value.

Derived facts (free VRAM across the fleet, what is running where, proxy traffic)
are the opposite: valuable in aggregate and cheap to fan out read-only.

This is CQRS-shaped: an **aggregated read model** + a **node-routed write model**.

## Node model

- A new file-backed config `config/nodes.json` lists peers:
  `{ id, name, baseUrl, enabled }`. Bearer tokens live in `.secrets.json`
  (`node:<id>`), never in `nodes.json` — same rule as endpoint/source secrets.
- The local machine is the implicit **self** node.
- **Topology is symmetric**: every node has its own `nodes.json`; the node whose
  address you open is the de-facto primary for that session. There is no
  hardcoded primary in code.
- **State is live read-through** in v1: the entry node queries peers on demand and
  merges. No replication or cache (resilience/caching is a later concern).

### Transport: reverse-proxy by node prefix

The entry node is an **authenticating reverse-proxy** to its peers:

```
/api/nodes/<id>/*   →   <peer.baseUrl>/api/*    (Authorization: Bearer <peer token>)
```

So the browser **only ever talks to one address** (the operator's goal). No CORS,
no token distribution to the UI, one auth surface. The web client's typed fetch
layer (`apps/web/src/api/client.ts`) gains a node-prefix injector; node-scoped
pages simply set that prefix from the **global node switcher**.

The switcher is therefore, mechanically, *"which `/api/nodes/<id>` prefix do
node-scoped calls use"*. Passthrough pages need almost no logic change.

`self` resolves to the local `/api/*` directly (no hop).

## Page classes

Each page is exactly one of four classes. The UX contract the operator keeps in
their head is a per-page badge: **`Node: B`** (switchable) or **`Network`**
(aggregated).

| Page | Class | Behaviour |
| --- | --- | --- |
| Instances (edit), Model files, Build, Presets, Path catalog | **Node** | Global switcher → transmits the selected node, exactly one node at a time |
| System (this machine's CPU/RAM/NUMA) | **Node** | Switcher (optional network overview later) |
| Resources | **Dual** | Aggregated namespaced read (`nodeB:gpu0`) + node-scoped pool edit |
| Public Status, Proxy stats / dashboard | **Network** | Aggregated, read-only |
| Proxy config (targets / pipelines / models / endpoints / sources) | **Fleet** | Single fleet proxy on the entry node; **not** governed by the switcher |

Rules that fall out of this and are easy to get wrong:

1. **Node-scoped pages stay single-node.** No "All nodes" option on an editing
   page — that re-introduces the multi-context problem. Anything network-wide goes
   on a dedicated Network page.
2. **Cross-node references still need aggregated reads.** A proxy target editor
   (fleet-level) must *pick* an instance from any node, even though instance
   *editing* is per-node. So a fleet-wide instance **list** (read) is required —
   aggregated reads feed pickers, not just dashboards. Aggregated **writes** are
   what we avoid.
3. **Resources is dual on purpose.** Network picture = aggregated, node-namespaced.
   Editing a pool's capacity/reservation = a write to that node's
   `resources.json`, hence node-scoped. Don't force it into one bucket.
4. **Offline peer** in the switcher: shown, marked unreachable, authoring disabled.

## The proxy is a single fleet proxy

The fleet has **one** proxy — the entry node's — whose targets may reference
instances on any node. "Works everywhere as native" means cross-node targets, not
one proxy per node. The Proxy section therefore ignores the node switcher (it is
fleet state, not node state).

When the gateway selects a remote target, the request is **delegated to the owning
node's proxy with the target pinned**: that node runs its own start / lease /
preempt / forward locally (today's logic, unchanged), and the entry node forwards
the HTTP. This keeps each node authoritative over its own compute lease and
sidesteps distributed-lease atomicity entirely — which is exactly why it is safe
to do before RPC exists.

The delegating fetch (`proxy/delegate.ts`) uses the same long-timeout undici agent
as the local forwarder (`proxyUpstreamFetch`, 1h headers+body) rather than Node's
silent 300s default. This is required, not just generous: the owning node runs
readiness **and** generation behind a single response, and for a **non-stream**
request it rebuilds the buffered reply, so the entry's time-to-headers is
`readiness + full generation` — a short headers timeout would clip a legitimate
slow completion. A genuinely unreachable node still fails fast at connect
(`ECONNREFUSED` / ~10s connect timeout). `delegationErrorDiagnostic`
(`proxy/protocol-endpoint.ts`) classifies the fetch failure: timeout → `504
upstream_timeout`, connect/DNS/reset → `503 upstream_unavailable`, else `502
upstream_error` — instead of an opaque "fetch failed".

### Remote-target load status

The proxy runtime snapshot derives an honest load state for remote targets:
`proxy/remote-health.ts` fetches each owning node's `instances/:id/health-summary`
(deduped by `(nodeId, instanceId)`, ~3s TTL cache + negative cache, parallel, 5s
timeout, graceful) and feeds it through the same `deriveApiProxyTargetRuntime` path
as local targets (`proxy/runtime.ts:remoteDerivedState`). A remote node that is
unreachable reports `unknown` (not `loaded`); a disabled node reports the resolution
error. One deliberate divergence from the local path: the `error → canStart?stopped`
downgrade in `processRuntimeState` is a **local autostart affordance** (the entry
never starts a remote instance — it delegates), so for remote a health `error`/
`invalid` surfaces as `error` with the node's reason (incl. log tail), instead of
being masked as `stopped`. The output `instanceId` stays `null` for remote targets
to avoid colliding with a same-named local instance in downstream local lookups
(e.g. idle-maintenance draws).

### Remote-request telemetry depth

The proxy extracts **rich live telemetry from native managed instances** —
prefill %, TTFT, thinking, the in-flight registry — by injecting llama.cpp's
`return_progress` and metering the stream (`proxy/usage-meter.ts`,
`resumable-forward.ts`; see `docs/API_PROXY_FOUNDATION.md`). For OpenAI-protocol
delegated streams most of that survives the serve hop unchanged, but the
anthropic bridge on the owning node deliberately keeps `prompt_progress`/
`timings` out of the client stream (they are its host-only `extensions`
side-channel), and slot id / cache origin / lease queue / scheduler actions never
leave the owning node's process at all. Two read-side mechanisms close the gap
without touching the stream wire format:

- **Post-hoc trace merge** (`proxy/delegated-trace.ts`): the owning node stamps
  `x-arriero-trace-id` on `/api/proxy/serve` responses; when the delegated
  response completes, the entry fetches that trace from the peer
  (`GET /api/proxy/traces/:id`, retrying while the peer's deferred slot-timing
  record settles) and merges the owning-node-only fields — slot id, cache
  origin, queue time, scheduler actions, translation flags, server-measured
  usage timings — into its own trace before recording. An older peer sends no
  header ⇒ the entry records its shallow trace as before.
- **Live inflight enrichment** (`proxy/remote-inflight.ts`): the serve payload's
  `origin` carries the entry's inflight id plus the resolved request source
  (which the owning node stamps into its own trace and in-flight entry, so the
  peer's Request history attributes delegated calls instead of showing them
  anonymous). The owning node lists its registry at `GET /api/proxy/inflight`;
  the entry's runtime-snapshot assembly fans out to nodes owning remote targets
  (2 s TTL cache, refreshed by the reconcile loop while requests are active) and
  enriches its own inflight views by origin id — prefill progress tokens,
  lease-queue wait, server-side prefill timing — while stream-observed phases
  and an ended local state always win. Proxy load cards show remote requests at
  near-native depth with a ~2–4 s polling lag.

Still deferred: sub-second live telemetry (in-band telemetry frames muxed into
the serve stream instead of polling), and cross-node delegation of in-flight
actions (force-answer / finish / cancel) and the reasoning-text detail view.

## Identity & namespacing

- Instance names stay unique **within a node**; globally an instance is
  `<nodeId>/<name>`.
- Memory pools and proxy targets are **node-namespaced** in fleet views
  (`<nodeId>:gpu0`, target id `instance:<nodeId>:<name>`). `self` keeps bare ids
  for backward compatibility.
- This namespacing is also the machine-scoped-pool foundation that RPC (F3) needs.

## Phases

- **F0 — Node registry + read aggregation (done).** `config/nodes.json` + core
  `NodeSchema`; reverse-proxy `/api/nodes/<id>/*` (`nodes/remote.ts:forwardToNode`);
  bearer auth from `.secrets.json`; fleet read endpoints that fan out + namespace
  (`system`, `resources`, instance list). Powers the aggregated Resources view and
  the pickers.
- **F1 — Remote control (done).** Start / stop / edit / logs of remote instances
  via the owning node's API, routed by the global switcher
  (`web/src/ui/components/NodeSwitcher.tsx`).
- **F2 — Federated proxy (done).** Targets may be remote instances; the gateway
  picks node+target and delegates the request to the owning node's proxy
  (`proxy/delegate.ts`, `proxy/remote-health.ts`). Resources view fully
  machine-scoped.
- **F3 — RPC on top (partial).** An `rpc-server` worker is a remote instance
  (`kind` = `rpc-worker`) and `nodes/rpc-worker-catalog.ts` already offers remote
  workers as candidates for an orchestrator instance, endpoint-labelled by the
  peer's host. Still open: machine-scoped pool accounting of a remote worker's
  VRAM against the orchestrator's draw, and the cross-node lease atomicity that
  only a request spanning machines needs.

## Risks & things that change

- **Auth becomes mandatory.** "Admin off by default for local dev" cannot hold for
  cross-node calls — peers need bearer tokens, ideally over TLS. Trust model: a
  node token grants full control of that node (acceptable for a single operator's
  homelab; document it).
- **Partial failure.** An offline peer must degrade gracefully: its instances /
  pools show unreachable; the fleet proxy skips its targets rather than erroring.
- **API version skew** between nodes — a minimal version handshake on registration.

## Deferred backlog (intentionally not in the base)

- Remote-request telemetry: **sub-second in-band frames** and **in-flight action
  delegation** (the residual items in § Remote-request telemetry depth).
- A dedicated **Network overview** page (all instances/resources fleet-wide with
  deep-links to node-scoped editing). Aggregation on Resources + Public Status is
  enough for now; the overview is polish, built after the foundation is solid.
- Cross-node **lease atomicity** — only needed when RPC makes a request span
  machines; out of scope until F3.
