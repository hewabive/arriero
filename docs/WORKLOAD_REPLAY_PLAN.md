# Workload replay implementation plan

Working document. Delete it — and its CLAUDE.md pointer — when every phase is done.

The architecture is `docs/WORKLOAD_REPLAY.md`, decisions D1–D25. This plan orders the work and names
the integration points; it does not re-decide anything. Where a step needs a choice the architecture
leaves open, the step says so and proposes a default.

## Progress

| Phase | Steps | Status |
| --- | --- | --- |
| 1 — Session index and workload profile | 1.1–1.8 | pending |
| 2 — Datasets | 2.1–2.9 | pending |
| 3 — Replay mode | 3.1–3.11 | pending |

Mark a step done here in the commit that lands it.

## Ground rules

- **One step, one green commit** (or a short series), each passing `pnpm check`. A core schema lands
  with its first consumer. An export used only by tests passes knip here (`clearApiProxyTraceHistory`
  is imported only by tests), but if knip flags a step, merge it with its consumer.
- **Pure logic is separated from IO** and lands with its tests first: classification, linking,
  window ranking, segment selection, the dataset codec, the replay scheduler.
- **Nothing touches the proxy request path before phase 3**, and there only the reservation check,
  behind tests.
- **Docs change in the commit that changes behavior**: `docs/RUNTIME_LAYOUT.md` for tables and `data/`
  paths, the domain table in `apps/api/CLAUDE.md`, `docs/BENCHMARK.md`, `docs/API_PROXY_FOUNDATION.md`,
  `docs/ENGINE_ADAPTERS.md`, and the status line of `docs/WORKLOAD_REPLAY.md`.
- **Web has no tests**: every UI step is verified with `pnpm browse`. UI strings are English, sentence
  case, counts through `countLabel`, mutation errors through `notifyError`.
- **Do not edit `apps/api/src/jobs/`**: the job kernel is byte-identical with the update-kit
  repositories (`scripts/check-update-kit.mjs`); use its registry as is.

## Integration facts

Established 2026-09-27 at commit `231a21aa`, so no step has to rediscover them.

**Captures and traces**

- A capture file is read with `readApiProxyRequestFile(relativePath)` in
  `apps/api/src/proxy/request-files.ts` — synchronous, `null` on any failure. Its body is the inbound
  form at the capture node: not translated, not reasoning-mapped. The trace's `files` lists each file
  with its kind and relative path.
- A trace is inserted when the request completes (`insertApiProxyTrace`, called only by the stats
  observer), while `at` is the request start. Server timing enrichment defers some inserts further.
  There is no insert event; consumers poll.
- `listApiProxyTraces` pages newest-first with a timestamp-only `before` cursor;
  `listApiProxyTracesSince` is ascending and unbounded. Neither fits an indexer, so step 1.5 adds one.
- `pruneApiProxyTraceHistory` deletes traces and capture directories with a private cutoff helper and
  offers no hook to other stores. Trace rows are re-parsed with `parsePersistedJson`, and a row that no
  longer parses is dropped silently.

**Persistence, loops, jobs, routes**

- A table is declared twice, in `apps/api/src/db/schema.ts` and in `migrate()` in
  `apps/api/src/db/index.ts`; `apps/api/src/db/schema-migrate-parity.test.ts` enforces equality. The
  precedent for a derived table rebuilt on a version change is `model_cache` with `parser_version`
  (`apps/api/src/models/cache-repository.ts`).
- Loops: `startRetentionLoop` in `apps/api/src/db/retention.ts` wraps `startAsyncIntervalLoop` from
  `apps/api/src/utils/interval-loop.ts`, which skips overlapping ticks. Boot passes are direct calls in
  `apps/api/src/index.ts`, wrapped in `bootStep`; loops start there and stop in `shutdown()`.
- Jobs: `registerActiveJob({domain, jobId, entityId, cancel, completion})` in
  `apps/api/src/jobs/registry.ts` enforces one active job per `(domain, entityId)` and deregisters when
  `completion` settles; `shutdownActiveJobs` cancels all on shutdown.
- Routes: `register<Domain>Routes(app)` in `apps/api/src/routes/<domain>.routes.ts`, wired in
  `apps/api/src/http.ts`; bodies through `parseJsonBody`, queries through `Schema.safeParse`; `{data}`
  and `{error}`. No endpoint serves a file download or accepts an upload yet.
- Helpers: `canonicalJsonDigest` (`apps/api/src/utils/canonical-json.ts`), `atomicWriteFile`
  (`apps/api/src/utils/atomic-write.ts`), `assertPathWithinRoot` (`apps/api/src/utils/path-guard.ts`).
  No archive library is a dependency; `node:zlib` is available.
- Tests: `node:test`, files next to sources; a temp root per process from
  `apps/api/src/test/setup-env.ts`; fetch injected as `fetchImpl`; fake upstreams are inline
  `node:http` servers on `127.0.0.1:0`; route tests use `new Hono()` plus `app.request`.

**Benchmark**

- `startBenchmarkRun` in `apps/api/src/benchmark/runner.ts` resolves the instance, registers the job
  and starts the private `executeBenchmarkRun`. Mode checks are scattered through it (load collector,
  total requests, concurrency, warnings, event writer, analysis, server metrics) and through
  `runBenchmarkSchedule` in `apps/api/src/benchmark/schedule.ts`.
- Request failures are data today: a partial failure finishes `succeeded` with a warning. Progress
  phases live in an in-memory map. Warmup uses the first prompt with `WARMUP_MAX_TOKENS`.
- `runMeasuredRequest` (`apps/api/src/benchmark/measure-client.ts`) records timings, usage and llama
  timings, and classifies HTTP, in-stream, timeout, truncation and empty-output failures. **It does
  not record cached prompt tokens.**
- `BenchmarkLoadCollector` (`apps/api/src/benchmark/load-statistics.ts`) is mode-independent and
  groups by `promptId`; `createBenchmarkEventWriter` streams `events.jsonl`.
- `fromRow` in `apps/api/src/benchmark/repository.ts` drops a run row whose scenario no longer parses,
  so a scenario schema change must keep every stored scenario parsing.

**Proxy**

- `prepareApiProxyUpstreamRequest` does translation and reasoning mapping but **not** the model
  override; each caller applies it. `resolveApiProxyUpstreamContext` reads only a target's
  `endpointId`, `name` and `model`; `ephemeralTarget` in `apps/api/src/proxy/serve-pinned.ts` is the
  precedent for a synthetic target of an instance (endpoint id from `instanceEndpointId`).
- The SGLang rule "an absent cache-read count means zero" lives in the private
  `instanceOmitsZeroCacheRead` in `apps/api/src/proxy/upstream-context.ts`.
- `createApiProxyTokenCounter` (`apps/api/src/proxy/token-count.ts`) requires a persisted target;
  `tokenCountAdapters` is exported, its adapter type is not.
- `serveResolvedTarget` in `apps/api/src/proxy/protocol-endpoint.ts` serves persisted targets, the
  fusion synthesis route, endpoint-routed `instance:` endpoints and `/api/proxy/serve` delegations; its
  earliest point with a known target precedes the resume claim. Fusion panel branches
  (`executeApiProxyModelSubRequest`) and token-count probes bypass it.
- `ApiProxyProtocolDiagnostic` has a closed `code` union in `apps/api/src/proxy/protocol.ts` and no
  retry-after support; the drain gate sets `retry-after` itself before tracing.
- Pinning has one injection site: `buildApiProxyPlanRequest` in
  `apps/api/src/proxy/idle-maintenance.ts` sets `pinnedTargetIds`. The planner groups peer targets per
  instance, so every target id of an instance must be pinned.
- `computeDomainCoordinator.tryAcquireMaintenance(domains)` in
  `apps/api/src/proxy/domain-coordinator.ts` succeeds only when no holder or waiter overlaps, and
  while held no overlapping candidate is admitted.
- No helper lists the instances sharing a pool with an instance: pools come from `listMemoryPools()`,
  draws from each instance's `memory`, domains from `computeDomains` in
  `apps/api/src/proxy/resource-domains.ts`.
- `apiProxyInflight.snapshotByTarget()` in `apps/api/src/proxy/inflight.ts` is keyed by target id,
  carries no instance id and has no wait API; the update drain polls (`apps/api/src/update/adapter.ts`).

**Engines** (checked against llama.cpp b11118, vLLM 0.30.0, SGLang 0.5.20)

- Context size: llama.cpp `/props` → `default_generation_settings.n_ctx` (per slot) and `total_slots`;
  vLLM and SGLang `/v1/models` → `max_model_len`. No arriero code reads them over HTTP today.
- Cached prompt tokens: `usage.prompt_tokens_details.cached_tokens` on all three, read by
  `openaiCachedTokens` in `apps/api/src/proxy/usage-meter.ts`; SGLang only with
  `--enable-cache-report`.
- Flush primitives are listed in D18. Existing actions: `requestLlamaSlotAction` and
  `requestLlamaModelAction` (`apps/api/src/llama/model-actions.ts`), `restartManagedInstance`
  (`apps/api/src/process/managed-lifecycle.ts`), readiness polling in
  `apps/api/src/proxy/public-executor.ts`.

**Web**

- A Proxy tab is a leaf in the proxy section of `apps/web/src/ui/routing.ts` plus a branch in
  `apps/web/src/ui/views/ProxySection.tsx`; sub-paths follow the pipelines precedent.
- API modules call `nodeRequest` from `apps/web/src/api/http.ts`, use core types only as types, and
  are re-exported from `apps/web/src/api/client.ts`. `request` forces a JSON content type, so uploads
  need a raw helper (precedent: `apps/web/src/api/presets.ts`).
- No charting library: `MetricChart` (`apps/web/src/ui/components/MetricChart.tsx`, tones in
  `metric-palette.ts`) and `BenchmarkLoadTimeline` are hand-written SVG.
- `ProxyTracesView.tsx` is the pattern for filters, facets and cursor paging. The only download is a
  Blob in `InstanceDetailsMemoryPanel.tsx`; there is no upload anywhere.
- `BenchmarkRunForm.tsx`, `BenchmarkRunDetail.tsx`, `BenchmarkHeadline.tsx` and
  `BenchmarkRunsPanel.tsx` read `scenario.composition` and `repetitions`; a scenario union by mode
  breaks them at compile time, which is the intended guard.

## Phase 1 — Session index and workload profile

Read-only over existing data; no request-path change.

### 1.1 Pipeline node fact: request rewriting

- Add `rewritesRequest: boolean` to `PipelineNodeDescriptor` in
  `packages/core/src/proxy/pipeline-nodes.ts`: true for `replace-text`, `edit-request`, `reasoning`,
  `output-limit`, `token-scale`, `strip-attribution` (D3). The descriptor record is exhaustive by
  construction, so a new node type cannot skip the decision.
- Test the set against the D3 list.

### 1.2 Core contracts

- New `packages/core/src/workload.ts`, re-exported from the core barrel: the outcome enum
  `success | client-abort | not-served | error` (D5), record issues (capture after a rewriting node,
  unsupported operation, stateful Responses request, unreadable capture, non-object body), the record
  view, session summary and tree, profile window, window ranking, linking report, and the list
  queries.
- Lands with its first consumer (1.6).

### 1.3 Pure record analysis

In `apps/api/src/workload/`, no IO:

- **Outcome** from a trace (D5): `status`, `errorCode`, `streamHealth.truncated`, `cache`, and the
  route trace. Policy outcomes — cache hit or coalesced, gate and disabled-model codes,
  route and pipeline configuration codes, a `context-limit` rejection — are `not-served`; serving
  failures — `target_not_ready`, `plan_blocked`, `instance_start_failed`, `upstream_*`, upstream HTTP
  errors, truncation — are `error`; `client-abort` is its own class. Exhaustive over the closed code
  union so a new code fails compilation.
- **Capture choice and validity** (D3): the last `capture-request` file of the trace; invalid if a
  step whose node type `rewritesRequest` follows the last capture step, ignoring steps with
  `nodeId: null`.
- **Operation support** (D4).
- **Normalization and chain hash** (D9): `canonicalize`, `cache_control` removed at any depth,
  `sanitizeClaudeCodeAttribution` on a copy; root from tools plus the Anthropic `system`; per-message
  chain values; the key.
- **Cache metrics** (D10) for a same-target parent and child; **think time** (D20).
- Fixtures: an OpenAI agent session; a Claude Code session with `cch` churn and moving
  `cache_control`; an identical retry; compaction; a fork; a Responses request with
  `previous_response_id`; a capture followed by `edit-request`; a truncated stream; a client abort.

### 1.4 Index storage

- Tables in `schema.ts` and `migrate()`: `workload_records` and a single-row `workload_index_state`.
  Indicative columns: trace id (key), `at`, duration, source id and name, proxy model, target id and
  name, protocol, endpoint, outcome, issue, capture path, message count, chain key, parent trace id,
  shared messages, session id (root trace id), prompt, cache-read and completion tokens, TTFT, think
  time, cache loss, response reuse, normalization version. Indexes on
  `(source_id, model_id, chain_key)`, `(at)`, `(session_id, at)`.
- `apps/api/src/workload/repository.ts`: idempotent insert; parent lookup (same source — `null`
  matching `null` — and model, chain key among the child's chain values, earlier `at`, ordered by
  message count, `at`, trace id, all descending); prune by cutoff; drop rows whose trace is gone; drop
  all for a rebuild.
- Tests on the temp DB. `docs/RUNTIME_LAYOUT.md` lists the tables.

### 1.5 Indexer

- Proxy-owned reads, since the proxy owns traces: an ascending listing of traces carrying a
  `capture-request` file within `[from, to]`, ordered by `(at, id)` with a batch limit; an exported
  retention cutoff. The proxy never imports `workload`.
- A pass indexes traces whose request ended at least a settle interval ago (covering deferred trace
  inserts). It re-scans a trailing window (proposed: 6 h) and skips ids already indexed, so a long
  request inserted late is not lost, and it processes in `(at, id)` order. A child starts after its
  parent ended, so the parent is always indexed first.
- The same pass prunes rows past the trace cutoff and rows whose trace is gone. A normalization
  version change drops the index and rebuilds it from captures still on disk.
- A boot pass through `bootStep` plus a periodic loop with `onError` logging, stopped in `shutdown()`.
  Batches yield to the event loop between records; bodies can be hundreds of KB.
- Tests with captures written by `saveApiProxyRequestFile` and traces by `insertApiProxyTrace`:
  idempotency, a late insert inside the trailing window, prune, rebuild, and a missing capture file
  recorded as an issue.

### 1.6 Queries and API

- **Sessions**: list with filters (time, source, model, target) and `(at, id)` cursor paging; session
  tree with per-record fields and issues.
- **Profile timeline**: window length and step as parameters (proposed defaults: 15 min and 5 min).
  Per window: active sessions, requests, prompt size p50/p90, fresh and cached prefill, cached share,
  answer length p50/p90, time-weighted in-flight requests, errors, cache loss, response reuse.
- **Window ranking** (D12): windows with errors excluded. "Typical" — proposed metric: the sum over
  features of |log(window value / median over the period's windows)|, ascending. "Peak" — by in-flight
  requests, then fresh prefill.
- **Linking report**: link rate per source and model; where a captured Claude Code body carries a
  session identifier in `metadata.user_id`, agreement between reconstructed sessions and client
  sessions (the phase 1 acceptance measure).
- Routes in `apps/api/src/routes/workload.routes.ts`, wired in `http.ts`: `GET /api/workload/sessions`,
  `/sessions/:id`, `/profile`, `/windows`, `/linking`. Route tests.

### 1.7 Web: Workload tab

- Leaf `#/proxy/workload` and a `ProxySection.tsx` branch with sub-paths `profile` and `sessions`
  (`datasets` joins in 2.8). API module `apps/web/src/api/workload.ts`.
- Profile: a timeline built on `MetricChart` or the lane drawing of `BenchmarkLoadTimeline`, with new
  tones in `metric-palette.ts`; the window ranking with a typical/peak toggle; selecting a window
  keeps it for freezing in phase 2.
- Sessions: a table on the `ProxyTracesView` patterns, a session tree with record issues, and a
  linking report card.

### 1.8 Docs

- `workload` row in the domain table of `apps/api/CLAUDE.md`; `docs/RUNTIME_LAYOUT.md`; an HTTP API
  section in `docs/WORKLOAD_REPLAY.md` and its status line.

**Acceptance** (accepted): on a machine with its own inference and Claude Code traffic, the link rate
is reported per source and model, and where `metadata.user_id` carries a session identifier, linking
agrees with it. Proposed addition: indexing the machine's real volume raises no event-loop stall
verdicts in the system metrics.

**Not in scope:** datasets, replay, any request-path change.

## Phase 2 — Datasets

### 2.1 Selection to segments

Pure:

- For one or more windows and filters: the sessions active in each window. The measured records of a
  segment are the replayable records of the session inside the window.
- A window is selectable only when none of its records in scope is an `error` (D11). A `composed`
  selection may take segments from several windows, but a session never twice (D20).
- The priming record is the parent of the first measured record, or that parent's nearest ancestor
  whose outcome is `success` or `client-abort`; a session that starts inside the window has none
  (D19).
- Offsets from the window start and think times.
- Tests.

### 2.2 Dataset format

- Core schema for the manifest (D13): format version, normalization version, arriero version,
  selection, segments, per record the operation, top-level body fields, blob keys, timing, and the
  outcome and usage snapshot; priming references; the dataset and period profiles.
- A pure codec: messages, tools and system blocks become blobs keyed by the sha256 of their compact
  JSON; the body rebuilds JSON-equal. The dataset id is `canonicalJsonDigest` of the manifest.
- Round-trip tests on OpenAI, Anthropic and image-bearing bodies.

### 2.3 Store

- `data/workload-datasets/<id>/` holds `manifest.json` and `blobs/<hash>.json`. A dataset is written
  to a temporary directory and renamed when complete. Listing scans the root; paths are guarded with
  `assertPathWithinRoot`; loading can verify the hash.

### 2.4 Freeze job

- An in-process job (`registerActiveJob`, domain `workload`, one freeze at a time) with in-memory
  progress and cancellation. It reads captures through the proxy reader and snapshots index rows.
  Identical content yields the same id, so a repeated freeze is a no-op.

### 2.5 Export and import

- Export: one gzip file (`node:zlib`) holding the manifest and blobs, served with
  `Content-Disposition` — the API's first download endpoint, so the step defines the pattern.
- Import: a raw `application/gzip` body streamed to a temporary file under a size limit (proposed:
  2 GiB, a setting). It is then parsed and validated: schema, recomputed hash, blob names that are
  hashes, blob sizes. It is written atomically; a known id is a no-op.
- Federation: node-scoped paths pass through `apps/api/src/nodes/remote.ts`; verify binary bodies in
  both directions.
- Route tests: tampered hash, oversize body, traversal in blob names, duplicate import.

### 2.6 Routes

- `POST /api/workload/datasets` (freeze; progress by polling), `GET /api/workload/datasets`,
  `GET /api/workload/datasets/:id`, `DELETE /api/workload/datasets/:id`,
  `GET /api/workload/datasets/:id/export`, `POST /api/workload/datasets/import`.

### 2.7 Disk usage

- A datasets entry in `LogStorageUsageSchema` (`packages/core/src/logs.ts`) and in the usage handler
  of `apps/api/src/routes/logs.routes.ts`; a card in `MaintenanceView.tsx`. Retention never touches
  datasets.

### 2.8 Web: datasets

- Freeze the selected window (name and description), list, detail with the dataset profile next to
  the period, delete with `window.confirm`.
- Export as a link to the node-scoped URL. Import through Mantine `FileButton` and a new raw upload
  helper in `apps/web/src/api/http.ts`.

### 2.9 Docs

- `docs/RUNTIME_LAYOUT.md` (`data/workload-datasets/`), `docs/LOG_RETENTION.md` (never auto-deleted,
  counted in usage), status line.

**Acceptance** (proposed): a dataset exported on one machine and imported on another keeps its
content hash; a frozen dataset still loads and verifies after its sources are pruned.

**Not in scope:** the context check at selection time — it needs the instance probes of phase 3 and
lands in 3.5.

## Phase 3 — Replay mode

### 3.1 Proxy entry point: prepare a recorded request for an instance

- A proxy-domain function: an instance plus the recorded protocol, endpoint, route path and body in,
  the upstream path, prepared body, model override and the SGLang zero-cache flag out. It builds an
  ephemeral target as `serve-pinned.ts` does, then `resolveApiProxyUpstreamContext`, then
  `prepareApiProxyUpstreamRequest`, then the model override the way the live forwarder applies it
  (D2).
- Parity tests: for OpenAI and Anthropic bodies under the `llama-server` and `openai-compatible`
  dialects, the result equals what live forwarding sends.
- Extract the core of `createApiProxyTokenCounter` into an instance-level counter that needs no
  persisted target; the existing counter calls it. Existing token-count tests keep passing.

### 3.2 Proxy entry point: run reservation

- An in-memory reservation registry: reserve instances with the run id, label and expected end;
  release; look up by instance.
- A scope helper next to `computeDomains`: the instances sharing a pool with the benchmarked one. An
  instance without draws reserves only itself, and the run warns that neighbors are unknown.
- Admission: a new diagnostic code (for example `arriero_proxy_instance_reserved`) in the closed
  union. It is rendered by both adapters as HTTP 503 with `Retry-After`, and diagnostics gain
  retry-after support for it. The checks go in:
  - `serveResolvedTarget`, before the resume claim;
  - `executeApiProxyModelSubRequest`;
  - the instance-level counter, where a reserved instance counts as unavailable, so the node's
    `onUnavailable` policy applies.

  Target to instance goes through `resolveApiProxyTarget(...).instanceId` or
  `instanceIdFromEndpointId`.
- Pinning: `buildApiProxyPlanRequest` adds every target id whose instance is reserved.
- Drain and exclusion: poll `snapshotByTarget()` until no reserved target has an active entry (the
  update drain is the precedent). Then take `tryAcquireMaintenance` over the reserved domains and hold
  it for the run: anything that slipped past the checks queues instead of competing. On timeout the
  run fails, naming the requests still active.
- `GET /api/benchmark/reservation-preview?instance=` for the form: blocked models, neighbors, whether
  draws are declared.
- Tests:
  - rejection shape and `Retry-After` for both protocols;
  - a fusion panel aimed at a reserved target;
  - counter fallback;
  - pinned set;
  - drain wait;
  - exclusion by the maintenance lease.
- Docs: `docs/API_PROXY_FOUNDATION.md` (the gate beside the drain gate),
  `docs/RESOURCE_MANAGEMENT.md` (a benchmark as maintenance-lease holder).

### 3.3 Engine cache flush capability

- `benchmarkCacheFlush` in the engine descriptor, next to `benchmarkServerMetrics` (D18):
  - **llama.cpp:** a restart — in router mode, the model reloaded through `requestLlamaModelAction`.
    When the launched argv carries `--cache-ram 0`, erasing every slot from `/slots` through
    `requestLlamaSlotAction` is a full flush and replaces the restart.
  - **vLLM:** `reset_prefix_cache` with `reset_external=true` when the launch env has
    `VLLM_SERVER_DEV_MODE=1` and the host argument is loopback; the host comes via the descriptor's
    `hostArgKeys`. It is retried while it reports failure. Otherwise a restart.
  - **SGLang:** `/flush_cache`, retried while the server is busy; otherwise a restart.
  - **KTransformers:** a restart until its build's `/flush_cache` is verified.
- A restart uses `restartManagedInstance` and a readiness wait. It runs inside the reservation, which
  exempts the run's own actions.
- Tests: an inline fake server per engine, dev-mode and loopback gating, retries, and the restart path
  with a supervisor stub.
- Docs: the capability in the new-engine checklist of `docs/ENGINE_ADAPTERS.md`.

### 3.4 Measure client: cached prompt tokens

- `runMeasuredRequest` records `cachedPromptTokens` from usage through `openaiCachedTokens`, with the
  SGLang zero-cache flag from 3.1. `BenchmarkRequestResultSchema` gains the field, defaulting to
  `null` for old rows.
- It is needed by flush verification, per-segment prefill and the fidelity report, and is harmless for
  the existing modes.

### 3.5 Context check

- Context probe: llama.cpp `/props` (per-slot `n_ctx`); vLLM and SGLang `max_model_len` from
  `/v1/models`, which the runner already fetches.
- Count the largest prepared request of each segment, and its priming record, with the
  instance-level counter from 3.1; with the output ceiling added, that must fit (D22). KTransformers
  has no counting adapter, so its check is skipped with a warning.
- Exposed to phase 2 selection as a check of a dataset against a chosen instance.

### 3.6 Replay scheduler

Pure core, injectable clock:

- **Arrival plans:** `recorded` offsets, and `composed` — together, or at an interval — optionally
  capped in concurrency.
- **Order and think time:** strict per-segment order. The next send happens at the replayed answer's
  end plus the think time under the policy: `recorded`, `scaled`, `capped` or `none`.
- **Idle skipping:** the virtual clock jumps to the next event only while nothing is in flight.
- **Failure:** the first failure aborts everything — the abort pattern of `runBenchmarkSchedule`.
- **Priming sequencer:** the policy decides which segments are primed. They go in order of last
  activity before the window, sequentially, with `max_tokens: 1`, unmeasured.
- Tests with a fake clock:
  - a fast versus a slow executor shifts send times;
  - no skip while a request is in flight;
  - composed plans;
  - failure propagation;
  - priming order and policy.

### 3.7 Contracts and runner integration

- Core:
  - `replay` joins `BenchmarkModeSchema`, and `BenchmarkScenarioSchema` becomes a union by mode (D15).
    The replay branch carries the dataset id and hash, arrival plan, think-time policy, priming policy,
    output ceiling, abort imitation, timeout, sampling override and label.
  - The phases gain `flush` and `priming`.
  - The snapshot gains the dataset, the prepared-body hash, the replay parameters, the flush method and
    its verification, and the reserved models (D25).
  - Every addition has a default, and a test proves that stored scenarios of every existing mode still
    parse.
- A replay branch in `runner.ts`; its scattered mode checks become one dispatch. The branch runs:
  1. **prepare:**
     - load and verify the dataset;
     - prepare every body, the priming bodies included, and hash them in dataset order without
       per-run fields;
     - run the context check;
     - reserve and drain.
  2. **flush**
  3. **warmup:** synthetic, with its own prompt.
  4. **priming:** the first request verifies the flush, and a failed verification fails the run.
  5. **measure:**
     - the scheduler drives `runMeasuredRequest`;
     - `BenchmarkLoadCollector.record` takes the segment id as the group;
     - events are streamed;
     - the first failed request throws, and partial artifacts are kept.
  6. **finalize:** the reservation is released on every exit path.
- Bodies keep their recorded sampling unless the scenario pins it. `max_tokens` is the minimum of the
  recorded value and the ceiling. With abort imitation, a client-abort record is capped at its
  recorded partial output.
- `POST /api/benchmark/runs` validation for replay:
  - the dataset exists and its hash matches;
  - the instance serves HTTP;
  - a flush method resolves;
  - no run is active.
- Runner tests with a fake fetch cover:
  - the full lifecycle;
  - a failed verification;
  - a context failure;
  - a mid-run failure;
  - idle skipping;
  - release on every exit path.

### 3.8 Analyses

- The load summary and timeline from `BenchmarkLoadCollector`. Per segment: turns, fresh and cached
  prefill, TTFT p50/p95, decode rate, wall time. The fidelity report for the `recorded` plan:
  replayed against recorded cached and fresh prompt tokens per record, and the response-reuse deficit.
  llama.cpp draft acceptance as today. Result additions default for old rows (D24).

### 3.9 Web: replay

- Form:
  - `replay` in the mode control;
  - a dataset picker showing name, hash, segments and estimated duration;
  - arrival plan, think-time and priming policies;
  - output ceiling and abort imitation;
  - the reservation preview and the context check result.
- Results:
  - the replay header in `BenchmarkRunDetail.tsx`;
  - the load views as for sustained runs;
  - a per-segment table and a fidelity card;
  - the dataset and prepared-body hashes, so comparable runs are visible.

### 3.10 Docs

- `docs/BENCHMARK.md`: replay mode and its API. `docs/API_PROXY_FOUNDATION.md`,
  `docs/ENGINE_ADAPTERS.md` as above. `docs/WORKLOAD_REPLAY.md`: status "implemented".

### 3.11 Close the plan

- Delete this document and its `CLAUDE.md` pointer, and remove it from `workingDocuments` in
  `scripts/check-doc-claims.mjs`.

**Acceptance** (proposed):

- On llama.cpp, vLLM and SGLang: flush verification passes, and repeated runs of one dataset and
  scenario on an unchanged instance agree within a stated tolerance (proposed: TTFT p50 and output
  tokens per second within 5%).
- A proxy request to a reserved model during a run receives the 503 naming the run.
- One dataset replayed with MTP on and off, composed at concurrency 1, 2, 4 and 8, yields the gain
  curve.

**Not in scope:** an orchestrator for sweeps (runs are started one by one with a shared label;
orchestrated A/B stays on the benchmark roadmap); modeling sub-agent waits; phase classes over replay
timelines; capping output at the recorded answer length (an open question of the architecture).
