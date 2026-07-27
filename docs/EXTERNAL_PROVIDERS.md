# External providers (passthrough & curated)

How models from an external OpenAI/Anthropic-compatible provider (OpenRouter, Groq, a remote llama-server, …) reach the proxy. The data model is two layers, not three: an **endpoint** is the upstream connection, and a **model** routes either to a managed target/pipeline or **straight to an endpoint**. The old per-external-model `target` record is gone — external routing collapses into `model.routeTo = {type: "endpoint", …}` (resolved to a synthetic, non-persisted target at request time, so the scheduler/lease/forwarder path stays uniform). Targets remain only for managed instances, where preemption/slots are real.

## Endpoint auth

An endpoint carries one optional key and a profile; there is no auth-type enum.

- `apiKey` — stored in `data/config/.secrets.json` (gitignored, write-only through the API). Mutually exclusive with `apiKeyEnvVar` (setting both is a 400 on create; on update the env var wins and clears the stored key).
- `apiKeyEnvVar` — name of a server env var holding the key. Names starting with `ARRIERO_` are rejected (so the admin API can't be tricked into exfiltrating the manager's own secrets to an attacker-controlled `baseUrl`).
- **Placement** is derived from `profile`: `openai`/`llama-native` → `Authorization: Bearer <key>`; `anthropic` → `x-api-key: <key>` + `anthropic-version: 2023-06-01`. Set `authHeaderName` to override the header (the key goes there verbatim instead).
- `extraHeaders` — a `{name: value}` record sent with every request (and the `/models` probe), e.g. OpenRouter attribution `HTTP-Referer` / `X-Title`. Applied after auth, so a user-provided header wins.
- No key at all = a public endpoint; only `extraHeaders` are sent. A named-but-unset env var is the only error case.

Resolution lives in `apiEndpointAuthHeaders` (`proxy/endpoints.ts`).

## Passthrough endpoints (the OpenRouter case)

Set `passthrough: true` on an endpoint to expose **all** of its models by name without a per-model record — the right shape for a provider with hundreds of models.

- **Request resolution** (`proxy/passthrough.ts:resolvePassthroughModel`): when an incoming `model` id matches no explicit `config/proxy/models.json` entry, the proxy consults enabled passthrough endpoints. The first whose `modelFilter` admits the id owns it (ties broken toward an endpoint whose cached `/models` list contains the id); a synthetic model routed to that endpoint with `upstreamModel = <requested id>` is forwarded as-is. Resolution is synchronous and filter-based, so a cold cache never blocks or fails a request — an unknown id simply surfaces the upstream's own error.
- **Listing** (`proxy/passthrough.ts:listPublicProxyModels`): `GET /v1/models` merges each passthrough endpoint's upstream `/models` catalog (fetched + 60 s TTL cached in `proxy/endpoint-models.ts`, filtered by `modelFilter`, `owned_by` = endpoint name) on top of the explicit visible models. Passthrough models report load state `loaded`.
- **`modelFilter`** = `{allow?: string[], deny?: string[]}` of case-insensitive globs (`*` wildcard). `allow` (if non-empty) must match; `deny` always excludes. Empty/absent = admit everything. The matcher is the pure `apiEndpointModelFilterAdmits` in core (shared by request resolution and listing).

## Curated external models

To publish a renamed/curated external model (custom public id, visibility, a pipeline in front), create a `config/proxy/models.json` entry with `routeTo: {type: "endpoint", endpointId, upstreamModel}`. `upstreamModel` null = forward the public id unchanged. This is the non-passthrough path and coexists with passthrough on the same endpoint (an explicit entry shadows the dynamic one by id).

## Reference

llm-arena (`~/llm-arena`, `docs/providers.md`) debugged the same provider/variant split first: provider = endpoint, variant = a model at a provider chosen from a `/models` probe. This refactor adopts its auth model (key XOR env var, profile-derived placement, extra headers) and its `/models` fetch, and adds passthrough so a big catalog needs zero per-model records.

See `docs/API_PROXY_FOUNDATION.md` for the surrounding proxy architecture and `docs/STATUS_LAYERS.md` for the public `/v1/models` status contract.
