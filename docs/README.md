# Documentation index

Depth lives here; the always-loaded rules live in `CLAUDE.md` at the repo root and in the nested
`CLAUDE.md` files inside each work zone. Read a document when you are about to touch its subject —
not before.

## API proxy

| Document | Subject |
| --- | --- |
| [API_PROXY_FOUNDATION](API_PROXY_FOUNDATION.md) | The map: contracts, pure planning layer, protocol adapters, admin surface, telemetry, request sources |
| [API_PROXY_PIPELINES](API_PROXY_PIPELINES.md) | Node-graph routing: node roster, ports, `call`/`exit` semantics, validation, `route-explain` |
| [API_PROXY_PREEMPTION](API_PROXY_PREEMPTION.md) | Context-switching scheduler: slot save/restore, eviction, resumable forwards |
| [API_PROXY_RESPONSE_CACHE](API_PROXY_RESPONSE_CACHE.md) | The `cache` node: keying, single-flight coalescing, streaming fan-out, framing-matched store |
| [API_PROXY_REASONING](API_PROXY_REASONING.md) | Reasoning-effort mapping onto native upstream interfaces, precedence chain, template autodetect |
| [API_PROXY_STREAM_HEALTH](API_PROXY_STREAM_HEALTH.md) | Valid stream terminals, per-endpoint strictness, malformed-payload accounting, idle watchdog |
| [API_PROXY_LOOP_GUARD](API_PROXY_LOOP_GUARD.md) | Repetition-loop detection and enforcement |
| [STREAM_RESUME](STREAM_RESUME.md) | Surviving a manager restart mid-generation |
| [EXTERNAL_PROVIDERS](EXTERNAL_PROVIDERS.md) | Endpoint-routed and passthrough external models, synthetic targets |
| [ANTHROPIC_OPENAI_BRIDGE](ANTHROPIC_OPENAI_BRIDGE.md) | Anthropic Messages ↔ OpenAI chat completions translation, deviations |
| [STATUS_LAYERS](STATUS_LAYERS.md) | The four status scopes and why they are not unified |

## Engines, arguments, builds

| Document | Subject |
| --- | --- |
| [INSTANCES](INSTANCES.md) | The instance definition domain: runtime projection, write semantics, endpoint derivation, cross-ref validation |
| [ENGINE_ADAPTERS](ENGINE_ADAPTERS.md) | The per-kind engine descriptor contract and the new-engine checklist |
| [ARGUMENT_HELP_WORKFLOW](ARGUMENT_HELP_WORKFLOW.md) | Updating the Russian engineering help for every engine (the single source of truth for the procedure) |
| [ARGUMENT_SOURCE_EXTRACTION](ARGUMENT_SOURCE_EXTRACTION.md) | Git-only declaration extraction for the Python engines; the `defaultValue` channel |
| [CASE_PHANTOM_HELP_ARGS](CASE_PHANTOM_HELP_ARGS.md) | Worked example of the help-block verification step |
| [BUILD](BUILD.md) | llama.cpp CMake builds and binary publication |
| [ENVIRONMENTS](ENVIRONMENTS.md) | Immutable uv-managed Python engine environments |
| [SOURCE_REPOSITORIES](SOURCE_REPOSITORIES.md) | Engine source checkouts, per-source tracking policy, drift report |
| [VLLM_OPERATIONS](VLLM_OPERATIONS.md) · [SGLANG_OPERATIONS](SGLANG_OPERATIONS.md) · [KTRANSFORMERS_OPERATIONS](KTRANSFORMERS_OPERATIONS.md) | Per-engine qualified profiles and release gates |
| [BACKGROUND_JOBS](BACKGROUND_JOBS.md) | The job kernel shared by build / envs / update / sources |

## Models and storage

| Document | Subject |
| --- | --- |
| [GGUF_PARSING](GGUF_PARSING.md) | Worker isolation and the two-layer model cache |
| [GGUF_QUANTIZATION_LABEL](GGUF_QUANTIZATION_LABEL.md) | Deriving the quantization label against the tensor table |
| [SAFETENSORS_PARSING](SAFETENSORS_PARSING.md) | Directory-as-model scanning, header + config sidecar capture |
| [HF_DOWNLOADS](HF_DOWNLOADS.md) | Hub browser, download jobs, resume, stall/ETA policy, sidecar manifest |
| [SHARED_MODELS_DIR](SHARED_MODELS_DIR.md) | One models directory on a network FS across hosts |
| [GGUF_MEMORY_TEST_MODELS](GGUF_MEMORY_TEST_MODELS.md) | Rolling menu of concrete GGUF artifacts for estimator testing |

## Resources, memory, telemetry

| Document | Subject |
| --- | --- |
| [RESOURCE_MANAGEMENT](RESOURCE_MANAGEMENT.md) | The two orthogonal axes: memory residency and compute contention |
| [MEMORY_ESTIMATION](MEMORY_ESTIMATION.md) | A-priori per-pool footprint, evidence receipts, drift, auto-assess |
| [NUMA_PINNING](NUMA_PINNING.md) | Per-instance bind/interleave, delegation prerequisites, placement skew |
| [SYSTEM_METRICS](SYSTEM_METRICS.md) | The 1 Hz recorder, persistence buckets, event-loop stall verdicts |
| [BENCHMARK](BENCHMARK.md) | Engine-agnostic inference-speed benchmark |

## Configuration, deployment, fleet

| Document | Subject |
| --- | --- |
| [CONFIG_FILES](CONFIG_FILES.md) | What each portable config file holds; identity rules and cascades |
| [CONFIG_EDITING](CONFIG_EDITING.md) | The staged read/write contract: reload, quarantine, write conflicts |
| [CONFIG_GIT](CONFIG_GIT.md) | Managing the config root as a git repository |
| [PORTABLE_PATHS](PORTABLE_PATHS.md) | `${ARRIERO_*}` placeholders and startup normalization |
| [RUNTIME_LAYOUT](RUNTIME_LAYOUT.md) | `data/` and `runtime/` contents, DB tables, environment variables |
| [MIGRATIONS](MIGRATIONS.md) | Inventory of one-shot data migrations (Russian) |
| [PREREQUISITES](PREREQUISITES.md) | Host-tooling registry, probe primitive, gated installer |
| [SELF_UPDATE](SELF_UPDATE.md) | The UI update runner and the copyable update kit |
| [SUBPATH_DEPLOY](SUBPATH_DEPLOY.md) | Serving behind a reverse-proxy path prefix |
| [FEDERATION](FEDERATION.md) | Fleet registry and reverse-proxy transport over peers |

`qualification/` holds the pinned per-engine qualification records referenced by the operations
documents.
