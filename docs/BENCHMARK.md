# Inference benchmark

The `benchmark` domain (`apps/api/src/benchmark/`, web view `#/benchmark`) measures decode
throughput of a managed instance under controlled load, with the timeline attributed to
prefill/decode phases per concurrent request. It exists because speculative decoding makes decode
speed content-dependent (draft acceptance is high for code and tool-call JSON, low for poetry), and
because continuous batching makes one request's prefill degrade every other request's decode rate —
so a single aggregate tok/s number hides exactly the effects worth measuring.

## Scope and target

MVP measures **directly against the instance endpoint** (`/v1/chat/completions`, streaming), not
through the proxy: the numbers describe the engine, with no gateway/lease/pipeline overhead. The
scenario `target` carries a `kind` discriminator with the single `"instance"` value today;
routing a run through a proxy model is a planned second kind (the schema becomes a discriminated
union when it lands).

The measurement base is **engine-agnostic**: everything is derived from client-observed SSE chunk
arrival times, which works for every `InstanceKind`. llama.cpp responses additionally carry a
`timings` object in the final chunk; it is consumed as **enrichment** (exact prefill duration,
`draft_n`/`draft_n_accepted` acceptance) and its absence degrades the run, never fails it.

vLLM publishes no per-request timings in the stream, so its enrichment source is the Prometheus
endpoint: the runner snapshots the `vllm:request_prefill_time_seconds` histogram totals around each
request and attributes the sum delta as that request's server prefill duration
(`benchmark/server-metrics.ts`, selected per engine by
`engineDescriptor(kind).benchmarkServerMetrics`). Attribution needs exactly one finished request
between snapshots, so the scrape runs only when requests never overlap (`sequential` mode or a
single-request wave); a delta whose count moved by anything but one (external traffic, a server
restart) is discarded, and the after-snapshot retries briefly because vLLM observes the histogram at
request finish, slightly after the stream closes. The warmup request is drained through the same
path so its late observation cannot pollute the first measured delta. A failed or unavailable
scrape degrades to the no-timings behavior; queue-vs-prefill precision beyond this and draft
acceptance stay llama-only.

## Methodology

Per request the measuring client (`measure-client.ts`, built on `api-lab/sse-parse.ts`) records
`submitMs`, per-chunk arrival times, and the final `usage`/`timings`. The phase model per request:

- `queued` — `[submitMs, firstTokenMs − promptMs)`, separable only when a server prefill duration
  is known (llama `timings.prompt_ms`, or the vLLM metrics delta); otherwise queue time is merged
  into prefill and `prefillStartMs` is `null`.
- `prefill` — up to the first content chunk.
- `decode` — first content chunk to the last one. The first chunk itself is attributed to prefill
  completion (standard TPOT convention), so per-request decode rate is
  `(chunks − 1) × tokensPerChunk / (doneMs − firstTokenMs)`.

**Chunk calibration**: engines may emit more than one token per SSE chunk, so
`tokensPerChunk = completion_tokens / chunkCount` per request (≈1 for llama.cpp). Chunk counts are
the measurement; usage reconciles them into tokens.

**Segmentation** (`segmenter.ts`, pure and heavily unit-tested): all phase-transition instants of
all requests in a repetition cut the timeline into segments; within a segment the set of prefilling
and decoding requests is constant, so each segment is classified `(prefillCount, decodeCount)`.
Chunk timestamps assign decoded tokens to segments (a speculative burst arriving exactly at a
boundary lands in the later segment; a chunk at `doneMs` lands in the request's last segment).
Aggregation over segment classes yields the headline table — time share, total and per-request
decode tok/s for "pure decode with k requests" vs "k decoding while p prefilling". Per-topic
summaries split each request's decode time into **solo** (sole decoder, no prefill active) and
**contended** segments, giving isolated vs under-load rates per topic, plus draft acceptance
weighted by drafted tokens. Repetitions (waves) segment independently; segments never span waves.

**Class support and the solo baseline** (`isBenchmarkRateSupported` / `isBenchmarkClassSupported` /
`soloDecodeBaseline`, core): a phase-transition instant that nearly coincides with another produces
a sliver segment whose rate is arithmetic noise (one chunk over 1 ms reads as 1000 tok/s). The
error of a class rate has two parts — chunk quantization (≈ `1/chunkCount`, set by tokens) and
boundary-timestamp jitter (≈ a few ms over the wall, set by duration) — so a rate qualifies by
either of two gates. The wall gate (`BENCHMARK_CLASS_MIN_WALL_MS`) is wall time alone, because a
long class with very few tokens (decode nearly frozen behind a competing prefill) is a real
measurement, not noise. The fast gate (`BENCHMARK_FAST_RATE_MIN_TOKENS` over at least
`BENCHMARK_CLASS_FAST_MIN_WALL_MS`) admits the short-but-token-dense stretches a fast engine
produces — 32 tokens bound quantization error at ~3%, the wall floor bounds jitter, and a sliver
can never reach the token minimum. The `(0,1)` class doubles as the **solo baseline** every
contention number is compared against, so promoting it is stricter on both paths — an understated
baseline would invert every comparison: `BENCHMARK_BASELINE_MIN_WALL_MS` with
`BENCHMARK_BASELINE_MIN_TOKENS`, or the fast token minimum over
`BENCHMARK_BASELINE_FAST_MIN_WALL_MS`. A run without a qualifying solo stretch reports no baseline
rather than a plausible substitute. The fast gate is a monotone relaxation: no rate reported under
the wall-only rule disappears, and since the web recomputes class support from stored
`segmentClasses`, phase-mix rows of pre-existing runs may light up while their persisted
topic/headline numbers stay as recorded.

**Headline metrics** (`BenchmarkRunSummary.headline`) are the run's answer in one row: aggregate and
per-request decode tok/s over decode-active time, the solo baseline, prefill tok/s (prompt tokens
over prefill duration, server-timings only — llama SSE timings or the vLLM metrics delta), total
prompt tokens, TTFT p50/p95 and peak concurrent decode. `null` on runs recorded before the field existed — the field defaults to `null` on parse so
old rows keep loading.

## Run lifecycle

`runner.ts` registers one in-process job (`jobs/registry.ts`, domain `benchmark`, single active run)
whose `cancel` aborts every in-flight fetch; graceful shutdown rides `shutdownActiveJobs`. Phases:
`prepare` (resolve endpoint via `runtimeEndpointInstance` so live launch-snapshot host/port win,
snapshot the full launch configuration into the run, model id from `GET /v1/models`) → `warmup` (one
request with a short output limit, excluded from stats) → `measure` (repetitions × wave; `parallel` fires the whole wave at
once, `sequential` runs it one by one for per-topic baselines; `sustained` continuously replenishes
clients to a shared request limit) → `finalize` (segment or aggregate, summarize,
persist). Cancellation persists partial results with status `canceled`.

### Sustained load

`mode: "sustained"` keeps a fixed population of independent clients. Each composition entry's
`count` is its client count; every client repeats that entry's prompt immediately after its
previous request finishes. A shared `totalRequests` budget counts submitted requests, including
failures and timeouts. It must cover the initial population and may be at most 100,000. There is
no wave barrier: fast clients can submit more requests while a slow client is still prefilling.
The mix therefore fixes concurrent clients per prompt, not the proportion of completed requests.
Once the budget is exhausted, outstanding requests drain. `repetitions` must be 1 in this mode.

For example, 24 clients with a short input and a long output limit plus 8 clients with a large
document and a short output limit sustain decode alongside incoming prefill work. Each prompt's
`maxTokens` controls its output limit (the API's optional `maxTokensOverride` overrides all groups).
`prefillClass` is descriptive metadata: selecting `long` does not enlarge the input. Actual input
length comes from the messages and the engine's tokenizer. Keep `cacheBust` enabled to exercise
fresh prefixes. Engine scheduling and available KV capacity still determine what runs concurrently;
client concurrency includes queued requests. The target remains the direct instance endpoint.

`requestTimeoutMs` applies to each measured inference request and the warmup in every mode,
including streaming. It defaults to 300,000 ms and accepts 1,000–3,600,000 ms. A timeout fails that
request and frees its client for the next request; cancel aborts every outstanding request and
stops replenishment. A scheduler/storage failure also aborts and drains siblings before finalizing.
The `endedMs` timestamp measures actual stream termination or failure, while `doneMs` retains the
last-output-chunk meaning used by decode analysis. Both timestamps survive partial failures.
Premature stream closure without a finish reason or `[DONE]`, and successful responses with no
generated content, are recorded as request failures.

Sustained runs use `summary.load` and `result.loadTimeline` instead of the wave segment analysis:

- Successful requests/s and successful output tokens/s use the full interval from first submission
  to last request termination, including queueing, replenishment gaps and failed-request time.
  Output throughput is unknown if a successful request lacks token counts; chunk counts are never
  presented as measured token throughput in these load metrics.
- TTFT and end-to-end latency p50/p95/p99 use successful requests. Timeout and cancellation counts
  remain visible separately. `maxChunkGapMs` is the longest interval between consecutive output
  chunks, including partial failed streams; it is not exact inter-token latency when chunks contain
  multiple tokens. Per-prompt summaries expose tail latency and pauses separately for each group.
- Timeline buckets start at 1 second and merge pairwise as the run grows, retaining at most 600
  buckets. Successful output tokens are calibrated across that request's observed chunk arrivals.
  In-flight and awaiting-first-output curves are time-weighted client counts; the latter includes
  server queueing and must not be interpreted as a measured number of active GPU prefills.
- Selecting an interval opens the existing request timeline for overlapping requests, paginated
  in groups of 50. Each request retains its timings, token counts, errors and average decode rate.
  Sustained runs do not retain the wave-only phase-class/solo-baseline analysis. Where per-request
  server timings are unavailable, request bars explicitly combine queueing and prefill.

The scheduler is `benchmark/schedule.ts`; the compact load collector is
`benchmark/load-statistics.ts`. Completed requests append their raw events to `events.jsonl`
through one serialized asynchronous writer before the client continues, then release their chunk
arrays. Memory scales with request metadata, the bounded overview and in-flight outputs, rather
than all output chunks from the run. Disk write backpressure can reduce offered load; this is a
closed-loop client test, not an independent fixed-arrival-rate generator. A hard manager crash can
lose events belonging to requests that had not yet completed.

**Cache busting**: with `cacheBust` (default on) every request gets a unique nonce line prepended to
its first message, so the llama.cpp prefix cache cannot make repeated runs incomparable. Disable it
deliberately to measure the warm-cache regime.

**Target snapshot is the launched configuration, not the config file.** Beyond engine/model/args,
the snapshot records `env`, `numa`, `rpcWorkers`, the actual launch argv (`launchCliArgs`) and the
llama.cpp `build_info` from `/props` (`null` on other engines) — all performance-relevant, none
visible in `args` alone. When the target has a live process run, `env`/`numa`/`rpcWorkers`/
`launchCliArgs` come from its launch snapshot (`activeLaunchSnapshot`) — the truth of the running
process — falling back to the instance config otherwise; `binaryPath` alone does not identify a
build (rebuild-in-place keeps the path), which is what `buildInfo` is for. All snapshot additions
are defaulted in the schema so pre-existing run rows keep loading.

**Validity warnings** recorded on the run: llama slot capacity (`/props` `total_slots`) vs wave
concurrency — exceeding it queues requests and distorts TTFT; unknown slot capacity; unverifiable
capacity on non-llama engines; instance config drifted from the running process
(`hasLaunchSnapshotDrift` — the snapshot records the launched configuration, so the drifted config
file cannot poison run comparison).

**In-stream errors fail their request — and escalate to the run.** An engine can accept a stream
and then abort it mid-flight (llama.cpp `send_error`, e.g. `Context size has been exceeded.` when
concurrent prompts overflow the shared KV cache). Those frames carry an `error` object rather than
a delta, so `measure-client.ts` matches them explicitly and records the request as failed with the
upstream message; without that the whole wave measured as a silent zero and the run still reported
`succeeded`. Request failures then surface on the run record: any non-canceled failed request adds
a warning (`N of M requests failed: <deduplicated messages>`), and when **every** request failed
the run finishes `failed` with that message as its `error` — so `status:"succeeded"` always means
at least one measured request. Partial failures stay `succeeded` (the surviving requests are a
valid measurement) with the loss visible in `summary.failedRequestCount` and the warning.

## HTTP API

Admin-gated under `/api/benchmark/*` (open by default in local dev). Responses are `{ data }` /
`{ error }`; every shape is a core Zod schema in `packages/core/src/benchmark.ts`.

- `GET /api/benchmark/prompts` — full prompt library, builtin + custom, message bodies included
  (~100 KB with the builtin RAG prompts). `?meta=true` drops `messages` and returns
  id/title/topic/language/prefillClass/maxTokens/source — enough to build a composition without
  paying for prompt bodies.
- `POST /api/benchmark/prompts`, `PUT`/`DELETE /api/benchmark/prompts/:id` — custom prompt CRUD;
  builtin ids refuse create-duplicate/edit/delete with 409.
- `POST /api/benchmark/runs` — start a run from a `BenchmarkScenario`. Validation is synchronous:
  an unknown prompt or instance, an instance without an HTTP endpoint, or an already active run
  fails the POST (400/404/409) instead of surfacing later as a failed run. Returns the created run
  with `status:"running"`.
- `GET /api/benchmark/runs?limit=&status=&label=` — newest-first list; `status` filters by job
  status, `label` is an exact match (A/B groups by label).
- `GET /api/benchmark/runs/:id` — the run record; while running it carries `progress`
  (phase, completed/total/active requests, repetition). `?waitMs=<1..60000>` long-polls: the
  response returns as soon as the run finishes (or at the deadline, still `running` with live
  progress), so a client waits without a tight poll loop.
- `GET /api/benchmark/runs/:id/result` — full per-request metrics + segments (`result.json`).
- `GET /api/benchmark/runs/:id/events` — the raw stream-event artifact (`events.jsonl`) as JSON.
- `POST /api/benchmark/runs/:id/cancel` (409 unless running), `DELETE /api/benchmark/runs/:id`
  (409 while running; removes artifacts).

Minimal client loop:

```bash
curl -s localhost:8787/api/benchmark/runs -X POST -H 'content-type: application/json' -d '{
  "target": { "kind": "instance", "instanceName": "my-instance" },
  "mode": "parallel",
  "composition": [{ "promptId": "code-en-task-queue", "count": 2 }]
}'
curl -s "localhost:8787/api/benchmark/runs/<id>?waitMs=60000"
```

For wave runs, the answer is `summary.headline`; per-topic and phase-mix breakdowns are `summary.topics` /
`summary.segmentClasses`, and run-level failure semantics are described under Run lifecycle.

A sustained run uses the same endpoint with `"mode":"sustained"` and `"totalRequests":2000`;
its composition counts define the clients per prompt, and its primary metrics are `summary.load`.
The web form exposes the request timeout in seconds; the HTTP API takes milliseconds.

## Prompt library

Built-in prompts live in `content/benchmark-prompts/<topic>/<lang>-<slug>.json`, validated against
`BenchmarkPromptSchema` (a test fails on any invalid file). Four topics × two languages × two
variants: `code` and `agentic` (tool-call transcripts) are high-draft-acceptance regimes, `poetry`
is the low-acceptance contrast, `rag` embeds ~9k+ chars of synthetic documents for the long-prefill
regime. Custom prompts are portable config in `config/benchmark/prompts.json` (config-store id
`benchmark:prompts`); builtin ids shadow custom ones and builtin prompts refuse edit/delete.

## Storage

`benchmark_runs` (SQLite) holds the run record: status, scenario, target snapshot (engine, model,
launch args/env/numa/rpc workers, actual argv, llama build info — machine-local evidence, like
`memory_assessments`), warnings and the compact summary used by lists and future run comparison. Bulky data — the raw event stream and the full result
(per-request metrics + segments) — are artifacts in `data/benchmarks/<runId>/`
(`events.jsonl`, `result.json`), deleted with the run; there is no automatic retention. In sustained
mode the event file is appended during measurement and the compact result is written at finalize.
Runs left
`running` by a crash are failed at boot (`failInterruptedBenchmarkRuns`).

The finalized run record is additionally mirrored into the artifacts dir as `run.json`
(`writeBenchmarkRunRecord`), making the dir self-contained evidence: the DB is recreatable by
design, and a `result.json` without its snapshot (model, launch args) or headline is
uninterpretable — the mirror keeps an archived or orphaned run dir meaningful and leaves the door
open for re-import. The DB stays the serving source (`run.json` is written, never read, on the
request path). A run that fails before producing any measurement writes no artifacts at all — its
DB record is the only trace, and there is nothing measured to preserve. Sustained runs may leave
an empty event file if canceled between warmup and the first submission. A crash inside the
finalize window can leave a dir without `run.json`; boot then fails the interrupted DB row as
usual and the incomplete dir is detectable by the missing file.

## Interpreting results

- **Phase mix table**: the per-request tok/s drop between `(0, k)` and `(p, k)` classes is the
  measured cost of concurrent prefill.
- **Topics table**: solo vs contended tok/s per topic; with a draft model configured, acceptance
  explains why code decodes faster than poetry on the same instance.
- **Timeline** (`BenchmarkTimeline.tsx`): one Gantt row per request (queue · prefill · decode) with
  TTFT and tok/s in a right-hand column. Each decode bar is cut into its segments and **each slice's
  opacity encodes that segment's per-request rate against the solo baseline** — the batching cost is
  visible inside the bar, at the instant it happens, instead of only in the phase-mix table. Shaded
  bands (plus a marker strip above the rows) mark intervals where a prefill competes for batch
  capacity, their tint scaling with the number of concurrent prefills. The bottom lane plots two
  step lines — total and per-request decode tok/s — against a dashed solo-baseline rule; it is
  hidden when the wave has fewer than two decode-active segments, where it would carry no
  information. Hovering anywhere gives a crosshair and one tooltip carrying the segment under the
  cursor (its class and both rates) and, over a row, that request's phase breakdown. Requests that
  never produced a token still get a row with an error marker. With no qualifying solo baseline the
  opacity encoding and the dashed rule are dropped rather than computed against a guess.
- Caveats: client timestamps include localhost network jitter (negligible at ms scale); sampling
  temperature affects draft acceptance, so pin `sampling` when comparing runs; compare runs only
  with matching snapshots (the snapshot records launch args precisely for this).

## A/B foundation and roadmap

Runs carry a free-form `label` and the full target snapshot, and summaries are stored
comparison-ready — comparing "draft on/off" today means two manual runs against a reconfigured
instance. Planned, in rough order: run-comparison UI; fixed-arrival-rate / staggered load patterns
(scenario `mode` is an extensible enum); GPU/system-metrics overlay from the 1 Hz recorder;
proxy-path target variant; orchestrated A/B (restart instance with argument variations between
runs).
