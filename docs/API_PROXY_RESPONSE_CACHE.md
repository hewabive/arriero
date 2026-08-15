# API Proxy Response Cache, Request Coalescing & Stream Fan-out

Serving identical proxy requests from a saved response instead of hitting the
upstream, collapsing concurrent duplicates onto a single in-flight request, and
fanning one live stream out to several clients. Driven by RAG + arena workloads
where distinct pipelines share identical sub-steps (e.g. the same
question-reformulation or the same embedding/rerank against the same model).

Cross-references: `docs/API_PROXY_PIPELINES.md` (node graph), `docs/API_PROXY_FOUNDATION.md`
(request flow), `docs/ANTHROPIC_OPENAI_BRIDGE.md` (translation + attribution),
`docs/RESOURCE_MANAGEMENT.md` (lease/eviction).

## Goal & scope

- Opt-in, node-placed caching — never global/automatic. The operator inserts a
  `cache` node only where reuse is intended.
- Embeddings and rerank (deterministic, non-streaming, single JSON body) and
  chat completions (streaming + non-streaming), including coalescing of
  concurrent duplicates and replay-buffered fan-out of a live stream.
- Claude Code attribution sanitization is a separate placeable
  `strip-attribution` node rather than an implicit step of translation, so a
  clean cache key (and KV-prefix stability) is composed explicitly where needed.

Non-goals: cross-process/shared cache, semantic/fuzzy matching, caching
upstream error bodies, caching fusion-node direct responses.

## Architecture the design rests on

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
  `apps/api/src/proxy/attribution.ts`) runs **only** where a
  `strip-attribution` node is placed. It used to be hardcoded inside
  `translateAnthropicForwardBody` (`apps/api/src/proxy/translation.ts`) at
  forward time — after the pipeline, and only for inbound Anthropic →
  non-anthropic upstream — which meant a mid-pipeline cache node keyed over
  volatile `cch` noise. Moving it into a node made placement explicit and
  extended it to OpenAI-native inbound and anthropic→anthropic passthrough.

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

### `strip-attribution` node

`ApiProxyStripAttributionConfigSchema` + its variant in the
`ApiProxyPipelineNodeSchema` union (`packages/core/src/index.ts`), port
`{ next }`. The `pipeline.ts` handler mirrors `replace-text`: run
`sanitizeClaudeCodeAttribution`, replace `state.request.body` if it changed,
invalidate the local token estimate, push a `routeTrace` step, follow `next`.
The pure logic stays in `apps/api/src/proxy/attribution.ts`.

The sanitizer is Anthropic-body-shaped and the pipeline body is in the client
protocol (Anthropic for Claude Code, pre-translation), so placing the node
anywhere upstream of the target is structurally correct. Sanitization now shows
in `routeTrace` / route-explain instead of happening silently inside
translation.

### `cache` node and the `response` terminal

`ApiProxyCacheConfigSchema` (`ttlSeconds`, `namespace`) with a single `next`
port — the miss/cold path. A hit is an implicit terminal, so there is no
separate `hit` port.

`case "cache"` in `resolveApiProxyRouteChain` computes the key from the body at
the node's position and looks it up through an injected `lookupCache` (supplied
by the protocol endpoint; `route-explain` omits it, so a dry run always misses):

- **warm** → return `{ ok:true, kind:"response", … }` with the stored
  body/content-type/is-sse;
- **cold/hot** → append a `cache-store` descriptor to `state.responseEffects`
  and follow `next`.

`proxyProtocolEndpointInner` handles `kind:"response"` after route resolution
and before the gateway, exactly like an early `fusion` result: build a
`Response` from the stored bytes, mark the trace, return — skipping
gateway/lease/readiness/forward entirely. Fusion panel branches get a
buffered-only wrapper (panels are always non-stream); the synthesizer branch is
store-only.

Writes are committed by the reverse response-plan executor at the cache node's
boundary. Successful JSON and SSE bodies keep their actual status and content
type; errors and incomplete streams are never stored.

### Cache store

`proxy_response_cache` (SQLite), declared in both `db/schema.ts` and
`db/index.ts:migrate()`: `key PRIMARY KEY, model_id, content_type, is_sse, body
BLOB, size_bytes, created_at, expires_at, last_access_at, hit_count`. It is a
rebuildable cache, the same role `model_cache` has. Eviction is per-entry TTL
(`expires_at`) plus a global size-bounded LRU (`last_access_at`) — embedding
vectors are large, so the size cap is mandatory. `apps/api/src/proxy/response-cache.ts`
owns `get`/`put`/`evict` and the admin list/clear operations.

### Coalescing / single-flight

In-flight registry `response-coalesce.ts`: `register`/`find`/`settle` over a
`Map<key, deferred>`. After a store miss the cache node checks for an in-flight
owner — present ⇒ `await` it (`kind:"response"`, `source:"coalesced"`; waiters
do no compute and skip the lease because routing short-circuits); absent ⇒
register as owner and continue to the target.

- Settlement is driven by the response-plan cache effect on flush: each key is
  settled with the stored payload (success) or `null` (error/no body), which
  releases waiters and removes the map entry, so an owner always settles its
  own key. The `kind:"response"` endpoint path settles any owner keys it carries
  (owner-then-downstream-hit). Error paths settle too: a route-chain failure
  returns its accumulated `responseEffects` in the `ok:false` result and
  `protocol-endpoint` creates the response plan on that branch (and on the
  fusion-error branch), so the guaranteed record-time flush settles or aborts
  every registration. The 120 s timeout in `findInFlight` is only a backstop for
  owner hangs.
- On owner failure waiters resolve to `null` and fall through to a plain miss
  (forward + their own cache write), so a failed owner never poisons the herd.
- A second cache node resolving to the same key inside one chain (a shared
  pipeline via `call`, with no body-changing node between) is a pass-through,
  not a lookup: the request already owns the key, so coalescing onto itself (a
  guaranteed deadlock) and duplicate stores are impossible — the route trace
  says `duplicate cache key (pass-through)`.

### Stream fan-out

- **Framing-matched, no re-framing.** One store slot per key (`stream` stays
  excluded from the key), but a read only hits when the entry's framing matches
  the client: a stream client hits an `isSse` entry, a non-stream client hits a
  non-SSE entry, and a mismatch is treated as a miss and regenerates (last
  writer wins the framing). Consistent per-pipeline usage never thrashes, and
  this avoids all SSE↔JSON re-framing code.
- **Broadcaster** (`response-broadcast.ts`): per-key chunk buffer + subscriber
  set. A stream miss registers a broadcast (owner); a concurrent stream request
  subscribes (`source:"coalesced"`, `kind:"response"` whose body is a
  `ReadableStream` = replay buffer + live tail), so the route-chain `response`
  body is `string | ReadableStream<Uint8Array>`. Fan-out is **best-effort per
  subscriber**: a subscriber whose client already went away has a closed
  controller, so `enqueue`/`close`/`error` throw. One dead follower must never
  abort delivery to the others, so every loop swallows that throw —
  `pushApiProxyBroadcast` and `abortApiProxyBroadcast` drop the subscriber from
  the set, and `finishApiProxyBroadcast` ignores it outright because it clears
  the whole set on the next line. The throw carries no information the manager
  can act on: the controller is already closed and the entry is already removed
  from `broadcasts`.
- **Two serve paths, two fan-out modes:**
  - Live `respond()` path (non-preemptible managed, external, translated):
    `decoupledStreamResponse` tees the fully transformed stream — one branch to
    the owner's client, one **pumped** to completion in the background
    (`drainApiProxyStream`), decoupled from the client. The cache effect's tap
    feeds the broadcast per chunk (bytes at the cache node's position, so
    followers replay through their own transform prefix) and stores the
    accumulated SSE on flush; the owner itself receives the post-transform
    stream, never the raw broadcast bytes. If the owner's client disconnects the
    pump still finishes, so subscribers and the cache are complete. The remote
    fleet-node delegation path uses the same helper, so delegated targets get
    identical owner-disconnect decoupling. The pump
    (`protocol-endpoint.ts:drainApiProxyStream`) exists only to keep the
    upstream flowing, so it **swallows a read failure**: an upstream error on
    the drained branch is already observed by the response plan, whose
    finalize/record path records the trace and flushes the cache effects
    (aborting the broadcast). Re-reporting it would double-count the failure and
    letting it escape would reject a floating promise; the pump's only
    obligation is the `finally` that releases the reader lock.
  - Buffered resumable path (preemptible managed chat): the response is built
    all at once, so it does **completed fan-out** — on success it stores the
    final SSE, pushes it to the broadcast as one chunk, and finishes, and
    subscribers that were waiting get the whole result. **Limitation:** this
    path is not decoupled — if the owner's client aborts mid-generation the
    upstream aborts, nothing is cached, and the broadcast aborts (subscribers'
    streams error). Managed-chat streaming via resumable is already buffered, so
    this only affects the rare owner-abort case.
- **No broadcast leak, failure = abort.** The response plan settles every cache
  key on flush. A cacheable body finishes the broadcast (clean close); anything
  else — upstream error, incomplete stream, route/fusion failure — **aborts** it
  (`abortApiProxyBroadcast`), erroring subscribers' streams instead of closing
  them as an empty 200 success. Error finals are never pushed as broadcast
  bytes: followers must not receive JSON error bodies inside an SSE stream.

### Telemetry, traces, ops

- `ApiProxyRequestTrace` carries a cache marker (`hit` | `coalesced` | `store` |
  `miss`). A follower's `hit`/`coalesced` marker survives the flush of upstream
  store effects (`trace.cache ??= "store"`). Only the owner is metered;
  subscription bodies skip `usageFromNonStreamBody`.
- `ApiProxyStatsTotals` / `ApiProxyStatsModelEntry` carry `cacheHits`, counting
  traces whose `trace.cache` ∈ {`hit`, `coalesced`} — requests served without an
  upstream call. `store` is a forward-that-cached, not a hit.
- `GET /api/proxy/cache` → `{ entries, totalBytes }`;
  `DELETE /api/proxy/cache` clears the store (`apiProxyResponseCacheStats` /
  `clearApiProxyResponseCache`). Surfaced in the proxy Statistics section
  (totals block, per-hour column, per-request `cache` badge) alongside a
  Response-cache card.
- Web: `cache` and `strip-attribution` nodes in the canvas palette with their
  config panels.

## Test coverage gap

The live pump plus client-disconnect integration is not unit-tested — hard to
exercise without a real streaming upstream. The broadcaster, the streaming
cache-node routing, and the response plan's SSE store/feed/finish are
unit-tested. Verify multi-client fan-out and disconnect manually after touching
this path.

## Risks and backlog

- **Invalidation.** Entries go stale when the underlying model, binary or
  launch args change; today only TTL and a manual clear cover it. The fix is a
  target "generation" component in the key.
- **Forgotten sanitization.** Manual `strip-attribution` placement means Claude
  Code traffic through a pipeline without the node loses KV-prefix stability and
  cache-key cleanliness — an accepted trade for placement control.
- **Stream fan-out backpressure.** Replay buffers are unbounded and a slow
  subscriber is never dropped; bound the memory and disconnect laggards.
- **Owner-lifetime decoupling for the buffered resumable path** (the
  owner-abort limitation above).
- **Out of scope:** cross-process or multi-node sharing (the SQLite store
  already survives restarts within one process tree) and semantic caching.
- Optional SSE↔JSON re-framing, so stream and non-stream requests could share
  one entry, is deliberately not built (see framing-matched reads).
