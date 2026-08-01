# API proxy round-trip response pipeline plan

## Implementation status

Implemented through all seven delivery phases. The response plan is shared by
managed/external targets, remote delegation, translation, resume/replay,
cache hits, buffered/live SSE and fusion's final-producing branch. Workspace
checks and the full API regression suite are required before each release.

## Goal

Turn the request-only routing graph into a round-trip pipeline. Requests run
toward the selected target; response effects unwind in reverse order. This is
the common foundation for positional response capture/cache, response-side
text replacement, and client-visible token scaling.

## Data planes and invariants

Every proxy exchange has three deliberately separate representations:

1. **Ingress request** — the immutable parsed request as it entered Arriero's
   public model API, before routing transforms, target model overrides, or
   protocol translation.
2. **Target observation** — the request sent to the selected target and the
   response observed from it. Actual usage, TTFT, generation rate, reasoning,
   answer, and tool-call previews belong to this plane.
3. **Client delivery** — the client-protocol response after translation and
   the response-side pipeline.

Request history and operational surfaces such as Proxy load use ingress and
target-observation data. User-configured response effects cannot rewrite those
observations. Explicit Save request/response nodes are different: they capture
the value at their exact position in the pipeline and may therefore contain
transformed data. A cache hit records that no target was called rather than
inventing a target response.

Full request and response bodies are not automatically persisted for every
exchange. History keeps operational metadata and previews; Save nodes remain
the opt-in mechanism for complete bodies.

## Round-trip semantics

For a route:

```text
Save A -> Replace -> Save B -> Target
```

the two directions are:

```text
request:  Save A -> Replace -> Save B -> Target
response: Target -> Save B -> Replace -> Save A -> Client
```

The route resolver records serializable response-effect descriptors in request
encounter order. The response executor applies them in reverse. Conditions
contribute effects only from the selected branch. Call/exit and pipeline jumps
preserve the effects accumulated along the actual path. Each fusion branch has
its own plan; the final-producing branch composes with the outer plan.

Initial effect kinds:

```ts
type ProxyResponseEffect =
  | CaptureResponseEffect
  | CacheStoreEffect
  | ReplaceTextEffect
  | TokenScaleEffect;
```

## Response execution boundary

All target paths converge on this order:

```text
target response
  -> target observer and actual-usage meter
  -> upstream-to-client protocol translation
  -> response-plan executor
  -> client
```

The boundary applies to managed and external targets, remote delegation,
buffered and streaming responses, resumable/replayed streams, cache responses,
and fusion. Target observation always precedes user effects, so operational
TTFT is not inflated by a streaming replacement's ambiguity buffer.

## Lossless response codecs

The executor needs codecs separate from the current observation-oriented,
lossy resumable codecs.

For JSON responses, a codec parses a successful response, exposes only
protocol-semantic mutable fields, executes effects, and serializes once. A
parse failure is passed through unchanged.

For SSE, the framing layer must support LF and CRLF separators, multiple data
lines, event/id fields, comments, unknown fields, `[DONE]`, backpressure, and
cancellation. Protocol codecs cover OpenAI Chat/Completions, OpenAI Responses,
and Anthropic Messages. They preserve the original event while exposing text
lanes and token-usage containers, and can emit a synthetic text delta before a
finish/usage/stop event when a transform still has buffered text.

## Positional Save response and cache

Each response capture is an effect, not an entry in a global capture list. A
JSON capture stores the value at that stage. An SSE capture taps the stream at
that stage. Response files are created in actual unwind order, nearest target
first.

On a cache miss, the cache-store effect persists the response at the cache
node's response boundary:

```text
Target -> downstream effects -> Cache store -> upstream effects -> Client
```

On a hit, downstream nodes do not run because their result is already present
in the stored value. Existing cache entries are invalidated by a cache-key
format version when this contract is introduced. Streaming fan-out and
coalescing obey the same boundary.

## Response-side Replace text

Existing configurations remain request-only by default:

```json
{
  "rules": [],
  "request": true,
  "response": false
}
```

Response replacement defaults to visible assistant text. Reasoning and tool
arguments are independent opt-in scopes; tool arguments default off. IDs,
model names, finish reasons, tool names, usage, and arbitrary metadata are not
modified.

Literal replacement in a stream is stateful. Per rule and per independent text
lane, it retains the longest suffix that can still become a prefix of `find`,
emits text once it cannot participate in a future match, recognizes matches
across events, applies rules in declared order, and flushes pending text before
normal stream termination. Choices, content blocks, reasoning, visible text,
and tool-argument lanes never share matcher state. Arbitrary regular
expressions are outside this bounded-streaming contract.

## Token scale

Token scale is added only after the shared response pipeline is operational.
Its factor is client-visible tokens divided by real target tokens:

```text
target request limit = floor(client limit / factor), minimum 1
client usage        = ceil(actual usage * factor)
```

Zero stays zero, negative unlimited sentinels are preserved, and totals are
recomputed from scaled primary components. Request limits are mapped by
protocol (`max_tokens`, `max_completion_tokens`, `max_output_tokens`, thinking
budgets, and supported llama.cpp extensions). Response mappings cover OpenAI
usage/details and Responses events, Anthropic usage/cache/details and Messages
events, and the top-level Messages count-tokens result.

Target observation, Request history, stats, inflight progress, and performance
rates remain actual. A positional Save response may see actual or virtual usage
depending on which side of the scaling node it occupies.

## Error policy

Response Replace text and Token scale initially apply only to successful model
responses. Save response retains the existing successful-response contract;
capturing error bodies can be introduced later as an explicit option rather
than silently broadening persistence.

## Delivery phases

1. ✅ Introduce explicit ingress/observation/delivery contracts and the ordered
   round-trip-plan data model without adding a new user-visible node.
2. ✅ Add central JSON/SSE response execution and lossless protocol codecs.
3. ✅ Migrate Save response and response cache to positional effects.
4. ✅ Extend Replace text to response JSON and stateful streaming text lanes.
5. ✅ Add Token scale on the shared request/response machinery.
6. ✅ Close integration coverage for translation, streaming/non-streaming,
   cache/coalescing, resume/replay, remote delegation, external targets, and
   fusion.
7. ✅ Update the canvas/editor, Route Explain, Request history labels,
   operational UI, and API proxy documentation; run the full regression suite.

Each significant phase is committed separately. Factor `1`, disabled response
replacement, and routes with no response effects must remain byte-transparent.
