# Engine adapters

llama-manager is prepared for (but does not yet ship) a second inference engine (vLLM, SGLang, …). The seam is a **static per-kind engine descriptor** in `packages/core/src/engine-descriptor.ts`; all previously hardcoded llama-server assumptions in the process, arguments, memory-estimate, and proxy layers route through it. This document is the contract: what a descriptor declares, which api-side registries implement its ids, what is llama-only by design, and the checklist for plugging in a new engine.

## Two-layer model

- **Generic layer** (engine-agnostic, needs no changes per engine): resource pools + ledger + admission (`resources/*`, `buildResourceLedger`, `checkDrawAdmission`), the compute-domain coordinator/lease, the pure scheduler + callback-driven executor, spawn/adopt/reconcile process supervision, path-catalog binary references, protocol adapters and pipelines.
- **Engine layer** (selected by the descriptor): health probing, readiness/log parsing, argument-catalog `--help` parsing, engine-specific preflight, memory estimation, resource-profile derivation, and the proxy capability set.

## The descriptor

`engineDescriptor(kind)` returns a pure-data record (core is bundled into the web app — **no node APIs, no I/O in core**). Registered kinds live in `INSTANCE_KINDS`; `Record<InstanceKind, EngineDescriptor>` exhaustiveness makes the compiler point at every spot a new engine must fill in.

| Field | Meaning | llama-server | rpc-worker | vllm |
| --- | --- | --- | --- | --- |
| `displayName` | Human name used in health-status reasons | `llama-server` | `rpc-server` | `vLLM` |
| `http` | Default host/port + arg keys for host/port/api-prefix (`instances/endpoint.ts`) | 8080, `--host`/`--port`/`--api-prefix` | 50052, `--host`/`--port`,`-p` | 8000, `--host`/`--port` |
| `proxy` | Capability booleans consumed by the proxy (below) | all `true` | all `false` | serve + lease only |
| `probe` | Probe implementation id + whether `/health`-style HTTP health exists | `llama-http`, `httpHealth: true` | `tcp-accept`, `httpHealth: false` | `openai-http`, `httpHealth: true` |
| `nativeApi` | llama-native HTTP surface | `llama` | `none` | `none` |
| `launch` | Slot-path injection, argv builder, fixed prefix | slot path, `flag-map`, `[]` | no slot path, `flag-map`, `[]` | no slot path, `flag-map`, `["serve"]` |
| `preflight.engineChecks` | Engine-specific preflight module id | `llama-server` | `none` | `none` |
| `preflight.argumentCatalogParser` | help implementation id | `llama-help` | `none` | `vllm-help` (`serve --help=all`) |
| `logs.parser` | Log-parser id | `llama` | `llama` | `vllm` |
| `estimator` | A-priori memory-estimator strategy id | `gguf` | `none` | `none` initially |
| `resourceProfile` | Resource-profile strategy | `llama-args` | `rpc-device-args` | `vllm-args` |

String ids select **api-side implementations** from `Record`-keyed registries, keeping I/O out of core:

| Id enum | Registry | Implementations |
| --- | --- | --- |
| `EngineProbeId` | `apps/api/src/process/engine-probe.ts` | `llama-http`, `tcp-accept`, `openai-http`; vLLM uses real health/models probes and explicit not-applicable llama-native fields |
| `EngineLogParserId` | `apps/api/src/process/log-parsers/index.ts` | `llama`, `vllm` |
| `EnginePreflightId` | `ENGINE_PREFLIGHT_CHECKS` in `apps/api/src/process/preflight.ts` | `llama-server` → `preflight-llama.ts` (path args, router-mode rule, gpu-layers vs nvidia-smi, argument compatibility), `none` → skip |
| `EngineArgumentCatalogParserId` | `HELP_PARSERS` + `HELP_INVOCATIONS` in `apps/api/src/arguments/catalog.ts` | `llama-help`, `vllm-help`; each owns argv, timeout, and parser. Route generation is async; cache rows/sidecars carry `parserId` |
| `EngineArgvBuilderId` | `ENGINE_ARGV_BUILDERS` in `apps/api/src/process/argv.ts` | `flag-map` → positionals first, then alphabetically sorted `--flag value` pairs with CSV arrays (the launch snapshot consumes it, so drift/adoption see positional changes automatically) |
| `EngineEstimatorId` | gate in `apps/api/src/memory-estimate/service.ts` | `gguf` → `estimateInstanceMemory`; a second estimator adds dispatch here (reuse the `MemoryEstimate`/`draws` output contract) |
| `EngineResourceProfileId` | dispatch inside `packages/core/src/instance-resources.ts` | `llama-args`, `rpc-device-args`, `vllm-args` |

## Proxy capability flags

`EngineDescriptor.proxy`, adapted per-request by `proxyEngineGates(instance | null)` (`apps/api/src/proxy/engine-capabilities.ts`; no instance ⇒ all false, which makes external endpoints' implicit opt-out explicit):

- `serveEndpoint` — the instance appears in the endpoint catalog / can be a proxy target (`proxy/endpoints.ts`, `proxy/target-models.ts`).
- `requestLease` — reserved: participates in compute-domain leasing (currently unread; kept for the planner).
- `modelLoadUnload` — llama-server router verbs `POST /models/load|unload` exist; without it the scheduler falls back to `stop-instance`/`start-instance`.
- `slotSave` — KV-slot save/restore (`POST /slots/:id?action=save|restore`) for preemption; without it no `save-slot`/`restore-slot` actions are planned, and the web target editor hides the slot fields (`ProxyTargetsView` resolves the draft's endpoint → instance kind → this flag).
- `streamResume` — server-side stream sessions (`x-conversation-id`, `/v1/stream/:id`), see `docs/STREAM_RESUME.md`.
- `sseTimings` — llama.cpp SSE extensions (`timings`, `prompt_progress` via `return_progress`) powering live TTFT/prefill metrics and slot correlation.

Scheduler-side gating is documented in `docs/API_PROXY_FOUNDATION.md` § Engine capability gating.

## llama-only by design

Not everything generalizes; these stay llama-specific implementations behind optional capabilities, not abstractions:

- KV slot save/restore and stream-resume sessions (no vLLM-style equivalent; portable preemption resume is the assistant-prefill path in `resumable-forward.ts`).
- RPC workers (`rpcWorkers`, `rpc-launch.ts`, `rpc-preflight.ts`, `managed-lifecycle.ts`, `nodes/rpc-worker-catalog.ts`) — llama.cpp distributed inference; other engines do multi-GPU with in-process flags, so no generic "distributed backend" concept is warranted.
- Router mode (`--models-preset`) and per-model `/v1/models` status objects.
- The argument canonical registry, Russian help overlay, and docs pipeline (`content/llama-args/`, `arguments/registry.ts`) — post-processing tied to the `llama-help` parser.
- The API Lab llama-native probe bodies (`api-lab/`, `llama/api-probe-request.ts`) and `/api/instances/:id/llama` diagnostics route.

## Preserved quirks (do not "fix" without intent)

- The offline probe payload for a stopped rpc-worker keeps the llama HTTP shape (port-8080 `/health` URLs) — it is an API payload consumers already see.
- Two `deriveStatus` strings ("…llama-server health is OK." on stale, "…waiting for llama-server readiness." on starting) are reachable by rpc-workers and stay literal; templating them would change today's output for rpc-workers.
- `probe.httpHealth: false` currently selects the rpc-worker readiness *policy* too — an unanswered probe still reports `ready` ("may be busy serving the orchestrator"). A future engine with a non-llama health surface must not blindly set `httpHealth: false`; the policy needs splitting out (e.g. `probe.authoritative`) before that engine lands.
- `filterManagedLlamaLogChunk` (probe-noise log filtering) applies to both kinds.
- Cross-node delegation injects `return_progress` before the sending node knows the remote engine (harmless today).

## New-engine checklist

1. Add the kind to `INSTANCE_KINDS` and write its `EngineDescriptor`; the `Record` exhaustiveness and this doc's registries are the to-do list.
2. Implement and register: a probe (`engine-probe.ts`), a log parser (`log-parsers/`), a preflight module (or `none`), a `--help` parser (or `none` — the instance form then has no catalog; catalog resolution is kind-threaded end to end: `GET /api/llama-args?kind=` picks the parser and the web form sends its selected kind), an argv builder (or reuse `flag-map`; `instance.positionalArgs` covers `serve <model>`-style subcommand launches), a resource-profile strategy, an estimator (or `none` — draws are then declared manually, which the ledger already supports).
3. Decide the `proxy` flags honestly; `modelLoadUnload:false` + `slotSave:false` + `streamResume:false` + `sseTimings:false` yields a correct start/stop-only managed target (the scheduler restarts the process from `unloaded` state instead of emitting load verbs).
4. Decide `nativeApi` honestly: only `"llama"` renders the llama runtime panels (probe pills, Models, Slots, Capabilities, Web-UI button) in instance details; an OpenAI-compatible engine that does not speak llama's `/props`/`/slots` must say `"none"` even though it has HTTP health.
5. If the engine forks worker children (tensor-parallel runtimes), extend the descendant-process matcher in `process/runtime-memory.ts` (`isLikelyLlamaServer` filters on the llama-server command name) — otherwise worker VRAM/RSS vanishes from the memory layout and the scheduler evicts into occupied memory.
6. Path-catalog binary entries carry an optional engine-kind tag; preserve basename inference only for untagged legacy entries. Validate tagged binaries against the instance kind at the API boundary.
7. Out of scope until an engine needs it: a shared model-entity format discriminator (HF/safetensors directories vs GGUF files). Engine provisioning and positional model input are implemented by their own descriptor-driven domains rather than added to the llama CMake/model pipeline.
