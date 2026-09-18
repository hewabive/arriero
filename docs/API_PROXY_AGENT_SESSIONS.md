# Agent session forwarding

The OpenAI facade forwards the two rag-manager session operations needed by
llm-arena A/B continuations:

| Method | Public path (also under `/proxy/v1`) | Purpose |
| --- | --- | --- |
| GET | `/v1/agent-requests/:requestId` | Inspect the logical request and its committed session heads |
| POST | `/v1/agent-sessions/clones` | Clone the selected history/workspace heads, optionally assigning another external user |

These requests have no model selector. They use one explicitly configured external
endpoint instead of a model routing pipeline. Other agent/admin paths are not
forwarded. Generation continues through the normal `chat.completions` route.

## Configuration

`proxy/settings.json` has nullable `agentSessionEndpointId`, default `null`
(disabled). Set it through `PATCH /api/proxy/settings`, using the ID of the same
external rag-manager endpoint that receives the agent models:

```json
{ "agentSessionEndpointId": "<rag-manager endpoint ID>" }
```

Clear with `null`. Omitted fields preserve the current value. Only existing external
endpoints are accepted; managed instances and the generated manager endpoint are
not eligible. The admin API refuses deletion of the selected endpoint until the
setting is cleared. Config-tree validation rejects dangling references. Disabling
the endpoint makes these public operations return 503.

Both generation and session requests must reach the same rag-manager server and
bearer principal. Reuse the endpoint's normal stored/env credential and extra
headers. Changing this setting does not migrate sessions. There is no automatic
backend discovery, cross-server transfer or fallback to another endpoint.

## Request handling

`proxy/agent-sessions.ts` registers an explicit operation table under both OpenAI
prefixes. It uses the same source-key gate as generation: anonymous policy,
unknown-key policy and disabled-source rejection apply before forwarding.
Endpoint authentication and extra headers use the shared endpoint resolver and
forwarder; incoming identity headers are preserved unless explicitly overridden
by endpoint headers, exactly as for generation.

Request IDs are decoded and re-encoded as one path segment, including IDs with
colons, non-ASCII text, slashes or percent signs. Clone JSON is forwarded without
inserting a model, rewriting ownership, dropping unknown fields or applying
defaults. rag-manager owns payload validation and head-conflict semantics.
Malformed JSON is rejected locally with 400. Upstream status, response headers
and body pass through; response caching is disabled with `Cache-Control: no-store`.

The forwarding deadline is 15 seconds including response-body consumption. Network
failures return 502 and timeouts 504; no automatic retry is made. A timeout or
disconnect does not prove that a clone was not created. Callers must treat partial
preparation as failed and start no agents until every intended branch is confirmed.

Operations appear in proxy traces as `agent-requests.get` and
`agent-sessions.clones`, with source, endpoint and status. `modelId` is empty because
no model participates; request/response bodies are not captured. There is no model
scheduling, inference usage metering, pipeline transformation, response cache or
stream resume on this path. The usual proxy drain gate rejects requests while
restarting.

Focused verification:

```bash
pnpm --filter @arriero/core build
pnpm --filter @arriero/api exec tsx --import ./src/test/setup-env.ts \
  --test src/proxy/agent-sessions.test.ts src/proxy/settings.test.ts
```
