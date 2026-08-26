# CLAUDE.md — proxy domain

The `proxy` domain fronts both managed `llama-server` instances and external APIs behind
OpenAI/Anthropic-compatible facades. Overview, admin surface and telemetry:
`docs/API_PROXY_FOUNDATION.md`; the full document set is grouped under "API proxy" in
`docs/README.md`.

## Invariants

- **`scheduler.ts` is pure and side-effect-free** — it takes a runtime snapshot and returns an
  ordered action list (`start-instance`, `load-model`, `save-slot`, `unload-model`,
  `route-request`, …). Only the executor (`public-executor.ts`) turns actions into real operations:
  autostart/autoload, preemption via unload/stop, slot save/restore.
- Request flow in `protocol-endpoint.ts:proxyProtocolEndpoint`: resolve model → route chain
  (`pipeline.ts`) → gateway decision (`gateway.ts`) → acquire domain lease → execute plan → forward
  (`forwarder.ts`) or resumable. Protocol adapters (`openai.ts`, `anthropic.ts`, `protocol.ts`) shape
  errors per public API.
- **Per-operation behavior is a table row, not a branch**: body mode, upstream path, response shape,
  resumability, usage metering and translation come from `protocol.ts:apiProxyOperationSpecs` via
  `apiProxyOperationSpec` (`docs/API_PROXY_FOUNDATION.md` § Operation specs). Never branch on
  `operation.endpoint` at a call site.
- **External providers collapse the target layer**: an endpoint-routed or passthrough model resolves
  to a synthetic, non-persisted `ApiProxyTargetRecord` (`external-target.ts`) so the
  gateway/lease/forwarder path stays uniform. Targets persist only for managed instances
  (`docs/EXTERNAL_PROVIDERS.md`). Proxy targets reference entries in the shared API-endpoint catalog
  (`endpoints.ts`); managed instances and the manager proxy itself are read-only generated entries.
- A proxy model has two independent flags: `visible` (listed in `GET /v1/models`) and `enabled`
  (serves requests). `enabled:false` ⇒ non-retryable `409 model_disabled` with its `blockedMessage`
  before routing or autostart, yet the model stays callable by name so hidden models can be tested.
- `GET /v1/models` mirrors llama.cpp router mode with a per-model `status` (`model-status.ts`, off a
  2 s `getCachedApiProxyRuntimeSnapshot`, never autoloads). Its load `value` is a frozen
  llama.cpp-derived external contract. The four status layers (process → instance-health →
  proxy-target → public) and their intentional divergences are mapped in `docs/STATUS_LAYERS.md` —
  do not "unify" them.

## Resources and admission

Two axes, documented in `docs/RESOURCE_MANAGEMENT.md`: **memory residency** (scheduler fit/eviction
over the file-backed pools in `config/resources.json`) and **compute contention** (a multi-holder
per-domain priority gate/lease in `domain-coordinator.ts`, keyed on the memory pools a request draws
from — gpu **and** host, so CPU contention is arbitrated like GPU; no declared draws ⇒ no lease ⇒
unmanaged concurrency). Policy is injected via `decide()` (`domain-admission.ts`). Competing requests
**queue, they do not 503**.

## Pipelines

Node graphs resolved as a pure pre-pass before gateway/lease. Ports reference nodes, targets or
pipelines (a pipeline ref is a tail jump); `call` plus named `exit`s give function semantics; loops
are forbidden (save-time `pipeline-validation.ts` plus runtime budgets). Nodes: `replace-text`,
`capture-request`, `edit-request`, `reasoning`, `output-limit`, `context-limit`, `token-scale`,
`strip-attribution`, `cache`, `loop-guard`, `condition`, `call`, `exit`. Resolution lands in
`trace.routeTrace`; dry-run via `POST /api/proxy/route-explain`. See `docs/API_PROXY_PIPELINES.md`,
`docs/API_PROXY_RESPONSE_CACHE.md` (the `cache` node short-circuits before gateway/lease) and
`docs/API_PROXY_LOOP_GUARD.md`.

## Streams

- **Health** (`docs/API_PROXY_STREAM_HEALTH.md`): a stream's valid terminal is `[DONE]` **or** an
  explicit finish_reason; EOF with neither = truncated. Policy is per-endpoint
  (`ApiEndpointRecord.streamTerminal`, null = strict for managed / tolerant for external): strict
  managed resumes via the preemption tail (bounded retries) then 502, strict external 502s, tolerant
  accepts but flags the trace. Truncated responses are never cached. Malformed SSE payloads are
  counted (`parseChunk` → `"malformed"` ≠ ignorable `null`), logged and recorded in
  `trace.streamHealth` — never silently dropped. A silent upstream trips a per-read idle watchdog
  (`watchStreamIdle`; endpoint `streamIdleTimeoutMs` → proxy settings → 300 s default, 0 = off) that
  errors the stream instead of letting it hold the lease forever.
- **Preemption**: `resumable-forward.ts` survives mid-request preemption — slot save → swap →
  restore → assistant-prefill resume (`docs/API_PROXY_PREEMPTION.md`).
- **Resume across manager restarts** (`docs/STREAM_RESUME.md`): managed SSE forwards on the plain
  `respond()` path attach a llama.cpp stream session (`X-Conversation-Id`, `stream-session.ts`); the
  preemptible path is excluded, because detached sessions would break slot handoff. SIGTERM persists
  sessions, boot adopts and verifies them, an identical retry claims by resume key pre-gateway and
  replays through the standard downstream tract (`resume-replay.ts`). Self-update restart drains
  first (`drain.ts`).

## Reasoning effort

Client-requested effort (`reasoning_effort`, `output_config.effort`, `thinking` incl. `adaptive`) maps
onto the resolved upstream's native interface **at the forward boundary** (`reasoning-request.ts`,
applied in respond/resumable/fusion-branch/resume-claim, so condition/fusion routing and peer
delegation map per instance). The profile is a property of the **upstream**, never the public model
id. Precedence: `Instance.reasoning` override → chat-template autodetect for llama instances → llama
engine-default budget → external `ApiEndpointRecord.reasoning` override → passthrough. The
`reasoning` node is a canonical override (`auto` keeps inbound), traced as a `reasoning` route step.
An unrecognized ladder is loud: `InstanceHealthSummary.reasoningTemplateIssue` drives an instance
badge and the dashboard attention card. Details: `docs/API_PROXY_REASONING.md`.

## Protocol translation

Inbound Anthropic `messages` to non-anthropic-profile upstreams is **always** translated to OpenAI
chat completions via the sans-IO workspace package `packages/anthropic-openai-bridge`, wired in
`translation.ts`; anthropic-profile endpoints pass through verbatim. The bridge options are a
per-upstream dialect resolved into the upstream context (engine descriptor `proxy.translationDialect`
for managed instances, endpoint profile otherwise — `docs/ANTHROPIC_OPENAI_BRIDGE.md` § Translation
dialects). Claude Code's
`x-anthropic-billing-header` / `cch` attribution churns the llama.cpp KV prefix cache, and stripping
it is **not** automatic — it is the placeable `strip-attribution` node
(`attribution.ts:sanitizeClaudeCodeAttribution`), inserted where needed, e.g. before a cache node.
See `docs/ANTHROPIC_OPENAI_BRIDGE.md`.
