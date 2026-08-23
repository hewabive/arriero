# API proxy: reasoning-effort mapping

Code agents request a reasoning intensity in protocol-specific fields, and
models expose incompatible native interfaces for it: discrete effort levels
with a model-specific vocabulary (Qwen3.8: `low/medium/xhigh`, GPT-OSS:
`low/medium/high`), a thinking-token budget, or a bare on/off flag. The proxy
bridges the two through a canonical directive and an upstream reasoning
profile that is **resolved where the upstream is actually known — at the
forward boundary, after the pipeline picked the target** — so `condition`
routing and `fusion` panels map each branch against its own instance, and a
peer node maps delegated requests against its own local instance. Pure logic
lives in `packages/core/src/proxy/reasoning.ts`; resolution and the mapping
hook in `apps/api/src/proxy/reasoning-request.ts`; template detection in
`apps/api/src/models/chat-template-reasoning.ts`.

## Canonical directive

`ApiProxyReasoningDirective` — `off` | `auto` (thinking on, intensity
unspecified) | `{level}` | `{budget}`. The canonical level ladder is
`minimal < low < medium < high < xhigh < max` — the union of the OpenAI and
Anthropic vocabularies (Claude Code sends `output_config.effort` with
`low/medium/high/xhigh/max` plus `thinking {adaptive}`; verified against the
Claude Code 2.1.x bundle).

`extractApiProxyReasoningDirective(protocol, body)` reads, in priority order:

- **openai** — `reasoning_effort` (`"none"`/`"off"` ⇒ off) → `reasoning.effort`
  → `chat_template_kwargs.reasoning_effort` → `thinking_budget_tokens` /
  `reasoning_budget_tokens` (`0` ⇒ off) → `chat_template_kwargs.enable_thinking`.
- **anthropic** — `thinking.type === "disabled"` ⇒ off (wins over effort) →
  `output_config.effort` ⇒ level → `thinking {enabled, budget_tokens}` ⇒
  budget → `thinking {adaptive}` ⇒ auto.

Unknown level spellings degrade to `auto` (never an error); recognized
synonyms normalize (`x-high`/`ultra` → `xhigh`, `maximum` → `max`).

## Profile resolution at the forward boundary

`prepareApiProxyUpstreamRequest` (`reasoning-request.ts`) is the one
composition of that boundary: it runs `prepareUpstreamExchange` then
`applyApiProxyReasoningMapping`, records translation warnings and the
reasoning trace step when handed a trace accumulator, and is called from
`respond()` / `respondResumable()` (`protocol-endpoint.ts`), per fusion
branch (`fusion.ts`), and in the resume-claim key derivation
(`resume-replay.ts`, so a retried stream still matches its persisted
session). At that point the body is post-translation (openai-shaped for every
managed upstream), the instance is known, and
`resolveApiProxyUpstreamReasoningProfile` picks, in precedence order:

1. **`ApiProxyModelRecord.reasoning`** (nullable) — an explicit operator
   override: `{kind:"preset", preset}` (built-ins: `qwen3.8`, `gpt-oss`,
   `thinking-budget`, `enable-flag`, `native-passthrough`, `non-reasoning`)
   or `{kind:"custom", profile}` for a future model's ladder — no code
   change, editable in `config/proxy/models.json` (the UI select offers
   presets and preserves a custom profile).
2. **Template autodetection** for llama-engine instances: instance →
   `resolveModelPath(args)` → `model_cache` → the derived
   `metadata.chatTemplateReasoning` (see below). A template that uses
   `reasoning_effort` yields a `template-effort` profile with the extracted
   ladder and aliases.
3. **Engine default** for llama instances whose template does not take
   `reasoning_effort`: the `budget` interface —
   `thinking_budget_tokens`/`enable_thinking` work at the engine level for
   any llama model.
4. Otherwise (external providers, Python engines, no instance): no mapping —
   canonical fields pass through as sent (the bridge already translates
   Anthropic `output_config.effort`/`thinking {adaptive}` to
   `reasoning_effort`/`enable_thinking`).

The instance-derived branch (2–3) reads the instance record and the model
cache row, so it is memoized per instance with a 2 s TTL (the same staleness
budget as `getCachedApiProxyRuntimeSnapshot`) — a hot request path never
re-reads `model_cache` per request, and an instance-args or template change
is picked up within 2 s.

With a profile, the mapping extracts the directive, strips every native
effort field and re-materializes: levels project onto the ladder (aliases
first, then nearest by canonical rank, ties toward the higher level — Qwen3.8
hard-fails via `raise_exception` on unknown values, which is exactly why the
proxy clamps; a tolerant profile keeps sub-ladder levels unchanged, see
Template autodetection); budgets quantize via `apiProxyReasoningLevelFromBudget`;
levels convert to budgets via `apiProxyReasoningLevelBudgets`
(256/512/2048/8192/24576/-1, overridable per profile). A request with **no
reasoning fields stays byte-identical** unless the profile sets
`defaultLevel`. The step lands in `trace.routeTrace` (kind `reasoning`,
nodeName `reasoning profile (<source>)`) and `POST /api/proxy/route-explain`
resolves the same profile for the routed target (its dry-run maps in the
inbound protocol shape, before translation — a deliberate approximation).

## Template autodetection

`extractChatTemplateReasoning` (pure, over the `tokenizer.chat_template`
string already stored in `model_cache` raw facts) detects `reasoning_effort`
/ `enable_thinking` usage and extracts the ladder from two known template
conventions:

- **Guard** (Qwen3.8): `not in ('xhigh', 'medium', 'low')` membership test —
  the authoritative source when present; aliases come from
  `== 'high' → set … = 'xhigh'` branches.
- **Equality chain** (DeepSeek V4): `reasoning_effort == '<level>'` /
  `elif` comparisons — the fallback; alias sources are excluded, and a
  single-value result is discarded rather than promoted to a ladder.

The extractor also derives `strict`: whether a `raise_exception` call sits
within 300 characters after a `reasoning_effort` mention — i.e. whether the
template rejects unknown values (Qwen3.8) or silently ignores them
(DeepSeek V4 treats anything that is not `high`/`max` as its baseline). The
profile carries the flag: a **strict** ladder clamps every canonical level
onto it (nearest, ties up), a **tolerant** ladder passes levels below its
lowest rung through unchanged — that is the template's baseline semantics —
and projects only levels at or above it (`xhigh` → `max` on DeepSeek V4).

The result is the derived metadata field `chatTemplateReasoning` (parser
version 13); a parser bump re-derives from cached raw facts on read, so
detection works without a re-scan. Extraction is conservative: an
unconventional template yields `levels: null` → the profile keeps an empty
ladder and passes canonical levels through unclamped — and that state is
**deliberately loud**: `InstanceHealthSummary.reasoningTemplateIssue`
(`{strict}` | null, computed from the same cached `instanceReasoningProfile`)
drives a `reasoning template` badge on the instance (red for strict
templates — requests can fail with a template error; yellow for tolerant
ones — levels may be silently ignored), lists the instance on the
dashboard's "Instances needing attention" card, and renders as a warning
callout in the diagnostics panel. The fix is either a reasoning override or
teaching the extractor the new convention; only a recognized template clears
the badge — a model-level override fixes traffic routed through that proxy
model but stays per-model (the panel lists such overrides right below the
callout), so the instance-level badge persists until detection works.
llama-server's `/props.chat_template_caps.supports_reasoning_effort` is the
live confirmation of the same paradigm, surfaced in the diagnostics panel
below.

## Diagnostics panel

`GET /api/instances/:id/reasoning-profile` returns the instance-resolved
profile (`ApiProxyUpstreamReasoningProfile` in core: `profile` + `source`,
`null` = passthrough) via the same cached `instanceReasoningProfile` the
forward boundary uses — model-override precedence is deliberately excluded
(it is per proxy model, not per instance). The web renders it as the
"Reasoning effort" accordion item on the Diagnostics page
(`InstanceReasoningPanel`): interface + source, the native ladder (with a
`tolerant template` marker for non-strict ones) or a warning callout when the
ladder is unrecognized, a
requested→sent table computed client-side with
`projectApiProxyReasoningLevel` (only remapped levels, annotated
alias/nearest), level→budget badges for the budget interface, the live
`/props.chat_template_caps.supports_reasoning_effort` confirmation when the
instance is running, and the bound proxy models whose `reasoning` override
supersedes the shown profile (via `computeInstanceProxyBindings`).

## Reasoning pipeline node

The `reasoning` node is a **canonical override**, model-agnostic: `auto`
keeps the inbound directive (no body edits); a static effort writes the
canonical fields in the inbound protocol shape (openai: `reasoning_effort` /
`thinking_budget_tokens`; anthropic: `output_config.effort` +
`thinking {adaptive|enabled|disabled}`), replacing whatever the client sent —
the forward-boundary profile then maps the overridden value like any other.
`custom` remains a raw token budget.

## Translation warnings

Bridge warnings (dropped fields, untranslatable tools) are no longer
discarded: `prepareUpstreamExchange` surfaces them and the endpoint records
them into `trace.translationWarnings` (traces table status tooltip + full
trace inspector). This is also the discovery tool for future client
wire-format changes: an unrecognized effort field shows up as an
`unsupported field … dropped` warning on real traffic.

## Known limits

- A model-level override does not travel with remote delegation — the peer
  resolves its own profile (autodetect covers the normal case).
- Router instances (`--models-preset`, no `--model`) have no single GGUF to
  detect from → engine-default budget profile; use a model override for
  per-model ladders behind a router.
- Python engines get no autodetection (no GGUF template) — passthrough unless
  overridden.
- `output_config.format` (structured outputs) is out of scope — the bridge
  drops it with a warning.
