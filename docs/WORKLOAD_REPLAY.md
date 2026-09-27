# Workload replay: benchmarking on recorded proxy traffic

**Status: architecture accepted 2026-09-27, not implemented.** This document fixes the architecture
of the feature; the implementation plan is the working document `docs/WORKLOAD_REPLAY_PLAN.md`.
Everything below describes intended behavior unless it cites existing code.

## Why

The benchmark (`docs/BENCHMARK.md`) measures an instance on a synthetic prompt library with a
cache-busting nonce on every request. For the agentic workloads this project serves, those numbers
drift from real work:

- speculative decoding (MTP, draft models) makes decode speed depend on content — the real mix of
  tool-call JSON, code and prose sets draft acceptance, not a curated prompt set;
- the gain from speculative decoding depends on batch size — largest when few requests decode at
  once, shrinking as concurrency grows — so the real concurrency pattern matters as much as content;
- agentic traffic is bound by the prefix cache: every request of a session resends the whole
  history, so real TTFT depends on how much of it the engine still holds. `cacheBust`
  (`apps/api/src/benchmark/runner.ts:chatRequestBody`) destroys that regime on purpose.

The proxy already records request bodies (`capture-request` nodes) and per-request telemetry
(traces). Workload replay feeds recorded agent sessions back into an engine: each request is sent as
recorded, the engine generates a fresh answer that is measured and discarded, and the next request
is again taken verbatim from the next record, whose history carries the originally recorded answer.

Cross-references: `docs/BENCHMARK.md` (measurement, run records), `docs/API_PROXY_PIPELINES.md`
(capture semantics, route trace), `docs/API_PROXY_FOUNDATION.md` (traces, telemetry, request
sources), `docs/ANTHROPIC_OPENAI_BRIDGE.md` (translation, attribution), `docs/RESOURCE_MANAGEMENT.md`
(resource pools), `docs/LOG_RETENTION.md` (what is deleted and when).

## Terms

- **Record** — one `capture-request` file joined with the trace of the same `traceId`.
- **Session** — a tree of records linked by shared message prefixes (D9).
- **Window** — an interval of recorded time chosen for a benchmark.
- **Segment** — the records of one session that fall inside a window; the unit of a dataset.
- **Priming record** — the record that restores a segment's cache state before measurement (D19).
- **Dataset** — an immutable, content-hashed, portable set of segments (D13).
- **Arrival plan** — when each segment starts during a replay run (D20).
- **Think time** — the recorded pause between the end of an answer and the next request of the same
  session (D20).
- **Replay run** — a benchmark run in `mode: "replay"`, whose workload is a dataset (D15).

## Goals and non-goals

Goals:

- benchmark an instance on the recorded workload of the machine it serves: real content for draft
  acceptance, real prefix sharing, real overlap of sessions;
- short runs over characteristic, error-free windows rather than multi-hour replays;
- what-if runs under load that never occurred, composed from sessions of different periods;
- workload analytics (sessions, cache behavior, pauses, load over time) as a layer that is useful on
  its own and is also the tool that selects benchmark data.

Non-goals: benchmarking the proxy itself (the replay reuses only the proxy's request preparation;
routing a run through a proxy model remains the separate proxy-path target on the benchmark
roadmap); reproducing tool execution; modeling dependencies between sessions (§ Known limitations);
fusion branches and federation-delegated requests.

## The replay model and its known deviation

In live serving the engine produces answer A for request N and, when the chat template renders the
next request's history token-identically, can serve A from its KV cache when request N+1 arrives. In
replay the engine produces a fresh answer A′ while request N+1, taken from the record, carries A. The
shared prefix ends where A′ and A diverge, and the engine prefills the rest of A. Replay can
therefore overstate prefill by up to one previous answer per turn.

The deviation is measured, not assumed: the response reuse of recorded traffic (D10) shows how much
of it real work actually had. It depends on the template, the client and the engine — a template
that renders history differently from how the answer was generated (prior reasoning stripped, tool
calls reformatted) defeats the reuse in live serving too. The exploratory pass found no reuse at
all, on a cloud-provider sample (§ Evidence).

Rejected alternative: splicing A′ into the history of request N+1. The recorded tool results answer
the tool calls of A, ids included; splicing breaks `tool_call_id` / `tool_use_id` pairing and the
coherence of the conversation.

## Architecture overview

```text
proxy (existing)                     workload (new domain)                benchmark (existing)

capture-request files ─┐
                       ├─► indexer ─► session index (SQLite, derived)
proxy_request_traces ──┘                    │
                                            ├─► profile timeline, window finder
                                            └─► freeze job ─► dataset files ─► mode "replay"

proxy entry point: prepare a recorded request for an instance ◄──────────────── mode "replay"
proxy entry point: run reservation (admission gate, target pinning) ◄────────── mode "replay"
engine descriptor: cache flush capability ◄──────────────────────────────────── mode "replay"
```

Dependencies point one way: `benchmark` → `workload` → `proxy` (read-only), and `benchmark` →
`proxy` through two narrow proxy-owned entry points. The proxy never imports `workload` or
`benchmark`, and the only new code on the request path is the reservation check (D17). New shapes are
core schemas first (`packages/core`), as everywhere in the repository.

- **`proxy`** keeps owning captures (`apps/api/src/proxy/request-files.ts:saveApiProxyRequestFile`,
  read back through `apps/api/src/proxy/request-files.ts:readApiProxyRequestFile`), traces
  (`apps/api/src/proxy/traces-repository.ts`) and forward preparation. It gains a function that
  prepares a recorded request for a given instance (D2) and the run reservation (D17).
- **`workload`** (`apps/api/src/workload/`) owns the indexer, the session index, profile and window
  queries, and datasets: freeze, import, export. Its admin-gated routes live under `/api/workload/*`;
  its UI is a tab in the Proxy section. State is per node: datasets move between nodes and machines
  by export and import.
- **`benchmark`** gains `mode: "replay"`: its scheduler, cache flush, priming, pacing and analyses.

## Decisions

### Recording and records

**D1. The input is the existing `capture-request` record.** Continuous recording through
`capture-request` is proven in practice; no dedicated recorder is planned. The request file holds the
body; the trace of the same `traceId`
(`packages/core/src/proxy/api-proxy.ts:ApiProxyRequestTraceSchema`) holds arrival time, duration,
source, target, status, cache outcome, the resume flag and usage — prompt, cache-read and completion
tokens, TTFT, rate.

**D2. A record holds the post-pipeline, pre-forward body — the target-agnostic form.** After the last
node, forwarding still runs `apps/api/src/proxy/reasoning-request.ts:prepareApiProxyUpstreamRequest`
(Anthropic → OpenAI translation in the engine's dialect, then reasoning mapping onto the upstream's
native interface), overrides `model`, injects telemetry fields, may force upstream streaming and,
after preemption, resends with an assistant prefill. All of these are properties of the target, not
of the workload. The replay repeats them for the benchmark instance through one narrow proxy-owned
function, so neither `workload` nor `benchmark` imports proxy internals. The token counter
(`apps/api/src/proxy/token-count.ts:createApiProxyTokenCounter`) and fusion sub-requests
(`apps/api/src/proxy/fusion.ts:executeApiProxyModelSubRequest`) already prepare one body for a chosen
upstream the same way. One dataset therefore replays against llama.cpp, vLLM or SGLang, and each
engine receives what the proxy would have sent it.

**D3. Capture placement is an operator convention; validity is verified per record.** A capture is
valid when no request-rewriting node runs after it: `replace-text`, `edit-request`, `reasoning`,
`output-limit`, `token-scale`, `strip-attribution`. A `capture-request` visit appends its own step to
`routeTrace` (`apps/api/src/proxy/pipeline.ts:resolveApiProxyRouteChain`), so the indexer finds the
last capture step and marks the record invalid when a rewriting node follows it. Conservatively,
every visit of a rewriting type counts, including a no-op or response-only one; moving the capture
node after it restores validity. The reasoning step appended at the forward boundary (`nodeId: null`)
is not a node. Which types rewrite becomes a per-type fact in
`packages/core/src/proxy/pipeline-nodes.ts:PIPELINE_NODE_DESCRIPTORS`, so no future node type stays
unclassified.

**D4. Replayable operations.** OpenAI Chat Completions and Anthropic Messages carry the full history
in every request. Excluded: OpenAI Responses (a request with `previous_response_id` keeps its history
on the upstream server — 14 of 34 Responses captures in the exploratory pass — and the measuring
client parses only the chat stream), `messages.count_tokens`, embeddings and rerank. Requests the
engine never served — proxy response-cache hits, coalesced followers, gate and pipeline rejections —
stay in the session structure but are never replayed.

**D5. Outcome classes.** A record is a _success_ when the client received HTTP 2xx, however the
generation ended: manual Finish or Force answer, a loop-guard cut, `finish_reason: length`, a resume
after preemption. A _client abort_ is a normal scenario and stays in the data. A proxy policy
outcome that never reached an engine — the cases listed in D4, including a `context-limit`
rejection — is _not served_: it is never replayed and does not make a window erroneous. Any other
non-2xx status is an _error_, including a request the serving system failed to serve (target not
ready, blocked plan, failed instance start, unavailable or timed-out upstream), and so is a truncated
stream (no protocol terminal, `trace.streamHealth.truncated`): the engine failed even though the 200
status had already been sent.

**D6. Record on the machine that is benchmarked.** Its traces then hold the same engine's usage — the
baseline the replay is checked against (D24). Records from another machine or an external provider
serve only as a prompt source: there is no baseline, histories contain another model's answers,
contexts may not fit the local model (D22), and recorded cache hits describe another engine.

### Session index

**D7. A new `workload` domain owns sessions and datasets** (§ Architecture overview).

**D8. The session index is persisted, derived and rebuildable.** A background indexer — a pass at
boot and periodic passes, like the retention loops (`apps/api/src/db/retention.ts`) — picks up traces
that carry a `capture-request` file, reads the body through the proxy's reader and writes one index
row per record. The row snapshots the trace fields the domain needs: `cacheReadTokens` is not a
column of `proxy_request_traces`, and trace rows are re-parsed on read with
`apps/api/src/db/persisted-json.ts:parsePersistedJson`, which silently drops rows that a schema change
made unparseable. Rows are pruned with the same cutoff as the traces and captures they index
(`apps/api/src/proxy/traces-repository.ts:pruneApiProxyTraceHistory`). The whole index can be
dropped and rebuilt from what is still on disk — it is a cache, consistent with the DB being
recreatable (tables in `apps/api/src/db/schema.ts` and `apps/api/src/db/index.ts:migrate`). Nothing
runs on the request path.

**D9. Linking.** Client session identifiers are not universal, and the prefix cache ignores them
anyway: it depends on prefix identity. Sessions are reconstructed from content.

- _Normalization, for linking only._ Stored and replayed bodies stay exact. For hashing, keys are put
  in canonical order (`apps/api/src/utils/canonical-json.ts:canonicalize`), `cache_control` markers
  are removed (Claude Code moves them every turn), and Claude Code attribution is neutralized with
  `apps/api/src/proxy/attribution.ts:sanitizeClaudeCodeAttribution` (its `cch` changes on every
  request, and the CLI rewrites the previous value inside history).
- _Chain hash._ `c_0 = H(root)` and `c_k = H(c_(k-1) || H(message_k))`, where the root holds the
  tools and, for Anthropic, the top-level `system`; an OpenAI system message is simply the first
  chain element. A record's key is its last chain value.
- _Parent._ The latest earlier record of the same source and proxy model whose key equals one of this
  record's chain values, longest match first; ties are broken by `at`, then by `traceId`, so the
  index is deterministic. The match length is the shared prefix in messages. A retry of an identical
  body links to the attempt it repeats.
- _Shape._ Sessions are trees. Retries and forks become siblings or chains; compaction, client-side
  context editing and sliding windows start new roots — where the engine's prefix cache breaks too.
  Auxiliary requests (titles, topic detection, quota probes) become single-record sessions.
- _Versioning._ Every row carries the normalization version; changing normalization rebuilds the
  index. Frozen datasets keep the structure they were frozen with.

**D10. Cache metrics compare a record with its parent only when both were served by the same
target.** The cache lives inside one engine process: a child routed to another target could never
find its parent's prefix, and counting that as a loss would measure routing, not caching. Such pairs
stay in the session but produce no cache metrics. For a same-target pair:

- **cache loss** = `max(0, parent.promptTokens − child.cacheReadTokens)` — prefix the engine had
  already computed and lost to eviction, slot contention, a restart or a template that re-renders
  history;
- **response reuse** = `max(0, child.cacheReadTokens − parent.promptTokens)` — the engine served its
  own previous answer from cache, which a replay cannot reproduce (§ The replay model).

A record whose engine reported no cached count yields no cache metrics: unknown stays `null`, never
`0` (SGLang reports cached tokens only with `--enable-cache-report`; `docs/API_PROXY_FOUNDATION.md`
§ Telemetry). Trace usage means the same for both inbound protocols (§ Protocol symmetry), so the
metrics do too.

### Selection and datasets

**D11. The dataset unit is a segment.** Performance becomes clear long before hours of replay, so
selection picks a characteristic, error-free window and the dataset holds the segments of the
sessions active in it. The error-free requirement (D5) applies to the measured records of the
window; errors before or after it do not matter.

**D12. Windows are found on a profile timeline.** The workload profile is computed per sliding window
(its length is a parameter, for example 15 minutes): active sessions, request rate, prompt size,
fresh and cached prefill, answer length, errors and the cache metrics of D10. Windows with errors
are excluded; the rest are ranked either by closeness to the profile of the whole selected period
("typical") or by load ("peak"). The operator sees the timeline, picks a window — or segments from
several windows for a composed load (D20) — and freezes the selection. The same profile, computed
for a dataset, sits next to the profile of the period it was drawn from, which is how
representativeness is judged.

**D13. Datasets are portable files, and the files are the source of truth.**

- _Layout._ `data/workload-datasets/<id>/` holds a manifest and a blob store. Messages, tools and
  system blocks are stored once each, under the hash of their exact bytes, within the dataset — the
  directory is self-contained.
- _Manifest._ Per record: the blob keys that rebuild the captured body exactly, the operation, the
  timing (offset in the window, think time, duration) and a snapshot of its trace outcome and usage.
  Per segment: its priming record. Per dataset: the selection it came from and the profiles of the
  dataset and of its period.
- _Portability._ No absolute paths. Source, target and model ids are machine-local, so their names
  are stored next to them, and the replay depends on neither: the target is chosen at run time. The
  manifest carries the format version, the normalization version and the arriero version.
- _Identity._ The content hash of the canonical manifest. Importing a dataset that a machine already
  has is a no-op, not a duplicate.
- _Lifecycle._ Freezing runs as a background job (`apps/api/src/jobs/registry.ts`), and a dataset
  appears only when complete. Import is untrusted input: schema validation, hash recomputation, size
  limits, blob names that must be hashes. Datasets are never touched by retention, are deleted only
  explicitly and count in the disk usage of the Maintenance page (`docs/LOG_RETENTION.md` § Manual
  controls). Any DB listing of datasets is a rebuildable cache of the directory.

**D14. Reproducibility, representativeness and fidelity are separate problems.** Reproducibility
comes from freezing: the sources are pruned after `traceRetentionDays`, 30 by default
(`apps/api/src/proxy/request-files.ts:pruneApiProxyRequestFiles` runs with the trace pass).
Representativeness comes from the profile (D12). Fidelity comes from the recorded baseline (D24).

### Replay runs

**D15. Replay is its own benchmark mode.** Segments are finite ordered lists with pacing;
`composition`, `repetitions` and `totalRequests` do not apply. `mode: "replay"` gets its own
scheduler, and `packages/core/src/benchmark.ts:BenchmarkScenarioSchema` becomes a union by mode whose
defaults keep existing run rows loading. The prompt library and its string-only messages
(`packages/core/src/benchmark.ts:BenchmarkMessageSchema`) are not involved.

**D16. Requests go straight to the instance.** The run measures the engine, as the benchmark always
has. The proxy's lease queueing and preemption are therefore not reproduced: engine concurrency comes
from the arrival plan and think times (D20).

**D17. A run reserves the instance, and the proxy refuses traffic to it.**

- _Scope._ The instance and every target that shares one of its resource pools — a neighbor on the
  same GPU distorts the measurement as much as traffic to the instance itself. External endpoints are
  unaffected. The blocked models are listed before the start.
- _Check._ After routing, once the target is known, before autostart and the lease. The answer
  follows the restart drain gate (`apps/api/src/proxy/drain.ts:isApiProxyDraining`, checked in
  `apps/api/src/proxy/protocol-endpoint.ts:proxyProtocolEndpoint`): HTTP 503 with `Retry-After` and a
  protocol-shaped error, whose message names the run and its expected end.
- _Background actions._ The proxy cannot see benchmark traffic: it derives a target's activity from
  llama.cpp slots only (`apps/api/src/proxy/runtime.ts`), so vLLM and SGLang look permanently idle and
  llama.cpp looks idle between requests, and idle unload could take the model away mid-run. Reserved
  targets join the scheduler's pinned set, which
  `apps/api/src/proxy/scheduler.ts:planApiProxyIdleMaintenance` already skips (today it pins targets
  with pending stream resumes).
- _Lifecycle._ The reservation starts in `prepare`; requests already in flight to the reserved targets
  finish before the flush; it is released on every exit path. It lives in memory only: a manager crash
  drops it, and the interrupted run is failed at boot as today.

**D18. The engine cache is flushed before every run.** A nonce in the prompt cannot isolate runs:
llama.cpp `--cache-reuse N` reuses cached chunks after a divergence by shifting their KV, and
connector and host-memory caches keep state outside the prefix path. The flush method becomes an
engine descriptor capability next to `benchmarkServerMetrics`
(`packages/core/src/engine-descriptor.ts:engineDescriptor`). Checked against llama.cpp b11118, vLLM
0.30.0 and SGLang 0.5.20:

- _llama.cpp._ `POST /slots/{id}?action=erase` clears a slot, but the host-memory prompt cache
  (`--cache-ram`, on by default at 8192 MiB) has no clearing endpoint and would restore the previous
  run's prompts. A full flush is a restart — in router mode, unloading and reloading the model.
  Disabling `--cache-ram` for the benchmark is not an option: it is part of the measured
  configuration.
- _vLLM._ `POST /reset_prefix_cache?reset_external=true`, which also resets connector caches. It
  exists only with `VLLM_SERVER_DEV_MODE=1`, which also exposes RPC, sleep and other development
  endpoints — acceptable only for an instance that listens on localhost. It reports failure while
  blocks are held, and is retried.
- _SGLang._ `/flush_cache`, refused while requests are running or waiting. KTransformers runs the
  SGLang server in arriero; its build must be checked for the endpoint.
- _Any engine._ Restarting the instance is the fallback.

Verification: the first dataset request after the flush — the first priming request, or the first
measured request when nothing is primed — must get next to nothing from the cache; otherwise the run
fails. An engine that reports no cached count cannot be verified, and the run carries a warning.

**D19. Priming restores the cache state at the window start.** Without it, the first request of a long
session in the window would prefill the whole history — say 60,000 tokens that were cached in real
work. Before measurement, each segment's priming record is sent with `max_tokens: 1`, unmeasured, so
the engine holds the prefix the way it did at the window start. The priming record is the parent of
the segment's first measured record, or that parent's nearest ancestor whose outcome is a success or
a client abort. Policies:

- `recorded` (default) — prime only the segments whose first measured request did hit the cache in
  real work, in the order of their last activity before the window, so the eviction order matches;
- `all` and `none` — for data from another machine, where recorded cache hits describe another
  engine.

A segment whose session starts inside the window needs no priming: its cold start is real.

**D20. Pacing.**

- _Arrival plan._ `recorded`: segments start at their recorded offsets from the window start.
  `composed`: segments, possibly from different periods, start as if together — N at once or at a
  given interval. `composed` produces load that never occurred; the same segments run at concurrency
  1, 2, 4 and 8 give the curve of MTP gain against load.
- _Think time._ Inside a segment the next request is sent the recorded pause after the replayed answer
  ends, not at a recorded instant. The pause is client time and does not depend on the engine, while
  the end of the answer does: a faster configuration receives the next request sooner, as it would in
  real work, and concurrency emerges from that. The pause is
  `next.at − (previous.at + previous.durationMs)`, clamped at zero.
- _Idle skipping._ Whenever no request is in flight, the replay clock jumps to the next event — a
  pause ending or a segment starting. This loses nothing: engines evict by order of use, not by clock
  (LRU of llama.cpp slots, vLLM blocks, the SGLang radix tree), so the engine sees the same sequence.
  Time-based engine behavior breaks the assumption; an instance with llama.cpp
  `--sleep-idle-seconds` gets a warning.
- _Lossy compression, only when chosen explicitly._ Scaled, capped or zero think time; zero think time
  with a `composed` plan of N at once is the stress mode. Each option changes the workload in a known
  direction and is part of the scenario.

The default is the `recorded` plan with recorded think time and idle skipping. A run then lasts as
long as the window was busy, and the estimate is shown before the start.

Caveats of `composed`: there is no recorded baseline, so the fidelity report does not apply; a
session must not appear twice, because copies share the whole prefix and fake cache hits; sessions
from different periods may come from different client versions, with different system prompts and
tools, so they share fewer prefixes than truly concurrent sessions would.

**D21. Output.** Answers are generated to their natural end and discarded, so every run has the same
conditions. A scenario-wide output ceiling, the same for all runs, bounds runaway generation — clients
often abort precisely a looping answer. Imitating client aborts, by cutting the replayed answer at the
recorded partial length, is an option for runs that simulate real sessions.

**D22. Any failed request fails the run.** Failures are not masked. At the first failed request,
priming included, in-flight requests are canceled, what was measured is kept for diagnosis, and the
run records the request, the segment and the error. Predictable failures are caught before
measurement: in `prepare`, the largest request of each segment is counted with the instance's
tokenizer (`apps/api/src/proxy/token-count-adapters.ts:tokenCountAdapters`) and, together with the
output ceiling, compared with the context — per slot on llama.cpp. A dataset that does not fit fails
the run before it starts, listing the segments. Dataset selection offers the same check against a
chosen instance.

**D23. Warmup is synthetic.** A short request from outside the dataset, as today, excluded from the
statistics: it loads the model and warms kernels without touching any dataset prefix. A dataset
record would pre-warm its own session.

**D24. Analyses.**

- The load summary and timeline of sustained mode (`apps/api/src/benchmark/load-statistics.ts`),
  unchanged.
- Per segment: turns, fresh and cached prefill, TTFT p50/p95, decode rate, wall time.
- The fidelity report, for the `recorded` arrival plan only: replayed against recorded cached and
  fresh prompt tokens per record, and the response-reuse deficit (D10).
- llama.cpp draft acceptance per request, as today. vLLM's server prefill time needs non-overlapping
  requests and is unavailable in replay.

Both inbound protocols reach the engine as OpenAI chat, so
`apps/api/src/benchmark/measure-client.ts:runMeasuredRequest` measures them unchanged. Wave
segmentation is not used in the first version, because replay has no waves; phase classes over the
whole timeline can come later if prefill-versus-decode interference between sessions needs to be
seen.

**D25. Comparability.** The run snapshot gains the dataset hash, a prepared-body hash, the replay
parameters (arrival plan, think-time policy, priming policy, output ceiling, abort imitation) and the
flush method with its verification result. The prepared-body hash covers every body as it will reach
the engine, in dataset order, without per-run fields (`model`, `stream`, `stream_options`, the output
ceiling, sampling). It catches whatever changes engine input while the dataset stays the same: a
bridge change, another dialect, a reasoning-profile or template change. Two runs compare when the
dataset hash, the prepared-body hash and the scenario match; target snapshots compare as they do
today.

## Replay run lifecycle

1. **prepare** — load and verify the dataset; prepare every body through the proxy entry point and
   compute the prepared-body hash (bodies are prepared again at send time; the function is
   deterministic, so memory stays bounded); run the context check (D22); take the reservation and wait
   for in-flight proxy requests to the reserved targets to finish (D17).
2. **flush** — through the engine capability, or a restart (D18).
3. **warmup** — synthetic (D23).
4. **priming** — per policy; the first request verifies the flush (D19, D18).
5. **measure** — arrival plan, think time, idle skipping (D20); the first failure fails the run (D22).
6. **finalize** — analyses (D24), persistence; the reservation is released on this and every other
   exit path.

The run phase enum gains `flush` and `priming`.

## Protocol symmetry: OpenAI inbound vs the Anthropic bridge

Symmetric by construction:

- the capture holds the body in the client's protocol, before the bridge, and the replay runs the
  same preparation as the live request (D2) — bridge then reasoning mapping for Anthropic, reasoning
  mapping alone for OpenAI — so both reach the engine as the OpenAI request it received in live
  serving;
- request translation in `packages/anthropic-openai-bridge` has no randomness, clock or cross-request
  state, and tool ids pass through unchanged, so re-translation reproduces the live body;
- the benchmark reads the engine's OpenAI stream directly; no reverse translation is involved;
- trace usage means the same for both: Anthropic `input_tokens` excludes cache reads, and the meter
  sums input, cache-read and cache-creation back into the full prompt
  (`apps/api/src/proxy/usage-meter.ts:anthropicPromptTokens`), while translated streams report raw
  OpenAI usage.

Asymmetries, all on the Anthropic / Claude Code side:

1. **Linking needs normalization** (D9). Without a `strip-attribution` node before the capture, the
   dataset also carries the attribution churn, and the replay reproduces a full prefill of every
   request — faithful to that configuration, but a measurement of a broken setup.
2. **Translation depends on the target engine.** For llama-server a named `tool_choice` narrows
   `tools` to the named tool (`docs/ANTHROPIC_OPENAI_BRIDGE.md` § Translation dialects), which changes
   the start of the rendered prompt; vLLM and SGLang receive it natively. One Anthropic dataset is
   therefore not input-identical across engines, and the prepared-body hash shows it (D25). OpenAI
   captures reach every engine unchanged, apart from the reasoning mapping both protocols share.
3. **Version drift.** The replay translates with the current bridge, so an arriero update can change
   what the engine receives from the same dataset; the prepared-body hash exposes it (D25).
4. **Extra requests.** `messages.count_tokens` passes through the pipeline and gets captured; it is
   excluded by operation (D4). Claude Code's auxiliary requests are real load and become single-record
   sessions; selection keeps or drops them by source or model.

## Security and privacy

- Records and datasets carry user code, tool output and whatever secrets those contain. Every
  endpoint is admin-gated, and datasets are created and exported only explicitly.
- Imported datasets are untrusted input (D13).
- vLLM's development mode, needed for its flush endpoint, is acceptable only for an instance that
  listens on localhost (D18).

## Delivery phases

1. **Session index and profile** — the `workload` domain, indexer and index, sessions view, profile
   timeline and window finder; read-only. Acceptance: on a machine with its own inference and Claude
   Code traffic, the share of requests linked to a parent is reported, and where Claude Code's
   `metadata.user_id` carries a session identifier, linking is checked against it.
2. **Datasets** — freeze, export and import, profiles, disk usage. Proposed acceptance: a dataset
   exported and imported on another machine keeps its content hash; a frozen dataset survives the
   retention of its sources.
3. **Replay mode** — the proxy entry points, the flush capability, priming, pacing, analyses and
   comparability. Proposed acceptance: repeated runs of one dataset and scenario on an unchanged
   instance agree within a stated tolerance; flush verification passes on llama.cpp, vLLM and SGLang.

The implementation plan with concrete steps is `docs/WORKLOAD_REPLAY_PLAN.md`.

## Known limitations

- **Response reuse** is not reproduced (§ The replay model); it is measured instead.
- **Priming approximates the window-start state.** It restores the parent's prompt, not the exact real
  cache state: a partially lost prefix or a reused answer at the window start is not reproduced.
- **Sub-agent waits.** When a session paused for a sub-agent (Claude Code's Task tool), its think time
  contains the sub-agent's LLM time on the original engine. The sub-agent replays as its own segment,
  but the parent session still waits the recorded time, where a faster engine would have let it
  continue sooner.
- **No proxy admission.** Lease queueing and preemption are not reproduced (D16).
- **Anthropic datasets differ across engines** in their engine input (§ Protocol symmetry).

## Open questions

- The default window length and the closeness metric behind "typical" (D12).
- Whether to offer capping the output at the recorded answer length, to equalize decode volume across
  models.
- Whether the SGLang build used by KTransformers exposes `/flush_cache` (D18).
- Modeling sub-agent dependencies in pacing.

## Evidence: exploratory pass

A one-off script over one machine's captures and traces, September 2026. That traffic went to an
external cloud provider from OpenAI-protocol clients, so the cache and timing rows describe that
provider, not local inference; only the structural findings transfer.

| | glm-5.3-flash | qwen3.8-27b |
| --- | --- | --- |
| records → sessions | 87 → 11 (up to 21 turns) | 105 → 33 (up to 17) |
| message bytes repeating the parent | 81% | 69% |
| unique messages, share of all message bytes | 18.5% | 27% |
| turns whose cache covered the previous answer | 0 of 75 | 0 of 69 |
| turns that lost part of the parent prefix (< 90% cached) | 15 | 17 |
| fresh prefill recomputing an already processed prefix | ~130k of 369k tokens | ~52k of 106k |
| pause between turns, p50 / p90 | 0.3 s / 98 s | 0.2 s / 44 s |

Findings that transfer: sessions reconstruct from bodies without client identifiers; histories repeat
heavily, so content-addressed storage pays off; pauses have a long tail, which matters for eviction.
Findings that do not: the absence of response reuse and the size of the cache loss. Both must be
measured on the benchmarked machine, which is what the workload profile is for.
