# API Proxy Response Cache, Request Coalescing & Stream Fan-out

Design + phased implementation plan for serving identical proxy requests from a
saved response instead of hitting the upstream, collapsing concurrent duplicates
onto a single in-flight request, and fanning one live stream out to several
clients. Driven by RAG + arena workloads where distinct pipelines share
identical sub-steps (e.g. the same question-reformulation or the same
embedding/rerank against the same model).

Cross-references: `docs/API_PROXY_PIPELINES.md` (node graph), `docs/API_PROXY_FOUNDATION.md`
(request flow), `docs/ANTHROPIC_OPENAI_BRIDGE.md` (translation + attribution),
`docs/RESOURCE_MANAGEMENT.md` (lease/eviction).

## Goal & scope

- Opt-in, node-placed caching — never global/automatic. The operator inserts a
  `cache` node only where reuse is intended.
- First-class support for embeddings and rerank (deterministic, non-streaming,
  single JSON body) — the highest-value, lowest-risk slice.
- Then chat completions (streaming + non-streaming), including coalescing of
  concurrent duplicates and replay-buffered fan-out of a live stream.
- Decouple Claude Code attribution sanitization from translation into its own
  placeable `strip-attribution` node, so a clean cache key (and KV-prefix
  stability) is composed explicitly where needed.

Non-goals (v1): cross-process/shared cache, semantic/fuzzy matching, caching
upstream error bodies, caching fusion-node direct responses.

## Established architecture facts (verified)

- All protocol endpoints (`/v1/chat/completions`, `/v1/embeddings`,
  `/v1/rerank`, …) share one path: `proxyProtocolEndpoint` →
  `resolveApiProxyRouteChain` (pure pre-pass) → gateway → domain lease →
  `serveResolvedTarget` → forwarder. A pipeline node therefore works uniformly
  across all of them.
- The route chain is a pure pre-pass: `resolveApiProxyRouteChain`
  (`apps/api/src/proxy/pipeline.ts`) walks the node graph mutating
  `state.request` and returns `ApiProxyRouteChainResult` with
  `kind: target | endpoint | fusion | response | error`. A cache hit returns
  the early `response` terminal before gateway/lease.
- Response work is centralized in `createApiProxyResponsePlanExecutor`
  (`apps/api/src/proxy/response-plan.ts`). Cache stores and Save response are
  ordered effects and therefore observe the exact body at their graph
  position, for both JSON and SSE.
- Embeddings/rerank are non-streaming, single JSON, deterministic — read whole
  via `upstream.text()`; metered by `usageFromNonStreamBody`
  (`apps/api/src/proxy/usage-meter.ts`).
- Claude Code attribution sanitization (`sanitizeClaudeCodeAttribution`,
  `apps/api/src/proxy/attribution.ts`) is currently invoked **only** inside
  `translateAnthropicForwardBody` (`apps/api/src/proxy/translation.ts`) at
  forward time, gated on `translateAnthropic` (inbound Anthropic →
  non-anthropic upstream). It does not run for OpenAI-native inbound, nor for
  anthropic→anthropic passthrough, and runs **after** the pipeline — so a
  mid-pipeline cache node would otherwise key over volatile `cch` noise.

## Design decisions (the contract)

1. **Key over body-at-node-entry.** The cache key is computed from
   `state.request.body` as it exists when the walk enters the `cache` node —
   i.e. reflecting all preceding nodes, ignoring any subsequent transforms.
   This is free: it is exactly the body the pre-pass already holds.
2. **Sanitization is a node, placed manually.** `strip-attribution` cleans the
   `cch`/billing attribution. To get a clean key, place it before `cache`
   (`strip-attribution → cache → target`). Removing the hardcoded call from
   translation means sanitization is **no longer automatic** — chosen
   deliberately (manual variant). Requests with a direct `routeTo` (no pipeline)
   or pipelines without the node simply are not sanitized.
3. **Determinism is the operator's call.** The key hashes the full canonical
   body including sampling params. Same params (even `temperature>0`) ⇒ same
   key ⇒ shared result is accepted by fiat (placement = consent). Different
   `temperature`/`seed`/etc. ⇒ different key automatically. Arena never routes
   the same prompt to the same model, so no special handling.
4. **Three states of a key**, unified by the `cache` node:
   - `cold` (miss) → forward, become owner, fill cache, fan-out.
   - `hot` (in-flight) → coalesce: subscribe to the owner's live result.
   - `warm` (stored) → replay from store.
5. **A hit short-circuits before gateway/lease.** No autostart, no model load,
   no domain lease, no forward. This is the main win for RAG.

## Cache key specification

```
key = sha256( formatVersion ‖ namespace ‖ modelId ‖ canonicalJson(body \ volatile) )
```

- `namespace` — optional `cache` node config field; disambiguates when one
  public model id is conditionally routed to different upstreams.
- `modelId` — `resolution.request.modelId` (public model name; known at node
  entry). Distinct models never collide.
- `body \ volatile` — strip `stream` and `stream_options` (streaming preference
  must not split the entry), keep everything else (messages/input/query/
  documents, temperature, top_p, top_k, seed, max_tokens, tools, …).
- `canonicalJson` — stable key ordering so equal bodies hash equal.
- `formatVersion` — invalidates entries when the cache boundary contract
  changes (currently version 2, introduced with positional response effects).
- The body is already attribution-clean **iff** a `strip-attribution` node ran
  earlier; otherwise volatile `cch` hashes churn the key (operator's
  responsibility, documented at the node).

## Components

### `strip-attribution` node (PR1)

- Core schema: add `ApiProxyStripAttributionConfigSchema` (v1 may be empty or
  two toggles: strip billing line / pin `cch`→0, both default on) and a variant
  in the `ApiProxyPipelineNodeSchema` discriminated union
  (`packages/core/src/index.ts`), `ports: { next }`.
- Handler in `pipeline.ts` mirrors `replace-text`: run
  `sanitizeClaudeCodeAttribution`, replace `state.request.body` if changed,
  invalidate the local token estimate, push a `routeTrace` step, follow `next`.
- Logic stays in `apps/api/src/proxy/attribution.ts`. (Optional: move the pure
  fn to core later if the web block-editor wants a live preview.)
- Remove the `sanitizeClaudeCodeAttribution` call from
  `translateAnthropicForwardBody` — translation becomes pure protocol
  translation. The sanitizer is Anthropic-body-shaped and the pipeline body is
  in the client protocol (Anthropic for CC, pre-translation), so node placement
  anywhere upstream of the target is structurally correct.
- Validation (`pipeline-validation.ts`) + web palette/config form
  (`apps/web/src/ui/proxy/canvas/`). Net observability gain: sanitization now
  shows in `routeTrace`/route-explain instead of being silent.

### `cache` node + `kind:"response"` short-circuit (PR2 — Phase 1)

- Core schema: `ApiProxyCacheConfigSchema` (`ttlSeconds`, `namespace`) + union
  variant. Port: `{ next }` for a miss; a hit is an implicit terminal.
- New terminal in `ApiProxyRouteChainResult`:
  `{ ok:true, kind:"response", request, response: {...}, routeTrace }`.
- `case "cache"` in `resolveApiProxyRouteChain`:
  - compute key; look up store.
  - warm → return `kind:"response"` with the stored body/content-type/is-sse.
  - cold/hot → append a `cache-store` response effect carrying the key + ttl,
    then follow `next`.
- `proxyProtocolEndpointInner` (`protocol-endpoint.ts`): after route resolution
  (~`:288`), before the gateway (~`:688`), handle `kind:"response"` exactly like
  `fusion` is handled early — build a `Response` from the stored bytes, mark the
  trace, return. Skips gateway/lease/readiness/forward entirely.
- Write path: the reverse response-plan executor accumulates JSON or SSE at the
  cache node's exact boundary and commits it on successful completion.
- Downstream consumers of the route result (`fusion.ts`, `gateway.ts`,
  `route-explain`) must tolerate/short-circuit the new kind.

### Cache store (PR2)

- New SQLite table `proxy_response_cache` declared in both `db/schema.ts`
  (Drizzle) and `db/index.ts:migrate()` (idempotent `CREATE TABLE IF NOT
  EXISTS`): `key PRIMARY KEY, model_id, content_type, is_sse, body BLOB,
  size_bytes, created_at, expires_at, last_access_at, hit_count`.
- Rebuildable cache (fits the DB's "runtime state + rebuildable caches" role,
  like `model_cache`). Eviction: per-entry TTL (`expires_at`) + global
  size-bounded LRU (`last_access_at`, cap from config/env). Embedding vectors
  are large → size cap is mandatory.
- Module `apps/api/src/proxy/response-cache.ts`: `get(key)`, `put(...)`,
  `evict()`, plus a clear/list admin op for the UI.

### Coalescing / single-flight (PR3)

- In-memory `Map<key, InFlight>` keyed by the same cache key.
- Non-streaming: a `hot` hit `await`s the owner's settled bytes (a shared
  promise) instead of forwarding. Subscribers skip the domain lease and
  readiness (they do no compute) and are metered as `coalesced`.
- Owner lifetime: drive the upstream to completion independent of the
  originating client's abort, so the cache fills and subscribers survive
  (behavior change — documented).

### Stream fan-out (PR4 — the heavy one)

- `Broadcaster` wrapping the single upstream SSE stream at the `tap` point:
  `chunks: Uint8Array[]` replay buffer + `Set<subscriber>` + done/error state.
- Late joiner: a `ReadableStream` that first drains the buffer, then receives
  live chunks, then closes on upstream end. Per-subscriber queues so a slow
  client never stalls the owner or peers (drop/disconnect a hopeless laggard).
- Re-framing: handle stream/non-stream mismatch between the stored/owner stream
  and a joining client's preference (sse → concatenated final JSON, json →
  single-shot sse).
- Telemetry: only the owner is metered; subscribers `coalesced`. Errors
  mid-stream propagate to all subscribers.

### Telemetry, traces, UI (folded across PRs)

- `ApiProxyRequestTrace` gains a cache marker (`hit` | `coalesced` | `store` |
  `miss`); `proxy/stats.ts` counts hit rate. No double-counting of usage.
- Web: `cache` + `strip-attribution` nodes in the canvas palette + config
  panels; a cache admin view (list/clear) via a new `/api/proxy/cache` route and
  `apps/web/src/api/client.ts`.

## Phasing (PR breakdown)

| PR | Title | Content | Weight | Status |
|----|-------|---------|--------|--------|
| 1 | `strip-attribution` node | core schema + `pipeline.ts` handler + validation + web; remove hardcoded sanitize from `translation.ts`; tests | small | done |
| 2 | `cache` node, Phase 1 (embed/rerank + non-stream) | core schema; `kind:"response"` + short-circuit; key util; `response-cache.ts` + SQLite table + TTL/LRU; non-stream write/replay; trace marker; tests | medium | done |
| 3 | single-flight coalescing (non-stream) | in-flight map; `hot` subscribe; subscribers skip lease; owner-lifetime decoupling; `coalesced` telemetry; tests | medium | done |
| 4 | stream fan-out (chat) | broadcaster + replay buffer; per-subscriber queues; stream/non-stream re-framing; telemetry; tests | high | done |
| 5 | UI + ops polish | cache admin view + clear/list endpoint; stats hit-rate; docs finalize | small/medium | done |

### PR2 implementation notes (as built)

- Cache node uses a single `next` port (= the miss/cold path); a hit is an
  implicit terminal that returns `kind:"response"`. No separate `hit` port.
- The route-chain gains injected `lookupCache` (provided by the protocol
  endpoint; `route-explain` and `fusion` omit it, so the node always misses in
  dry-run / fusion branches). The handler computes the key from the body at the
  node's position and appends a `cache-store` descriptor to
  `state.responseEffects` on a miss.
- Writes are committed by the reverse response-plan executor at the cache
  node's boundary. Successful JSON and SSE bodies retain their actual status
  and content type; errors and incomplete streams are not stored.

### PR3 implementation notes (as built)

- In-flight registry `response-coalesce.ts`: `register/find/settle` over a
  `Map<key, deferred>`. The cache node, after a store miss, checks for an
  in-flight owner: present ⇒ `await` it (`kind:"response"`, `source:"coalesced"`,
  waiters do no compute and skip the lease since routing short-circuits);
  absent ⇒ register as owner and continue to the target.
- Settlement is driven by the response-plan cache effect on flush: each cache
  key is settled with the stored payload (success) or `null` (error/no body) —
  this releases waiters and removes the map entry, so an owner always settles
  its own key. The `kind:"response"` endpoint path also settles any owner keys
  it carries (owner-then-downstream-hit). Error paths settle too: a route-chain
  failure returns its accumulated `responseEffects` in the `ok:false` result and
  `protocol-endpoint` creates the response plan on that branch (and on the
  fusion-error branch), so the guaranteed record-time flush settles/aborts every
  registration. The 120s timeout in `findInFlight` remains only as a backstop
  for owner hangs.
- On owner failure, waiters resolve to `null` and fall through to a plain miss
  (forward + their own cache write), so a failed owner never poisons the herd.
- A second cache node resolving to the same key inside one chain (shared
  pipeline via `call`, no body-changing node between) is a pass-through, not a
  lookup: the request already owns the key, so coalescing onto itself (a
  guaranteed deadlock) and duplicate stores are impossible
  (`duplicate cache key (pass-through)` in the route trace).
- **Not yet done:** owner-lifetime decoupling from the originating client. If the
  owner's client aborts, its upstream is aborted too (no cache write ⇒ waiters
  fall back). Driving the owner to completion independent of its client is
  deferred (rides on the PR4 streaming work).

### PR4 implementation notes (as built)

Streaming requests now participate in the cache node (they were skipped in PR2).

- **Framing-matched, no re-framing.** One store slot per key (stream still
  excluded from the key), but a read only hits when the entry's framing matches
  the client: a stream client hits an `isSse` entry, a non-stream client hits a
  non-SSE entry; a mismatch is treated as a miss and re-generates (last writer
  wins the framing). Consistent per-pipeline usage never thrashes; this avoids
  all SSE↔JSON re-framing code.
- **Broadcaster** (`response-broadcast.ts`): per-key chunk buffer + subscriber
  set. A stream miss registers a broadcast (owner); a concurrent stream request
  subscribes (`source:"coalesced"`, `kind:"response"` with a `ReadableStream`
  body = replay buffer + live tail). The route-chain `response` body is now
  `string | ReadableStream<Uint8Array>`.
- **Two serve paths, two fan-out modes** (chosen: full live fan-out, owner
  outlives client):
  - Live `respond()` path (non-preemptible managed, external, translated):
    `decoupledStreamResponse` tees the fully transformed stream — one branch to
    the owner's client, one **pumped** to completion in the background
    (`drainApiProxyStream`), decoupled from the client. The cache effect's tap
    feeds the broadcast per chunk (bytes at the cache node's position, so
    followers replay through their own transform prefix) and stores the
    accumulated SSE on flush; the owner itself receives the post-transform
    stream, never the raw broadcast bytes. If the owner's client disconnects,
    the pump still finishes → subscribers + cache are complete. The remote
    fleet-node delegation path uses the same helper, so delegated targets get
    identical owner-disconnect decoupling. ✅ option A fully honored here.
  - Buffered resumable path (preemptible managed chat): the response is built
    all-at-once, so it does **completed fan-out** — on success it stores the
    final SSE, pushes it to the broadcast as one chunk, and finishes; subscribers
    that were waiting get the whole result. **Limitation:** this path is *not*
    decoupled — if the owner's client aborts mid-generation the upstream aborts,
    no cache write, and the broadcast aborts (subscribers' streams error).
    Managed-chat streaming via resumable is already buffered (the client gets the
    reply at the end), so this only affects the rare owner-abort case.
- **No broadcast leak, failure = abort:** the response plan settles every cache
  key on flush. A cacheable body finishes the broadcast (clean close); anything
  else — upstream error, incomplete stream, route/fusion failure —
  **aborts** it (`abortApiProxyBroadcast`), erroring subscribers' streams
  instead of closing them as an empty 200 success, and error finals are never
  pushed as broadcast bytes (followers must not receive JSON error bodies
  inside an SSE stream).
- A follower's `trace.cache:"hit"`/`"coalesced"` marker survives the flush of
  upstream store effects (`trace.cache ??= "store"`).
- **Telemetry:** subscribers report `trace.cache:"coalesced"`; only the owner is
  metered (subscription bodies skip `usageFromNonStreamBody`).
- **Not unit-tested:** the live pump + client-disconnect integration (hard to
  exercise without a real streaming upstream). The broadcaster, the streaming
  cache-node routing, and the response plan's SSE store/feed/finish are
  unit-tested; recommend a manual live verification of multi-client fan-out +
  disconnect.

### PR5 implementation notes (as built)

- Ops endpoints: `GET /api/proxy/cache` → `{ entries, totalBytes }`,
  `DELETE /api/proxy/cache` → clears the store (`apiProxyResponseCacheStats` /
  `clearApiProxyResponseCache`).
- Stats: `ApiProxyStatsTotals`/`ApiProxyStatsModelEntry` gain `cacheHits` (counts
  traces with `trace.cache` ∈ {`hit`,`coalesced`} — i.e. requests served without
  an upstream call; `store` is a forward-that-cached, not a hit). Surfaced in the
  proxy Statistics section (totals block + per-hour column + a per-request
  `cache` badge) alongside a Response-cache card (entries/size + Clear).

## Status: all five PRs landed

The feature is complete per this plan. Remaining backlog (not scheduled):
owner-lifetime decoupling for the buffered resumable path; bounded per-subscriber
queues / laggard disconnect; a target "generation" component in the key for
invalidation on model/binary/args change; optional SSE↔JSON re-framing to let
stream and non-stream requests share one entry.

## Risks & future

- **Invalidation:** stale entries when the underlying model/binary/args change.
  v1 relies on TTL + manual clear; later add a target "generation" component to
  the key.
- **Forgotten sanitization:** manual `strip-attribution` placement means CC
  traffic without the node loses KV-prefix stability and cache-key cleanliness —
  accepted trade for placement control.
- **Stream fan-out backpressure:** unbounded replay buffers vs. slow
  subscribers; bound memory and disconnect laggards.
- **Future:** persistent/shared cache across restarts already holds (SQLite);
  cross-process or multi-node sharing is out of scope; semantic caching is a
  separate effort.
