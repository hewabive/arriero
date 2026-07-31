# API Proxy Foundation

This document captures the intended shape of the future `arriero` API proxy. The current implementation adds shared contracts, durable disabled-by-default configuration, runtime diagnostics, pure planning logic, simple public OpenAI-compatible execution and HTTP forwarding helpers. It also introduces a protocol-adapter boundary for OpenAI-compatible and Anthropic-compatible public facades. Proxy targets now point at entries in a shared API endpoint catalog. Managed instances and the arriero proxy are generated read-only catalog entries; external APIs are editable catalog entries with optional auth settings. Public OpenAI-compatible requests can start or load a managed target before forwarding when the scheduler plan only requires MVP-supported readiness actions. External API targets are forwarded without instance-management actions.

## Problem Shape

The primary case is a single scarce accelerator shared by multiple `llama-server` processes or router models:

- A background target can run long, low-priority work.
- An interactive target is usually idle, but must preempt the background target when a request arrives.
- Before preemption, the background target may need slot state saved.
- After the interactive target becomes idle, it can be unloaded and the background target can be loaded again.

The second expected case is API adaptation: accepting one API shape and forwarding a compatible or transformed request to a specific `llama-server` endpoint.

## Existing Building Blocks

- `requestLlamaModelAction`: model `load`, `unload` and `reload`.
- `requestLlamaSlotAction`: slot `save`, `restore` and `erase`.
- `probeLlamaServer` and health summaries: current endpoint, model and slot diagnostics.
- `ProcessSupervisor`: process start, stop and restart.
- Probe streaming: existing server-side streaming from llama-server to the UI.

## New Foundation

- Core proxy contracts in `packages/core`:
  - `ApiEndpointConfig`
  - `ApiProxyTargetConfig`
  - `ApiProxyRouteConfig`
  - `ApiProxyModelConfig`
  - `ApiProxyTargetRuntime`
  - `ApiProxySchedulerPlanRequest`
  - `ApiProxySchedulerPlan`
- Runtime collector in `apps/api/src/proxy/runtime.ts`:
  - resolves target endpoint IDs through the shared API endpoint catalog
  - derives managed target state from instance health summaries, `/v1/models` and slots
  - treats external API endpoints as ready for forwarding without process management
  - tracks idle time in process memory
  - merges persistent saved slot ids and last request time from SQLite
- Pure scheduler in `apps/api/src/proxy/scheduler.ts`:
  - `planApiProxyRequest`
  - `planApiProxyIdleMaintenance`
- HTTP helper functions in `apps/api/src/proxy/http.ts`:
  - upstream URL joining
  - request/response header filtering
  - event-stream detection
- Protocol adapter helpers in `apps/api/src/proxy/protocol.ts`:
  - normalized public model request shape
  - protocol-specific error formatting
  - shared model lookup and enabled-model validation
  - transport marker for future HTTP JSON, SSE and WebSocket handling
- Gateway helper in `apps/api/src/proxy/gateway.ts`:
  - verifies that a published model is bound to a proxy target
  - builds a scheduler request plan for the bound target
  - returns protocol-specific diagnostics when the target is missing, blocked or not ready
  - allows forwarding only when no scheduler action is needed except `route-request`
- Forwarder in `apps/api/src/proxy/forwarder.ts`:
  - forwards ready OpenAI-compatible requests to the resolved target Base URL
  - applies endpoint auth headers for external APIs
  - rewrites the request `model` to the target upstream model when configured
  - preserves upstream response status, headers and body stream
  - accepts either a root URL or a `/v1` API Base URL
- Public MVP executor in `apps/api/src/proxy/public-executor.ts`:
  - can start a stopped instance for OpenAI-compatible requests
  - can load the target model when the scheduler asks for `load-model`
  - waits for instance/model readiness before forwarding
  - rejects preemption, slot save/restore and unload actions for now
- Durable configuration in files under `data/config/proxy/` (`proxy/config-files.ts` store; `proxy/repository.ts` + `proxy/endpoints.ts` CRUD):
  - `endpoints.json` (external-API definitions; API keys in `data/config/.secrets.json`, gitignored)
  - `api_proxy_models` → `models.json`
  - `api_proxy_targets` → `targets.json`
  - pipelines → `pipelines.json`
- Runtime state stays in SQLite:
  - `api_proxy_runtime_metadata` (saved slots, last-request; no longer FK-bound to a targets table)
- One-time upgrade: `proxy/legacy-migration.ts` exports the former `api_endpoints` / `api_proxy_{targets,models,pipelines}` tables to the JSON files, then drops them.
- Admin UI pages:
  - separate API endpoint catalog page
  - external proxy models
  - endpoint-based proxy targets
  - runtime state preview
  - scheduler plan preview
  - external API listener with guarded ready-target forwarding

## External Protocol Facades

The external protocol surfaces are public and intentionally separate from admin `/api/*` routes:

- `GET /proxy/v1/models` and `GET /v1/models` list **visible** proxy models from `models.json`, each with a llama.cpp-router-style `status` object (see _Model visibility, serving, and `/v1/models` status_ below).
- `POST /proxy/v1/chat/completions`, `/proxy/v1/completions`, `/proxy/v1/embeddings` and `/proxy/v1/responses` validate the `model` field and return OpenAI-shaped errors.
- The same POST endpoints are also available under `/v1/*`.
- `POST /proxy/anthropic/v1/messages` and `POST /v1/messages` validate the `model` field and return Anthropic-shaped errors.

At this stage, OpenAI-compatible generation endpoints can start/load/wait for managed targets, then forward. External API targets skip management and forward directly:

- `/v1/chat/completions`
- `/v1/completions`
- `/v1/embeddings`
- the same endpoints under `/proxy/v1/*`

Unknown models return the protocol-specific `not_found` error; a model whose serving is **disabled** (`enabled:false`) returns a `503` `model_disabled` before any routing or autostart (it stays callable by name even when hidden, so it can be tested before exposure). OpenAI Responses (`/v1/responses`) forwards natively (llama-server implements it). Anthropic Messages (`/v1/messages`) is translated to OpenAI Chat Completions for non-anthropic upstreams via `packages/anthropic-openai-bridge` — see `docs/ANTHROPIC_OPENAI_BRIDGE.md`.

If a known enabled model is not bound to a proxy target, or if the scheduler would need to unload a competing target, save a slot, restore a slot or stop an instance, the public endpoint returns a protocol-specific `503` diagnostic. This means public requests are now connected to the same scheduling model as the admin preview, but the MVP intentionally supports only simple autostart, autoload and forward.

## Model visibility, serving, and `/v1/models` status

A proxy model carries two independent control flags in `config/proxy/models.json`:

- `visible` — listed in `GET /v1/models`. Hidden models (`visible:false`) are absent from the catalog but **remain callable by name**, so a freshly-created model can be tested before it is exposed to consumers.
- `enabled` — serves requests. With `enabled:false` the model is **disabled**: every request short-circuits with a `503` `model_disabled` before routing/autostart, regardless of visibility.

`GET /v1/models` mirrors llama.cpp router mode by attaching a per-model `status` to each listed entry:

```json
{ "id": "my-model", "object": "model", "owned_by": "arriero",
  "status": { "value": "partial", "active_requests": 2, "queued_requests": 5 } }
```

Two orthogonal axes:

- **Load** (`status.value`) is aggregated over the model's route leaves (the target(s) a direct route or pipeline resolves to): `unloaded` / `loading` / `partial` / `loaded` / `failed`, plus `disabled` which overrides when `enabled:false`. A direct-target model only ever reports the llama.cpp set — `partial` needs ≥2 leaves. Internal pipeline structure is never exposed, only the aggregate.
- **Work** is `active_requests` (dispatched to a target) and `queued_requests` (accepted by the proxy, waiting on a domain lease / autostart). Independent of the load axis — a model can be busy while only partially loaded.

The status is derived from a short-TTL (2s) cache of the proxy runtime snapshot (`getCachedApiProxyRuntimeSnapshot`), so `/v1/models` stays read-only and cheap and never triggers autoload. Derivation lives in `proxy/model-status.ts`.

This `value` is the public **L4** layer — a frozen, llama.cpp-router-derived external contract. The internal target/instance/process status layers it is computed from, and the boundary adapter (`leafLoadFromTargetState`) that translates internal `ready`/`error` into the public `loaded`/`failed`, are documented in `docs/STATUS_LAYERS.md`.

## Admin Diagnostics

The admin API exposes diagnostics for the next implementation step:

- `GET /api/proxy/runtime` returns a runtime snapshot for configured proxy targets.
- `POST /api/proxy/plan` returns the scheduler plan for either an incoming request or an idle-maintenance pass.
- `GET /api/proxy/stats?hours=` returns hourly request counters (requests/errors/tokens/genMs/rate, per-model breakdown + totals, incl. `cacheHits`) from the Observer `proxy/stats.ts`. `requestsWithTokens` exposes the share of requests that carried usage. Counters live in memory but are reseeded at boot from the last 24 h of persisted traces. Metering coverage is described under **Telemetry** below.
- `GET /api/proxy/traces` returns persisted per-request `ApiProxyRequestTrace` records (model → route → target → scheduler actions → usage → outcome), newest first. The query is validated by the core `ApiProxyTraceListQuerySchema` (invalid values → 400). Filters: `from=`/`to=` (inclusive ISO time range), `modelId=`, `sourceId=`, `targetId=`, `protocol=`, `endpoint=`, `ok=true|false`, `status=`, `errorCode=`, `cache=hit|store|coalesced|none`, `resumed=`, `stream=`, `translated=`, `minDurationMs=`. Pagination: `before` is an `at`-cursor, `limit` is clamped to 500; `withTotal=true` additionally returns `total` — the count of rows matching the filter regardless of pagination (requested only for the first history page, so polling consumers skip the COUNT).
- `GET /api/proxy/traces/facets` returns distinct filter values with occurrence counts over the whole history (models, sources, targets, endpoints, protocols, statuses, error codes; sources/targets carry a display `name` from the dedicated `source_name`/`target_name` columns) plus `retentionDays` — used to populate the Request-history page (`#/proxy/traces`) filter dropdowns and retention caption.

These admin endpoints are read-only with respect to llama-server. They do not start or stop instances, load or unload models, save slots, restore slots or forward user traffic. The stats/traces views are populated as a side-effect of served public traffic; the endpoints themselves only read the Observer and the trace history.

## Telemetry

Every request emits an `ApiProxyRequestTrace` recorded by the Observer `proxy/stats.ts`: in-memory hourly counters keyed off `trace.at` (reseeded at boot from history) plus a persistent trace history in SQLite `proxy_request_traces` (`proxy/traces-repository.ts`) — one row per trace with indexed filter columns (`at`, `model_id`, `source_id`, `target_id`, `ok`, …) and the full validated trace as JSON, re-parsed with `safeParse` on read so schema evolution self-heals by dropping incompatible rows. Retention is 30 days, enforced at boot and by an hourly unref'd background loop (`startApiProxyTraceRetentionLoop`, wired in `apps/api/src/index.ts`) so the prune never runs on a request path; the prune pass also deletes `data/proxy-requests/` capture-artifact directories older than the same cutoff (by the timestamp embedded in the directory name, so orphaned artifacts are swept too). Tokens and rate are metered on **both** the resumable path and the plain forwarder, via `proxy/usage-meter.ts`:

- **Non-stream** parses the final JSON. The exception is a managed `chat.completions`/`messages` request whose client asked for non-stream: it still forces `stream:true` upstream and rebuilds the buffered reply (`resumable-forward.ts:consumeResumableSse` + `finalFromState`), so live monitoring (TTFT, thinking, prefill) works. That force is skipped on `n>1`/logprobs and for external or translated targets, where the rebuild would not be faithful.
- **Streaming** tees frames as they pass. OpenAI streaming injects `stream_options.include_usage` and strips the synthetic usage chunk again when the client did not ask for it.
- **Translated Anthropic streams** skip the meter entirely and report telemetry from the bridge emitter's `extensions` side-channel inside the translation transform (`docs/ANTHROPIC_OPENAI_BRIDGE.md`), so their streaming stats are recorded deferred at stream end rather than per frame.

The `cache`-node response store is managed out of band via `GET` / `DELETE /api/proxy/cache` (size / clear); see `docs/API_PROXY_RESPONSE_CACHE.md`.

## Scheduler Model

The scheduler is deliberately side-effect free. It receives a snapshot of targets and returns an ordered action list. A later executor should translate actions into existing operations:

- `start-instance` -> `ProcessSupervisor.start`
- `wait-instance-ready` -> health polling
- `save-slot` -> `requestLlamaSlotAction(..., "save", slotId, ...)`
- `restore-slot` -> `requestLlamaSlotAction(..., "restore", slotId, ...)`
- `unload-model` -> `requestLlamaModelAction(..., "unload", model)`
- `stop-instance` -> `ProcessSupervisor.stop`
- `load-model` -> `requestLlamaModelAction(..., "load", model)`
- `wait-model-ready` -> `/health`, `/props` or `/v1/models` polling
- `route-request` -> HTTP forwarding layer

The planner intentionally does not decide how long to poll, how to name slot save files or when saved-slot metadata should be updated. Those belong to the executor and persistent proxy state.

## Engine capability gating

Lifecycle actions and llama-specific forward-path features are gated on per-engine capabilities instead of assuming every managed target is a llama-server (`docs/ENGINE_ADAPTERS.md` defines the descriptor):

- **Plan input** — `ApiProxyTargetPlanInput.capabilities` carries `{modelLoadUnload, slotSave}`, populated by `buildApiProxyPlanRequest` from `proxyEngineGates(instance)` (`proxy/engine-capabilities.ts`; `null` instance ⇒ all false). The Zod default is `{true, true}` (llama-equivalent) so parsed fixtures keep today's behavior, but the inferred output type requires the field, forcing any new constructor to decide explicitly. The scheduler stays pure: `save-slot`/`restore-slot` require `slotSave`, and the unload split becomes `model && modelLoadUnload ? unload-model : stop-instance` (an engine without per-model unload falls back to stopping the process); `load-model`/`wait-model-ready` require `modelLoadUnload`, so `load` degrades to plain `start-instance` from `stopped`/`unknown` and to a `stop-instance` → `start-instance` restart cycle from `unloaded`. The executor needs no changes — it only runs actions the planner emitted, and `saveSlot`/`restoreSlot`/`unloadModel` callbacks are already optional.
- **Forward path** — `ApiProxyUpstreamContext.engine` (a `ProxyEngineGates`) is computed once per request in `resolveApiProxyUpstreamContext`. `streamResume` gates stream-session registration (see `docs/STREAM_RESUME.md`); `sseTimings` gates `return_progress` injection, prefill-progress wiring, and slot-tracker correlation (llama.cpp SSE extensions — on engines without them the metrics simply stay null, which is also today's graceful degradation for externals).
- **Concurrency and eviction** — `parseInstanceConcurrencyLimit` dispatches from the descriptor concurrency id (`--parallel`/`-np`, vLLM `--max-num-seqs`, or SGLang `--max-running-requests`). Persisted instance eviction policy further narrows a target's configured `preemptible` flag: `never` is immovable, `idle-only` is evictable only after active requests drain, and `preemptible` permits request-lease preemption. Descriptor `streamResume:false` also gates the mid-request resumable path itself.
- **Deferred seams** — cross-node delegation still injects `return_progress` before the sending node knows the remote engine (harmless; the delegate payload should carry capability flags); `stateFromHealth` in `proxy/runtime.ts` is the single spot where per-engine health→state mapping would plug in. The force-answer reasoning tail lives in `proxy/force-answer.ts` (`<think>` delimiters); reasoning-tag conventions are a property of the model, not the engine, so its eventual home is a per-model option.

## Request hot path: scheduling vs diagnostics snapshots

`getApiProxyRuntimeSnapshot` feeds both the planner and the UI, but those need different things, so it takes two orthogonal flags and the request path must stay read-only over background-reconciled state (a slow/unreachable target — remote rpc fabric, hung instance — must never sit on a request's critical path).

- `purpose` — `"scheduling"` skips the network start-preflight (`getInstanceHealthSummary({checkStartAvailability:false})`: no port-availability bind, no rpc-worker RTT) and reads remote-target health cache-only; `"diagnostics"` (default) computes full live health (preflight, logs, swap, numa, live remote) for the admin dashboard / `/api/proxy/runtime`. Both feed the same `buildApiProxyRuntimeSnapshot`, so there is one `state` derivation, not two. The public listing endpoints (`/v1/models`, `/api/public/status`) only need each target's `state`, so they serve `"scheduling"` + `"cached"` too — an infrequent probe must not pay a live multi-instance health fan-out (~1.6 s → ~4 ms).
- `residency` — `"cached"` reads per-instance scheduling health from `proxy/instance-health-cache.ts`; `"live"` (default) recomputes and writes the cache. The per-request initial plan context (`serveResolvedTarget` → `buildApiProxyPlanContext`) and the public listing endpoints (`getCachedApiProxyRuntimeSnapshot`, a 2 s memo over the scheduling snapshot) use `"cached"`; the executor's re-fetch after a start/load, fusion, idle and route-explain stay `"live"` so the executor observes its own actions.

`startApiProxyRuntimeReconcileLoop` (~1s) keeps the residency cache and the remote-health cache warm; `buildApiProxyPlanContext` builds the snapshot once per request and threads it through gateway → lease → readiness (the resumable path rebuilds a fresh preview only on preemption retries). Server-generation timing enrichment (`applyServerGenerationTiming`, sourced from llama-server log lines) is deferred off the response via `recordTraceWithDeferredTiming` and never blocks the client. Net effect: a ready local target proxies within ~15 ms of hitting the instance directly, flat in the number of targets / remote nodes / rpc workers.

See `proxy-latency` commit series and `docs/STATUS_LAYERS.md` (L2/L3) for the state derivation reused here.

## External providers

Connecting an external provider does not use the `target` layer. An endpoint is the upstream connection (base URL + profile + one optional key); a model routes straight to it via `routeTo: {type: "endpoint", endpointId, upstreamModel}`, and a `passthrough: true` endpoint exposes its whole catalog by name with no per-model record. Both resolve to a synthetic, non-persisted target (`proxy/external-target.ts`) so the gateway/lease/forwarder path is unchanged. Endpoint auth is a single key (stored `apiKey` XOR `apiKeyEnvVar`) with profile-derived placement and an `extraHeaders` record — no auth-type enum. Full details, including the `modelFilter` glob semantics and the `/models` catalog merge into `GET /v1/models`, are in `docs/EXTERNAL_PROVIDERS.md`.

## Next Implementation Step

The next safe step is to expand execution and add targeted file-based diagnostics when real failures require them:

- add guarded unload/preemption after the simple autostart path is stable.
