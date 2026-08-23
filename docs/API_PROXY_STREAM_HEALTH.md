# API proxy stream health

How the proxy decides that an upstream SSE stream really finished, what happens
when it did not, and how broken payloads inside a stream are surfaced. The
design borrows the terminal-classification and malformed-payload ideas from the
SiliconFlow DeepSeek-Harness adapter (`dsh-llm-siliconflow`) without importing
its harness semantics: arriero stays a transparent proxy, so nothing here
rewrites `finish_reason` values or invents error kinds for pass-through
streams.

## Terminal validity

A streamed chat/messages response has a **valid terminal** when either

- the protocol's done marker arrived — `data: [DONE]` for OpenAI-compatible
  streams, `message_stop` for Anthropic streams, or
- any chunk of the attempt carried an explicit finish reason
  (`finish_reason` / `stop_reason`).

Either signal alone is sufficient: `[DONE]` without a `finish_reason` is a
valid terminal (minimal servers), and a `finish_reason` followed by EOF without
`[DONE]` is a valid terminal too (usage-only tails and non-standard servers).
EOF with neither is a **truncated** stream: the TCP connection closed cleanly
mid-generation (upstream crash, an intermediate proxy timing out politely) and
the buffered text cannot be trusted to be complete.

`pumpSseFrames` (`proxy/resumable-forward.ts`) reports how the stream ended and
`classifyStreamEnding` maps that to a terminal kind recorded in
`ResumableBufferState.health.terminal`: `done`, `finish` or `eof`. The
finish-reason flag is tracked **per attempt**, so a resumed attempt must
produce its own terminal.

## The strictness knob: `streamTerminal`

What happens on a missing terminal is a property of the **endpoint**, not of
the model or request: `ApiEndpointRecord.streamTerminal` (core
`api-endpoints.ts`) is `"strict"`, `"tolerant"` or `null` = derived from the
endpoint kind — managed instances and the manager proxy default to `strict`
(llama-server reliably emits both signals), external APIs default to
`tolerant`. `apiEndpointStreamTerminal` in `proxy/upstream-context.ts` resolves
the effective value into `ApiProxyUpstreamContext.streamTerminal`; the web
endpoint editor exposes the override for external endpoints.

Behavior per path:

- **Preemptible resumable path** (`runResumableForward`): a `truncated` attempt
  is handled by the `ResumableTruncationPolicy`:
  - strict + managed instance → `resume`: retry through the same loop that
    handles preemption — the accumulated text becomes an assistant-prefill
    tail, `makeReady` restarts a crashed instance first, and up to 2 retries
    (`DEFAULT_TRUNCATION_RETRIES`) may complete the answer; exhausted retries
    return 502. The lease is not yielded between truncation retries — nothing
    preempted the request.
  - strict + external endpoint → `error`: prefill continuation is unreliable
    on third-party APIs, so a truncated stream is a 502 immediately.
  - tolerant → `accept`: today's legacy behavior — the buffered text is
    finalized (the synthesized final still fabricates `stop`), but the trace
    marks it truncated and the response is never cached.
- **Buffered non-stream path** (`consumeResumableSse` in
  `proxy/protocol-endpoint.ts`): no retry loop exists here — strict returns
  502, tolerant accepts and flags the trace.
- **Restart replay** (`proxy/resume-replay.ts`): the replay source is a managed
  llama-server, so a truncated replay is always a 502.
- **Fusion branches** (`proxy/fusion.ts`): a truncated branch fails with a
  branch error; fusion voting must not run on partial answers.
- **Pass-through streaming** (usage meter tract): the client sees the raw
  bytes and judges for itself — the proxy never converts a live truncation
  into an error, it only records the observed terminal in the trace and blocks
  the response cache.

A truncated response must never be served again from cache:
`markTruncated` on the response-plan executor (`proxy/response-plan.ts`) blocks
the `cache-store` effect. It is a separate flag from the loop-guard's
`responseTruncated`, which feeds the loop-guard artifact and must not be
conflated with upstream truncation. On the streaming tract the usage meter's
`onStreamEnd` hook fires in the meter's transform flush — upstream of the
response-plan tap, so the mark lands before the plan's own flush decides
cacheability. The hook deliberately does not fire when the client aborts
mid-stream (the transform flush never runs on cancel), so client aborts are
not misclassified as upstream truncation.

## Malformed payloads

`parseChunk` on both protocol codecs returns `"malformed"` for an SSE `data:`
payload that is not parseable JSON or not a JSON object — distinct from `null`,
which stays "recognized and ignorable" (pings, unknown event types). Consumers
count malformed payloads instead of silently dropping them:
`ResumableBufferState.health` and the usage meter both keep a count plus a
bounded sample of the first offender. `applyProxyStreamHealth`
(`proxy/stream-health.ts`) merges the counts into the request trace and logs a
warning through the shared logger with the sample — the swallowed-error rule
applied to stream parsing. A malformed payload never aborts the stream; the
count is diagnostic.

The sans-IO Anthropic↔OpenAI bridge package keeps its own parsing and is not
covered by this accounting; the translated streaming path reports no terminal.

## Idle timeout

A stalled upstream — connection open, no bytes — used to hold its domain lease
until the client gave up (the undici transport in `proxy/http.ts` only caps
inactivity at one hour). `watchStreamIdle` (`proxy/stream-idle.ts`) wraps an
upstream body with a per-read inactivity deadline that re-arms on every chunk;
SSE keepalive comments arrive as bytes, so they reset it too. On expiry the
wrapped stream errors with `StreamIdleTimeoutError` and the upstream reader is
cancelled — a stall never surfaces as a clean EOF (which would re-open the
truncation-masking hole).

Resolution order for the deadline: `ApiEndpointRecord.streamIdleTimeoutMs` →
proxy-wide `streamIdleTimeoutMs` in `config/proxy/settings.json` →
`DEFAULT_STREAM_IDLE_TIMEOUT_MS` (300 s). A value of `0` at either level
disables the watchdog; the endpoint editor and the endpoints page expose both
knobs in seconds. Managed llama instances keep progress frames flowing during
prefill (`return_progress` injection), so the default does not bite long
prefills there; engines without SSE timings doing very long silent prefill are
the reason the proxy-wide knob exists.

Enforcement: resumable attempts and buffered consumption see the stall as an
error outcome (502 with the stall message — deliberately no truncation-style
retry: a wedged server would likely wedge again while double-holding the
lease); pass-through streaming errors the client stream mid-flight and stamps
the trace with `arriero_proxy_upstream_timeout`; restart replay is watched the
same way. The delegating node does not watch delegated streams — the owning
node enforces its own timeout, and undici's transport timeout stays the outer
bound.

## Trace surface

`ApiProxyRequestTraceSchema.streamHealth` records `malformedChunks`,
`terminal` (`done`/`finish`/`eof`), `truncated` and `truncationRetries`. The
traces table at `#/proxy/traces` shows `truncated` (red), `re-stitched`
(yellow — the stream was cut off but truncation retries completed it) and
`malformed` (orange) badges in the Stream column; the full object is visible in
the trace inspector. `streamHealth` stays `null` for flows where nothing was
measured (non-SSE responses, translated Anthropic streaming).
