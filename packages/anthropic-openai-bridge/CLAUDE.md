# CLAUDE.md — @arriero/anthropic-openai-bridge

Sans-IO translation between the Anthropic Messages API and OpenAI Chat Completions (request, non-stream response, SSE stream re-emission, errors). Built for eventual extraction/publication as a standalone npm package — the boundaries below are the whole point of its existence as a separate workspace package.

## Hard boundaries

- **Zero runtime dependencies. No imports from other workspace packages** (including `@arriero/core`) and no I/O: no fetch, no streams, no timers, no randomness — strings and plain objects in, typed events/objects out. If a change needs any of these, it belongs in the consumer (`apps/api/src/proxy/translation.ts`), not here.
- **Dialect specifics enter only through options** (`reasoningField`, `thinkingBudgetField`, `reasoningEffortField`, `namedToolChoice`, `toolResultImages`, `passthroughKeys`, `messageIdPrefix`). Never hardcode llama.cpp behavior; the llama-server preset lives in the consumer.
- **Inputs are untrusted JSON** — parse defensively via `json.ts` guards, never throw on malformed input. Requests degrade with `warnings[]`; the stream emitter skips unparseable frames.

## Layout

- `request.ts` — `translateAnthropicRequest(body, opts)` → `{ body, warnings }`.
- `response.ts` — non-stream OpenAI→Anthropic + `anthropicMessageId` prefixing.
- `stream.ts` — `createAnthropicSseEmitter`: stateful; one OpenAI `data:` payload string per `push()` → `{ events, extensions }`; `finish()` closes open blocks after an aborted stream. `extensions` (raw `prompt_progress`/`timings`/`usage`) is the host telemetry side-channel — these are never emitted as Anthropic events.
- `errors.ts` (HTTP status → Anthropic error type), `finish-reason.ts`, `usage.ts` (`input_tokens` = `prompt_tokens` − `cached_tokens`), `sse.ts` (event serialization), `types.ts` (event unions), `json.ts` (guards).

## Stream invariants (Anthropic SDKs are strict — covered by golden tests in `stream.test.ts`)

- A thinking block closes with `signature_delta` (empty signature) before its `content_block_stop`.
- `tool_use` `content_block_start` always carries `input: {}`; each OpenAI `tool_calls[].index` opens its own block.
- `message_start` is emitted on the first chunk, usage seeded from `prompt_progress` when already seen (else zeros); subsequent progress-only frames become `ping`; cumulative usage lands in `message_delta`.
- `message_delta` + `message_stop` are emitted only on `[DONE]` or `finish()` — a finish_reason chunk just closes the open block, because a usage-only chunk may still follow.

## Commands

`pnpm --filter @arriero/anthropic-openai-bridge build|check|test` (Node test runner via tsx; tests assert exact event sequences). Consumers import the built `dist` in prod and tests; in dev the `development` exports condition resolves to `src` directly, no rebuild needed.

Mapping rationale and intentional spec deviations: `docs/ANTHROPIC_OPENAI_BRIDGE.md` at the repo root.
