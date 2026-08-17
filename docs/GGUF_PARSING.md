# GGUF parsing, worker isolation and the two-layer model cache

Reading a GGUF header is the single most expensive synchronous operation in the manager: a model
with a 250k-token vocabulary carries hundreds of thousands of length-prefixed strings that the
parser has to walk before it reaches the tensor table. This document is the contract for how that
work is done without stalling the event loop, and how its result is cached so an app update never
re-reads every model on disk.

## Rule

**No GGUF file is parsed on a request path.** Routes read the cache; parsing happens in the worker
thread, driven by the scan runner or by the memory estimator, and every caller awaits it.

## Buffered reader

`models/gguf.ts` owns a private `FileReader` that pulls the file in 1 MiB chunks and serves every
field from that buffer. Two invariants keep it correct:

- `read(length)` returns a **view into the shared chunk**, not a copy. Callers must consume it
  immediately (`toString`, `readUInt32LE`, …) and never retain it across further reads. Values
  larger than the chunk take a separate exact read into their own buffer.
- `skip(length)` is pure arithmetic — it never touches the file. Skipping the token and merge
  arrays is therefore free, which is where the old per-element `readSync` cost went.

Measured on a 250k-vocab model: ~1200 ms per parse before buffering, ~65 ms after.

## Worker isolation

`models/gguf-worker.ts` is a plain message loop over the sync parser; `models/gguf-worker-client.ts`
owns exactly one lazily started worker with a request map, refs the worker only while requests are
in flight, and terminates it after 30 s idle. A single worker is deliberate: the goal is to keep the
main thread free, not to consume the cores that the managed inference processes need.

If the worker cannot start or dies, the client logs once, sets itself unavailable and falls back to
in-process parsing — correctness over latency. A parse error inside the worker is a normal rejection
and does not disable it.

## Two-layer cache

`model_cache` stores two independently versioned layers per file:

| Layer | Column | Version | Bumped when |
| --- | --- | --- | --- |
| raw facts | `raw_json` | `GGUF_RAW_VERSION` | the *capture* changes — which KV entries are read, array capture limits, tensor-table summary shape |
| derived metadata | `metadata_json` | `GGUF_PARSER_VERSION` | the *interpretation* changes — new fields, renamed labels, cross-checks |

Both are keyed by the file's size and mtime, checked by the scanner before either layer is trusted.

The split exists because interpretation changes far more often than capture. When only
`GGUF_PARSER_VERSION` moves, `deriveGgufMetadata(facts)` rebuilds the metadata from `raw_json` in
microseconds with no disk access, so shipping a parser improvement no longer re-reads every model.
`getCachedModelEntry`/`listAllCachedModels` derive on read; the next scan pass persists the
refreshed derived layer.

Raw facts are model-level, not file-level: for a split GGUF the scanner sums the shard parameter
counts into `facts.tensors.parameterCount` before caching, so a rebuild from facts stays equivalent
to a full re-read.

`chatTemplateReasoning` (parser v12) is one such derived field: reasoning-effort capabilities
extracted from `tokenizer.chat_template` (`models/chat-template-reasoning.ts`), consumed at request
time by the API-proxy effort mapping (`docs/API_PROXY_REASONING.md`).

**When adding a metadata field:** if the value comes from a KV entry the capture already keeps, bump
only `GGUF_PARSER_VERSION`. If it needs something the reader currently skips (or a new tensor-table
statistic), bump `GGUF_RAW_VERSION` too — that one does force a full re-read.

## Scan runner

`models/scan-runner.ts` is the single-flight owner of scanning. `GET /api/models` never scans: it
returns the cached view plus a `scan` state (`status`, `done`, `total`, `error`).
`POST /api/models/scan` starts a pass (`{"refresh": true}` re-reads files instead of trusting the
cache) and returns immediately; a refresh requested while a pass runs is queued as one follow-up
pass rather than dropped. The web hook polls the view once per second while `status` is `scanning`,
so the list fills in incrementally instead of blocking behind one long request.

Each successful pass prunes cache rows whose file disappeared, which is what keeps the
cache-served view honest about deletions.

## Memory estimation

`models/gguf-cache.ts` serves the estimator: hparams come from the cached raw facts when the file is
unchanged (no disk access at all), and tensor tables — which the estimator needs in full, per tensor
— go through the worker behind a small LRU. `estimateMemory` is therefore async; its callers (the
route and the memory-assessment auto-loop) await it.
