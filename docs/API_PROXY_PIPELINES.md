# API Proxy Pipelines: node-graph routing

A pipeline is a named graph that transforms a request, decides which target
receives it, and then transforms the successful response while it unwinds in
the opposite direction. Pipelines are the proxy's "ersatz programming"
surface: conditions branch, calls reuse shared sub-graphs, and every resolution
is recorded step by step. Loops are deliberately impossible.

Source map:

- `packages/core/src/index.ts` — `ApiProxyPipelineConfigSchema`,
  `ApiProxyPipelineNodeSchema`, `ApiProxyConditionPredicateSchema`,
  `ApiProxyPortRefSchema`, legacy upgrade (`upgradeLegacyApiProxyPipeline`),
  shared graph helpers (`apiProxyPipelineNodePorts`,
  `collectApiProxyPipelineExitNames`).
- `apps/api/src/proxy/pipeline.ts` — the resolver (`resolveApiProxyRouteChain`).
- `apps/api/src/proxy/response-plan.ts` — reverse response-effect executor.
- `apps/api/src/proxy/response-codec.ts` — lossless JSON/SSE envelopes.
- `apps/api/src/proxy/response-replace.ts` — response text surfaces and
  stateful streaming replacement.
- `apps/api/src/proxy/token-scale.ts` — request limits and response usage
  scaling.
- `apps/api/src/proxy/loop-guard.ts` + `loop-guard-stream.ts` — repetition-loop
  detection and enforcement (`docs/API_PROXY_LOOP_GUARD.md`).
- `apps/api/src/proxy/condition.ts` — predicate evaluation.
- `apps/api/src/proxy/token-estimate.ts` — local token estimator.
- `apps/api/src/proxy/request-text.ts` — request text extraction (scopes).
- `apps/api/src/proxy/pipeline-validation.ts` — save-time graph validation.
- `apps/api/src/proxy/route-explain.ts` — dry-run explain endpoint.

## Data model

```jsonc
{
  "id": "…",
  "name": "route-by-size",
  "enabled": true,
  "entry": { "type": "node", "id": "cond" },
  "nodes": [
    {
      "id": "cond",
      "name": "size?",
      "type": "condition",
      "config": {
        "predicate": { "type": "token-estimate", "minTokens": 8000 },
      },
      "ports": {
        "true": { "type": "target", "id": "<background-target>" },
        "false": { "type": "pipeline", "id": "<chat-pipeline>" },
      },
    },
  ],
}
```

A **port ref** points at one of three things:

- `node` — another node in the _same_ pipeline;
- `target` — a proxy target; the walk terminates and the request is forwarded;
- `pipeline` — a **jump** to another pipeline's `entry` (tail-call: the call
  stack is unchanged).

`entry` is itself a port ref (a pipeline whose entry points straight at a
target is a pure alias). `null` anywhere means "unwired" and produces a
`route_unbound` diagnostic if the walk reaches it.

## Node types

The node-type universe has one owner:
`packages/core/src/proxy/pipeline-nodes.ts` declares `PIPELINE_NODE_TYPES` (a
const tuple compile-time-checked against the `ApiProxyPipelineNodeSchema`
union) and `PIPELINE_NODE_DESCRIPTORS` — per-type facts (label, color,
single-next-ness, picker visibility) behind the `pipelineNodeDescriptor`
accessor — the same one-owner pattern as `engine-descriptor.ts`. The
route-trace `kind` enum and `apiProxySingleNextNodeTypes` derive from it, and
the core graph walkers plus the resolver switch in
`apps/api/src/proxy/pipeline.ts` are `never`-checked, so a node type missing
from the tuple or descriptors fails compilation instead of falling through
silently.

Each entry is **`type`** — `config` (output `ports`). Richer configs are detailed
in the sub-sections below.

- **`replace-text`** — `rules: [{enabled, find, replace}]`, `request` (default
  `true`), `response` (default `false`), `responseReasoning` and
  `responseToolArguments` (both default `false`): literal substring rules over
  selected request/response text surfaces. The routing `model` field, response
  IDs, model names, finish reasons, tool names and usage are never rewritten.
  (`next`)
- **`capture-request`** — `request: bool` (default `true`) + `response: bool`
  (default `false`): persist the request body at this node and/or the upstream
  response for this request (legacy `{}` upgrades to request-only). (`next`)
- **`edit-request`** — `operations: [{kind, enabled, …}]`: structural edits of
  the request body — `tools` array operations and field operations by path (see
  below). (`next`)
- **`reasoning`** — `effort: off|low|medium|high|max|custom` +
  `customBudgetTokens`: controls the model's thinking channel (see below).
  (`next`)
- **`output-limit`** — `maxTokens` + `mode: cap|set`: bounds `max_tokens` on the
  request (see below). (`next`)
- **`context-limit`** — `thresholdTokens`: rejects a request with a
  protocol-compatible context-overflow error when the locally estimated prompt
  size reaches the threshold (see below). (`next`)
- **`token-scale`** — `factor`: divides request token limits and multiplies
  client-visible response usage, while operational metrics stay actual (see
  below). (`next`)
- **`strip-attribution`** — no config: runs `sanitizeClaudeCodeAttribution` on
  the body in place, dropping Claude Code's `x-anthropic-billing-header`/`cch`
  attribution and pinning in-content `cch` hashes. Keeps the llama.cpp KV prefix
  cache (and any downstream cache key) stable. Decoupled from translation — must
  be placed in the pipeline where wanted; a no-op when no attribution is found.
  See `docs/ANTHROPIC_OPENAI_BRIDGE.md`. (`next`)
- **`cache`** — `ttlSeconds` (0 = no expiry) + `namespace`: on a hit, serves a
  saved response and **short-circuits routing/lease/forward** (route-chain
  terminal `kind:"response"`); on a miss, follows `next` and registers a
  positional response effect. Key =
  sha256(namespace ⊕ modelId ⊕ body-at-node), excluding `stream`/`stream_options`.
  JSON and SSE entries are stored at the cache node's exact response boundary;
  streaming misses also fan out to concurrent subscribers. Place a
  `strip-attribution` node before it for a stable key. See
  `docs/API_PROXY_RESPONSE_CACHE.md`. (`next` = miss)
- **`loop-guard`** — `action: observe|finish` + channel toggles + detection
  thresholds + `markerText`: watches the response for repetition loops
  (period / novelty / compression / entropy signals over answer, reasoning and
  tool-argument channels) and records trigger / near-miss artifacts (kinds
  `loop-guard-trigger` / `loop-guard-near-miss`). `finish` additionally cuts a
  streaming OpenAI-chat/Anthropic reply with a marker text and a synthetic
  protocol finish, stops the upstream request and excludes the response from
  caching. See `docs/API_PROXY_LOOP_GUARD.md`. (`next`)
- **`condition`** — `predicate` (see below). (`true`, `false`)
- **`call`** — `pipelineId`. (one port per callee exit name)
- **`exit`** — `exitName` (default `done`). (no ports)
- **`fusion`** — `minQuorum` + prompts: fans the request out over every `panel`
  branch (each resolved as its own route chain and executed as a buffered
  non-stream sub-request — `stream`/`stream_options` are stripped from the
  branch body; the cache key is unaffected), then routes a synthesis request
  through the `synthesizer` branch. Branch chains get the real chain IO:
  capture-request nodes record files, panel cache nodes store and replay the
  canonical JSON answer (buffered entries only; framing-independent because
  panels are always non-stream), and registered coalesce keys are settled on
  every branch failure. Each survivor's response effects run over its own
  canonical answer **before** synthesis (so replace/capture/cache/scale apply
  to the panel text the synthesizer sees); with a single survivor the bypass
  serves the panel answer directly and its effects run at delivery like any
  route effects. Branch route traces and replacement counts are merged into
  the request trace as `fusion-branch` segments. (`panel[]`, `synthesizer`)

### Edit-request operations

Structural edits of the parsed body, applied in order by
`applyApiProxyRequestEdits` (`@arriero/core` — shared by the runtime
walker and the web editor's live preview, one implementation):

- `remove-tool {toolName}` — drops every entry of the top-level `tools` array
  whose name matches. `*` in `toolName` matches any character run
  (`mcp__*`); otherwise the match is exact. Tool names are read from both
  protocol shapes (`tool.function.name` for OpenAI, `tool.name` for
  Anthropic). When `tools` ends up empty the key is deleted; an object
  `tool_choice` naming a removed tool is deleted too.
- `replace-tool {toolName, value}` — replaces every matching entry with
  `value` (a full tool JSON object).
- `add-tool {value}` — appends `value` to `tools`, creating the array.
- `set-field {path, value}` — sets any body field to `value` (any JSON value).
  `path` is dot-separated keys with `[n]` array indices (`max_tokens`,
  `stream_options.include_usage`, `messages[0].role`); paths are validated at
  save time. Missing intermediate **objects** are created; array indices must
  address an existing element (the final segment may also be `[length]` to
  append). A path that runs through a scalar or mismatched container reports a
  no-match outcome instead of overwriting. The write is copy-on-write along
  the path — the pre-edit body (e.g. an earlier `capture-request`) is never
  mutated.
- `remove-field {path}` — deletes the field (object key or array element,
  spliced) at `path`; absent paths report `<path> is not present`.

Every operation reports an outcome (`removed 2 tool(s): a, b` /
`set max_tokens = 512 (was 16384)` / `no tool matches "x"`) joined into the
node's `routeTrace` detail, so a
non-matching rule is visible in the test bench and request traces instead of
failing silently. The web editor's **block editor** modal previews operations
against a pasted sample request: sample tools render as blocks with
removed/replaced badges, and Remove/Replace/Add buttons on the blocks generate
operations.

### Reasoning control

The `reasoning` node sets the request fields that toggle and budget the model's
thinking/reasoning channel. `effort` mirrors the llama.cpp web UI presets
(`off` disables thinking; `low`/`medium`/`high` = 512/2048/8192 token budgets;
`max` = unlimited; `custom` uses `customBudgetTokens`, `-1` = unlimited). The
node synthesizes `set-field` operations via
`apiProxyReasoningEditOperations(config, protocol)` (`@arriero/core`,
shared with the editor's live preview) and runs them through
`applyApiProxyRequestEdits`, so the written shape follows the **inbound
protocol**:

- OpenAI → `chat_template_kwargs.enable_thinking` (bool) and, when a finite
  budget is set, `thinking_budget_tokens` (llama.cpp extensions; `max`/`-1`
  omit the budget and defer to the server default).
- Anthropic → the native `thinking: {type: "enabled"|"disabled", budget_tokens}`
  block. For Anthropic-profile upstreams it passes through verbatim; for
  non-anthropic upstreams the `anthropic-openai-bridge` translates it — enabled
  → `thinking_budget_tokens`, and disabled → `chat_template_kwargs.enable_thinking:false`
  (via the consumer-set `enableThinkingKwargField` option) so "off" reaches
  llama.cpp.

The node does not arm llama.cpp's realtime `reasoning_control`/force-answer
endpoint — that is the separate interrupt-to-force-answer path on proxy
targets.

### Output limit

The `output-limit` node bounds the response length via the request's
`max_tokens` (the same field for OpenAI and Anthropic inbound, preserved by the
bridge), the hard stop against runaway/looping generation
(`finish_reason: "length"`). `apiProxyOutputLimitEditOperations(config, body)`
(`@arriero/core`) reads the current `max_tokens` and emits a `set-field`
op only when the value changes:

- `cap` (default) — `min(client max_tokens, maxTokens)`; an absent client value
  is set to `maxTokens`. A safety ceiling that never raises a smaller client
  request.
- `set` — forces `max_tokens = maxTokens` unconditionally.

The applied change is reported in the node's `routeTrace` detail (e.g.
`set max_tokens = 4096 (was 32000)`), or `<mode> <n>: no change` when the bound
was already satisfied.

### Context limit

The `context-limit` node is a preflight guard for context-window headroom. It
uses the same fast local estimator as the `token-estimate` condition, counting
message and system text, per-message overhead and serialized tools. When the
estimate is greater than or equal to `thresholdTokens`, routing stops before a
target, lease or model generation is started.

Anthropic requests receive HTTP 400 with
`invalid_request_error: Prompt is too long`, which Claude Code recognizes as a
recoverable context overflow and can answer by compacting and retrying. OpenAI
requests receive the equivalent HTTP 400 `invalid_request_error`. A request
below the threshold follows `next` normally. Both the estimate and threshold
are recorded in `routeTrace`.

The estimator is deliberately approximate and measures prompt tokens, not the
future generated response. Configure the threshold below the model's real
context size, leaving enough margin for tokenizer differences and the desired
output budget. The guard operates on the body as transformed by earlier
pipeline nodes, so placement controls whether edits and attribution stripping
affect its estimate.

### Response-side Replace text

`replace-text` remains request-only for existing configurations. Enabling
`response` applies the same rules to visible assistant text after target
observation and protocol translation. Reasoning text and tool arguments are
separate opt-ins. Supported response shapes cover OpenAI Chat/Completions,
OpenAI Responses, and Anthropic Messages; endpoints without assistant text
(embeddings, rerank, count-tokens) pass through unchanged.

Streaming replacement is literal and bounded. Every choice, content block,
reasoning channel and tool call has independent matcher state, and lanes finish
independently: a `finish_reason` closes only that choice's lanes, an
Anthropic `content_block_stop` only that block's, an OpenAI Responses `*.done`
only that item/part's — only stream-terminal events (`[DONE]`, `message_stop`,
`response.completed/failed/incomplete`) flush everything. A matcher holds
only the longest suffix that could still become the beginning of `find`, so a
match can cross SSE events without buffering the whole answer. If the suffix
turns out not to match it is released immediately; any remaining suffix is
emitted as a **synthesized minimal delta frame** (never a replay of the
carrier frame, so start events, usage or finish markers are not duplicated)
before the lane's finish/stop event. Unknown SSE fields, comments,
event/id/retry fields, LF/CRLF framing and no-op frames are preserved.

Two shape-specific rules keep streams consistent with the buffered path:
OpenAI Responses aggregate events (`response.output_text.done`,
`response.function_call_arguments.done`, `response.output_item.done`,
`response.content_part.done` and the final `response.completed` output) are
rewritten directly, matching what `replaceOpenAiResponsesOutput` does to a
non-stream body; and Anthropic `input_json_delta.partial_json` fragments are
matched with JSON-escaped rule variants (`find`/`replace` passed through
`JSON.stringify`), so rules written against decoded values match the escaped
wire form and a replacement containing quotes or backslashes splices valid
JSON into the streamed tool arguments.

### Token scale

`token-scale.factor` means **client-visible tokens / real target tokens**. It
creates a virtual token scale without changing Arriero's actual target
measurements:

```text
target request limit = floor(client limit / factor), positive minimum 1
client usage         = ceil(actual usage * factor)
```

Thus factor `10` maps request `max_tokens: 40000` to `4000`, while target usage
`input_tokens: 10000, output_tokens: 2000` is returned as `100000` and `20000`.
Factor `0.5` scales in the opposite direction. Zero remains zero; negative
llama.cpp unlimited sentinel values remain negative. A scaled `total_tokens`
is recomputed from scaled prompt/completion or input/output components when
both are present.

Request mappings include OpenAI/Anthropic output limits, Responses
`max_output_tokens`, common local-server `max_new_tokens`/`n_predict` fields,
and nested thinking/reasoning budgets. On responses, every `*_tokens` field
inside a standard `usage` tree is scaled recursively, including cache,
reasoning and prediction details; Anthropic `messages/count_tokens` and
Responses' echoed `max_output_tokens` are covered too. The same mapping runs
for JSON and usage-bearing SSE events.

Usage metering, Request history, stats, inflight token progress, TTFT,
generation rate, and Proxy load answer/reasoning previews are recorded before
the response plan and therefore remain actual. Explicit Save nodes are
positional and can intentionally capture either actual or client-visible
usage.

### Condition predicates

- `text-match` — substring or regex (`regex: true`, validated at save time;
  case-insensitive unless `caseSensitive`) over a **scope**:
  `last-user-message`, `any-message`, `system` (OpenAI `system`/`developer`
  roles and the Anthropic top-level `system` field), or `full-body`
  (serialized JSON). Conditions see the request **after** any `replace-text`
  nodes earlier on the route — normalize first, then match.
- `token-estimate` — true when the estimated request size ≥ `minTokens`.
- `source` — true when the request's resolved source id (see `proxy/sources.ts`)
  equals `sourceId`; `null` matches anonymous requests.

### Token estimation is local by design

Resolution runs as a pure pre-pass before the gateway decision and lease
acquisition (`protocol-endpoint.ts`), so a condition may not depend on live
GPU state — asking a managed `llama-server` to `/tokenize` could require
starting it, which is the scheduler's job and would invert the layering (and
invite pathological swaps: load model A to count tokens for a request that
then routes to B). Instead `token-estimate.ts` estimates from text alone with
per-codepoint weights (tokens per character):

- whitespace and ASCII alphanumerics: 0.25 (≈4 chars/token)
- other ASCII: 0.4
- Cyrillic (U+0400–U+04FF): 0.45 (≈2.2 chars/token)
- CJK ranges: 1.0
- everything else: 0.5

Counted text: all message contents (string or text parts), Anthropic `system`,
completion `prompt`, plus serialized `tools`; +4 tokens per message; if the
body has no messages at all, the serialized body. Accuracy vs a real llama
tokenizer is ±10–20%, which is fine for routing thresholds — the UI labels the
field "estimated". The estimate is memoized per resolution and invalidated
when a `replace-text` node changes the body.

## Functions: call and exit

A pipeline **is** a function: `entry` is its head, `exit` nodes are named
return points. A `call` node runs another pipeline; when the walk hits an
`exit` node, the innermost call frame pops and continues at the call node's
port named by `exitName`. This means:

- a `target` inside a callee terminates the route — the request goes to the
  model without "returning" (resolution computes a path, not a value);
- exits give the callee a way to _return a decision_ — wire different exit
  names to different continuations at each call site;
- a `pipeline`-type port ref is a tail jump: it does not push a frame, so an
  exit inside the jumped-to pipeline returns to the original caller. Reachable
  exit names for validation are collected across the jump closure
  (`collectApiProxyPipelineExitNames`);
- an `exit` with an empty call stack is a `route_invalid` diagnostic;
  an exit name with no wired port on the call node is `route_unbound`.

## No loops

- Within a graph, `node`-type port edges must form a DAG (checked at save).
- A pipeline must not reference itself through any jump/call chain (checked at
  save over the cross-pipeline reference closure).
- Runtime backstops (file edits bypass API validation until restart): max 256
  visited nodes per resolution, call depth ≤ 8, recursion guard on the call
  stack — all surface as `pipeline_cycle` diagnostics.

## Capture semantics

With `request` enabled (the default), `capture-request` writes a file (kind
`capture-request`) **at the moment the walk passes the node**, containing
exactly the request body as it arrived there — changes made by earlier nodes
are included, later changes are not. Each capture node visit writes its own
request file.

With `response` enabled the node instead declares a **deferred response
capture** in the ordered `responseEffects` plan. Effects execute in reverse
request-path order, so captures are positional:

```text
request:  Save A -> Replace -> Save B -> Target
response: Target -> Save B (raw) -> Replace -> Save A (changed) -> Client
```

The same rule applies to cache and Token scale nodes. A cache hit executes only
the prefix that was visited before the hit; the cached value already includes
the downstream side of that cache boundary. Non-streaming, buffered,
resumable, remote, translated, fusion and SSE replies all use the same response
executor. JSON captures store the parsed body at that stage; SSE captures store
the complete framed text at that stage. Response effects currently run only
for successful replies, so upstream error bodies are not persisted.

The executor runs after target metering/observation and protocol translation
but before client delivery. This is why user transformations cannot rewrite
Request history or Proxy load previews, while an explicit Save node still sees
the exact graph-local value the user requested.

All files saved for one proxied request share a per-request directory
`data/proxy-requests/<model>/<timestamp>-<traceId>/` — `<model>` is the inbound
proxy model id sanitized for the filesystem (everything outside
`[A-Za-z0-9._-]` collapses to `-`, capped at 100 chars, dot-only ids fall back
to `unknown-model`) — named
`<NN>-<node-kind>.json` in visit order (response files land after the request
files, in completion order); future nodes that persist other per-request
artifacts write into the same directory. Each file is an
`ApiProxyRequestFileRecord` envelope (`traceId`, `kind`, node `label`,
protocol/endpoint/model context, `data` payload). The saving side appends
file metadata (`ApiProxyTraceFile`: name, root-relative path, kind, label,
bytes) to `trace.files`, which the Recent requests table renders as a Files
button — pick a file from its menu to view the content, fetched via
`GET /api/proxy/request-file?path=<relative path>` (admin, path-confined to
`data/proxy-requests/`).

## Observability

- Every resolution appends `routeTrace` to the request trace
  (`ApiProxyRequestTraceSchema`): entered pipelines, visited nodes, chosen
  ports and details (condition outcomes include the measured estimate, e.g.
  `~7212 tokens < 8000`). The proxy view's Recent requests table shows it as a
  hoverable step list.
- `POST /api/proxy/route-explain` (admin) dry-runs resolution without
  forwarding, capture or stats: body `{protocol, body, sourceId?}` →
  `{ok, targetId, targetName, diagnostic, routeTrace, textReplacementCount,
tokenEstimate, transformedBody}`. Capture nodes do not write logs in explain
  mode.

## Web UI split

Two pages share the proxy domain. `#/proxy` (Proxy) is operations: target
runtime with inflight/prefill progress, scheduler plan check, stats and the
recent-request traces. `#/routing` (Routing) is construction: the topology map
(what each model can reach, dangling refs, unreachable pipelines), the
model/pipeline/target tables, a full-page pipeline editor addressed as
`#/routing/<pipelineId>` (`#/routing/new` to create), and the route test bench
(the explain endpoint with body presets).

## Canvas editor

The pipeline editor defaults to a React Flow canvas (`@xyflow/react`,
`apps/web/src/ui/proxy/canvas/`); the node-card form stays available behind
the Canvas/Form toggle and shares the same draft model and per-type field
components (`node-fields.tsx`). One canvas per pipeline — a pipeline is a
function body; call nodes stay collapsed and double-click navigates into the
callee (hash sub-route, browser back works). Canvas semantics:

- Real nodes carry their ports as labeled source handles (condition:
  `true`/`false`; call: one handle per reachable callee exit). Edges derive
  from port refs; dragging a new connection from a handle _replaces_ that
  port's wiring; deleting an edge or node clears the affected ports.
- Targets and jumped-to pipelines appear as terminal pseudo-nodes
  (`ref:target:<id>` / `ref:pipeline:<id>`), created lazily from refs; the
  entry marker is a pseudo-node whose single edge sets `entry`.
- Selecting a node opens the inspector panel (same forms as the card editor);
  port selects there are an alternative to dragging edges.
- Positions persist via the optional per-node `layout {x, y}` field
  (`ApiProxyNodeLayoutSchema`, additive) written on drag stop and saved with
  the pipeline; nodes without `layout` get a layered auto-layout (BFS depth
  from entry). Pseudo-node positions are session-only.
- A test-bench Explain run highlights the traversed path on the canvas: nodes
  and ports of the current pipeline from `routeTrace`, including the caller's
  call-node exit port, which is reconstructed by replaying the trace's
  call/exit nesting (`highlightFromTrace`).

## Validation lifecycle

- **Save time** (`POST/PATCH /api/proxy/pipelines`): full graph validation —
  unique node ids, dangling refs, regex compilation, in-graph DAG,
  cross-pipeline cycle check, callee exit-name check. Errors return as plain
  `{error: string}` 400s.
- **Startup**: `collectApiProxyPipelineGraphWarnings` logs a `pino` warning per
  invalid pipeline loaded from files (the server still starts; affected routes
  fail with diagnostics at request time).
- **Request time**: every structural problem maps to a 503 diagnostic
  (`pipeline_not_found`, `pipeline_disabled`, `pipeline_cycle`,
  `route_unbound`, `route_invalid`) shaped per public protocol.

## Legacy upgrade

Pre-graph records (`steps` + `nodeType` + `routeTo`) are upgraded inside the
core zod schemas (`z.preprocess` on `ApiProxyPipelineRecordSchema` /
`ApiProxyPipelineConfigSchema`): enabled steps become a linear node chain,
`routeTo` becomes the last node's `next` port (or `entry` when there were no
steps). Disabled legacy steps are dropped. The upgrade applies wherever
records are parsed — config files, the one-time SQLite export
(`legacy-migration.ts`) — and rewrites to disk happen on the next mutation.
