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
scenario `target` is a discriminated union with the single `{kind:"instance"}` variant today;
routing a run through a proxy model is a planned second variant.

The measurement base is **engine-agnostic**: everything is derived from client-observed SSE chunk
arrival times, which works for every `InstanceKind`. llama.cpp responses additionally carry a
`timings` object in the final chunk; it is consumed as **enrichment** (exact prefill duration,
`draft_n`/`draft_n_accepted` acceptance) and its absence degrades the run, never fails it.

## Methodology

Per request the measuring client (`measure-client.ts`, built on `api-lab/sse-parse.ts`) records
`submitMs`, per-chunk arrival times, and the final `usage`/`timings`. The phase model per request:

- `queued` — `[submitMs, firstTokenMs − prompt_ms)`, separable only when llama `timings.prompt_ms`
  is present; otherwise queue time is merged into prefill and `prefillStartMs` is `null`.
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

## Run lifecycle

`runner.ts` registers one in-process job (`jobs/registry.ts`, domain `benchmark`, single active run)
whose `cancel` aborts every in-flight fetch; graceful shutdown rides `shutdownActiveJobs`. Phases:
`prepare` (resolve endpoint via `runtimeEndpointInstance` so live launch-snapshot host/port win,
snapshot engine/model/args into the run, model id from `GET /v1/models`) → `warmup` (one short
request, excluded from stats) → `measure` (repetitions × wave; `parallel` fires the whole wave at
once, `sequential` runs it one by one for per-topic baselines) → `finalize` (segment, summarize,
persist). Cancellation persists partial results with status `canceled`.

**Cache busting**: with `cacheBust` (default on) every request gets a unique nonce line prepended to
its first message, so the llama.cpp prefix cache cannot make repeated runs incomparable. Disable it
deliberately to measure the warm-cache regime.

**Validity warnings** recorded on the run: llama slot capacity (`/props` `total_slots`) vs wave
concurrency — exceeding it queues requests and distorts TTFT; unknown slot capacity; unverifiable
capacity on non-llama engines.

## Prompt library

Built-in prompts live in `content/benchmark-prompts/<topic>/<lang>-<slug>.json`, validated against
`BenchmarkPromptSchema` (a test fails on any invalid file). Four topics × two languages × two
variants: `code` and `agentic` (tool-call transcripts) are high-draft-acceptance regimes, `poetry`
is the low-acceptance contrast, `rag` embeds ~9k+ chars of synthetic documents for the long-prefill
regime. Custom prompts are portable config in `config/benchmark/prompts.json` (config-store id
`benchmark:prompts`); builtin ids shadow custom ones and builtin prompts refuse edit/delete.

## Storage

`benchmark_runs` (SQLite) holds the run record: status, scenario, target snapshot (engine, model,
launch args — machine-local evidence, like `memory_assessments`), warnings and the compact summary
used by lists and future run comparison. Bulky data — the raw event stream and the full result
(per-request metrics + segments) — are artifacts in `data/benchmarks/<runId>/`
(`events.jsonl`, `result.json`), deleted with the run; there is no automatic retention. Runs left
`running` by a crash are failed at boot (`failInterruptedBenchmarkRuns`).

## Interpreting results

- **Phase mix table**: the per-request tok/s drop between `(0, k)` and `(p, k)` classes is the
  measured cost of concurrent prefill.
- **Topics table**: solo vs contended tok/s per topic; with a draft model configured, acceptance
  explains why code decodes faster than poetry on the same instance.
- **Timeline**: shaded bands mark intervals where a prefill competes for batch capacity; the bottom
  lane is total decode tok/s per segment.
- Caveats: client timestamps include localhost network jitter (negligible at ms scale); sampling
  temperature affects draft acceptance, so pin `sampling` when comparing runs; compare runs only
  with matching snapshots (the snapshot records launch args precisely for this).

## A/B foundation and roadmap

Runs carry a free-form `label` and the full target snapshot, and summaries are stored
comparison-ready — comparing "draft on/off" today means two manual runs against a reconfigured
instance. Planned, in rough order: run-comparison UI; `sustained`/`staggered` load patterns
(scenario `mode` is an extensible enum); GPU/system-metrics overlay from the 1 Hz recorder;
proxy-path target variant; orchestrated A/B (restart instance with argument variations between
runs).
