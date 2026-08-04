# vLLM support plan

Historical planning document for the second managed engine (vLLM) and the
Python environment domain that carries it. All planned implementation phases
are complete. The production contract and real-GPU release gate now live in
`docs/VLLM_OPERATIONS.md`; the pinned qualification record is
`docs/qualification/vllm/0.26.0-2026-07-30.md`.

## Accepted decisions (2026-07-06)

- **No source builds for Python engines.** The llama.cpp ideology ("the manager owns the engine version") is kept, but its mechanism changes: the unit of version control is an **immutable uv-managed venv per (engine, version)**, installed from official PyPI wheels. Building vLLM from source is high cost (CUDA kernel compile times, torch/CUDA ABI coupling) and near-zero value (wheels exist for every release, unlike llama.cpp). The CMake build domain stays llama-only. Escape hatch: a hand-built vLLM in a user venv is usable by pointing a path-catalog binary entry at its entrypoint — no manager-side build support needed.
- **venvs are never "activated".** The instance `binaryPath` points at `runtime/envs/<engine>-<version>/bin/vllm`; the entrypoint shebang resolves the venv's python. Supervisor, pgid handling, NUMA wrappers, and adoption stay untouched — `reconcile.ts` matches `/proc/<pid>/cmdline` via `argv.includes(binaryPath)`, so the interpreter-first cmdline (`…/bin/python …/bin/vllm serve …`) matches as-is (verified against the code).
- **Model reference is free text** (HF repo id or local safetensors path) carried in `instance.positionalArgs`. No model entity, format discriminator, or HF cache scanner yet — that is a separate later feature.
- **The `serve` subcommand comes from the descriptor**, not from users: new `launch.argvPrefix` field consumed by the `flag-map` argv builder (prefix, then instance positionals, then sorted flags). The web form exposes only the model positional.
- **Path-catalog binary entries get an optional `engineKind` tag**, set by whichever domain registers the entry (envs domain → `vllm`, build domain → `llama-server`). The web form derives/filters instance kind from the tag; basename sniffing (`isRpcServerBinary`) remains only as fallback for untagged legacy entries.
- **New probe id `openai-http`** (`GET /health` + `/v1/models`), `probe.httpHealth: true` — the "Preserved quirks" warning about `httpHealth: false` doubling as readiness policy does not apply. `nativeApi: "none"` (no llama `/props`/`/slots` panels).
- **Proxy capabilities**: `serveEndpoint: true`, `requestLease: true`, everything else `false` — the documented start/stop-only managed-target configuration; the scheduler restarts the process instead of emitting load/unload verbs.
- **Estimator**: `none` initially (draws declared manually — the ledger supports this), then a trivial `vllm-gpu-util` estimator (vLLM pre-allocates `--gpu-memory-utilization × pool capacity`).
- **uv is the only supported env tool** — detected like `isCudaToolkitAvailable()` detects nvcc, surfaced in Diagnostics; it also pins the Python interpreter (`uv python install`), removing the system-python dependency. No pip fallback.

## Implementation decisions (2026-07-11)

- **Phases 2 and 3 are reordered.** A path-catalog `engineKind` is an `InstanceKind`, so an env cannot register `engineKind: "vllm"` before the vLLM kind exists. The engine contract and its common seams land first; the env domain follows. These commits are one deployable sequence: the web form does not expose a half-configured engine.
- **The existing probe payload remains the compatibility envelope.** vLLM fills `health` and `models`; llama-native fields (`props`, `slots`, model diagnostics) return explicit `not applicable` probes. A wider probe-contract rename is not required for the second engine.
- **Argument-help implementations own both invocation and parsing.** vLLM runs `serve --help=all`, not the global `--help`. Help generation is asynchronous with an engine-specific timeout so the 9–18 second torch import does not block the API event loop; cache identity continues to include the parser id and the reported source command is exact.
- **Endpoint URL derivation is descriptor-driven.** Host, port, and API-prefix keys/defaults come from the selected instance kind; no llama default may leak into vLLM.
- **Process telemetry is kind-aware.** llama router children retain the conservative name/port matcher; vLLM includes the root and all descendants (workers rewrite their names). Kind is threaded through memory, swap, and NUMA sampling.
- **Env specs are desired state.** The spec is persisted before installation. List responses derive `missing`/`installing`/`ready`/`failed` state from jobs and disk, and a missing/failed env can be rebuilt from the same spec.
- **Installations are transactional.** Jobs build in a sibling staging directory, validate the `bin/vllm` entrypoint, write the resolved freeze, then atomically rename into the final directory. Cancellation/failure removes staging. Startup sweeps abandoned staging directories.
- **Env identity is the stable generated `id`, not the mutable display tuple.** Runtime layout is `runtime/envs/<engine>-<version>-<id>/`; the suffix prevents collisions between Python/source variants and makes delete paths derivable without trusting catalog paths.
- **Install source is a discriminated union.** `pypi` pins `vllm==version` and may
  carry extras; `wheel` carries a credential-free file/HTTP(S) wheel URL, optional
  SHA-256, and optional uv torch backend (needed for CPU wheels). Repository URLs are
  node-wide settings rather than application identity. Secrets belong in process
  environment, not portable config.
- **Recreation is dependency-resolved, not bit-reproducible.** `freeze.txt` records the realized environment for diagnosis, but the portable spec intentionally pins only engine/Python/source inputs. Exact lockfile reproduction is deferred and the UI must not claim otherwise.
- **Jobs are single-flight and in-memory, like Build, but lifecycle-safe.** Logs use the existing JSON tail polling pattern rather than introducing env-only SSE. The active child runs in its own process group, cancel/shutdown terminates the group, and restart recovery reports the persisted spec as missing after staging cleanup.
- **Env/catalog ownership is explicit.** The spec stores its path-catalog entry id. Reconciliation repairs a missing or edited generated entry. Delete is refused while an instance references that entry or a job is active; it removes only the env-owned, root-confined directory.
- **vLLM model identity comes from the first positional argument** (descriptor prefix `serve` is not stored in the instance). `--served-model-name` wins when present. This is used by managed-target model discovery even while the process is stopped.
- **Lease behavior follows declared/estimated draws.** `requestLease` is wired as an explicit gate; without it no compute-domain lease is acquired. Initial vLLM instances use manual draws; the later estimator creates one draw per selected GPU.
- **GPU utilization is per device.** For tensor parallelism, each selected GPU draw is `gpu-memory-utilization × that pool's capacity`; the value is not divided across GPUs. `CUDA_VISIBLE_DEVICES` order selects the first `tensor-parallel-size` pools.
- **Explicit local vLLM model paths are preflighted.** A Hugging Face id remains
  free text, while an absolute or explicitly relative local path must exist and
  be readable before the process may start. Terminal Python exception lines are
  retained in the short log summary when a later runtime failure still occurs.

## GPU qualification (done, 2026-07-30)

The official vLLM 0.26.0 wheel and pinned Qwen3-4B model passed the managed
single-GPU gate on an RTX A5000 24-GiB host. Direct and proxied OpenAI Chat and
Responses, the Anthropic bridge, streaming, `max-num-seqs` queueing, process
accounting, autostart, adoption, idle/active stop, and failure diagnostics were
exercised. See `docs/qualification/vllm/0.26.0-2026-07-30.md`.

## Phase 0 — spike (no product code)

Run vLLM by hand in a scratch uv venv and answer the unknowns that shape phases 2–3:

1. `vllm serve --help` — output format (argparse groups?), completeness (are all serve args listed?), and wall time (imports torch; matters for the catalog cache UX, cached per binary path+mtime afterwards).
2. `/health` semantics during model load — when exactly does it return 200 (readiness policy input), and what does `/v1/models` return before ready.
3. SIGTERM to the pgid — graceful shutdown, exit code, shutdown duration.
4. Worker process tree — cmdline shape of EngineCore / tensor-parallel workers (input for the descendant matcher in phase 3).

### Findings (2026-07-06, vLLM 0.24.0 +cpu wheel, uv-managed cpython 3.12.13, 4-core GPU-less VM, facebook/opt-125m)

1. **Help**: bare `--help` prints only config-group names — the catalog parser must invoke **`serve --help=all`** (1744 lines, 266 flags). Format is standard argparse: group headers (`Frontend:`, `ModelConfig:`, …), `  --flag VALUE` / `--flag {choice,choice}` / `--flag, --no-flag` booleans, indented descriptions ending in `(default: X)`. Log preamble (INFO/WARNING lines) precedes `usage:` on stdout — skip until `usage:`. Wall time 18.4 s cold / ~9 s warm (torch import dominates) — fine for a once-per-binary cached parse, but the UI should show a pending state. GO for `vllm-help`.
2. **Health**: the HTTP port does not accept connections until the engine is fully initialized — polls show connection-refused for the whole load (~61 s on this VM), then `/health` and `/v1/models` flip to 200 in the same second. There is no intermediate "loading" HTTP phase: probe readiness = connect + 200, and **loading progress must come from the log parser**, not HTTP. Readiness log markers: `INFO:     Started server process [pid]` / `INFO:     Application startup complete.` (uvicorn lines, `(APIServer pid=N)` prefix).
3. **SIGTERM to pgid**: clean graceful shutdown in ~1.1 s, exit code 0, no processes left in the pgid. Default `--shutdown-timeout 0` aborts in-flight requests; the supervisor's existing stop path works unchanged.
4. **Process tree**: main = `<venv>/bin/python <venv>/bin/vllm serve …` — `argv.includes(binaryPath)` matches, adoption works unchanged. Children (same pgid): a `multiprocessing.resource_tracker`, plus engine processes that **rewrite their cmdline via setproctitle to `VLLM::EngineCore` and `VLLM::Worker`** — name-based descendant matching must accept the `VLLM::` prefix (or match by pgid). Memory lives in the *children*: Worker RSS 2.19 GiB vs 0.72 GiB main vs 0.61 GiB EngineCore for a 125M model — a main-pid-only memory layout would miss ~75 %.

Extra findings that shaped decisions:

- **System python is not enough**: the CPU backend JIT-compiles kernels through torch
  inductor even under `--enforce-eager` and dies on a missing `Python.h`; distro
  pythons lack dev headers unless `-dev` is installed. uv-managed interpreters
  (python-build-standalone) ship headers — the env domain uses only managed
  interpreters. A configured site-wide uv mirror supplies them in disconnected
  deployments; venv creation then forbids an implicit Python download.
- **CPU-variant wheels** live as GitHub release assets (`vllm-<v>+cpu-cp38-abi3-manylinux_2_34_x86_64.whl`, ~107 MiB vs 266 MiB CUDA-implied PyPI wheel), installable via `uv pip install <url> --torch-backend cpu`. The env spec should support a variant/wheel-source override so GPU-less dev machines can run real vLLM end-to-end.
- **Argument help can require a working accelerator backend.** If `vllm serve --help=all`
  cannot initialize on the current node, arriero now serves a bundled conservative
  fallback catalog for core serving, model, parallelism, memory, and LoRA options. The
  catalog source is visibly marked `vllm-fallback-catalog`; successful live help or a
  matching sidecar remains authoritative.
- venv size ~2.7 GiB (CPU torch); entrypoint `bin/vllm` shebang-resolves its interpreter — no activation anywhere.

## Phase 1 — path-catalog engine tag (done, `cbe5bd1`)

- Core: optional `engineKind?: InstanceKind` on path-catalog `binary` entries.
- `registerBuiltBinaryInCatalog` tags `llama-server`; manual entries stay untagged.
- Web New-instance form: binary picker filters/preselects by the selected kind's tag; `isRpcServerBinary` sniffing kept only for untagged entries.

Acceptance: tagged and untagged binaries coexist; form behavior unchanged for existing catalogs.

## Phase 2 — vLLM kind and common engine seams (done)

This phase was moved ahead of environments because the env-generated path-catalog entry cannot carry `engineKind: "vllm"` until the kind exists.

- Add the vLLM descriptor and registry implementations originally listed under phase 3.
- Make endpoint derivation descriptor-driven and make argument-help invocation asynchronous/implementation-owned.
- Thread instance kind through runtime descendant memory/swap/NUMA accounting.
- Keep the vLLM kind out of the production web creation path until phase 4 completes the form.

Acceptance: a manually cataloged vLLM binary can launch through the API, reaches readiness, is adopted/stopped correctly, and exposes an argument catalog without blocking the API event loop.

## Phase 3 — environments domain (`apps/api/src/envs/`) (done)

Modeled on the build domain: a job runner with streamed step logs, producing a registered binary.

- `envs/uv.ts` — uv detection, version surfaced in `SystemResources`/Diagnostics.
- Env specs are file-backed portable config: `config/envs.json` (aggregate array, in-memory cache + atomic write-through, same pattern as `path-catalog.json`): `{ id, engine: "vllm", version, pythonVersion, source, pathCatalogEntryId, createdAt, updatedAt }`. The venv itself is runtime state — rebuildable from the spec, never in git.
- Job steps: `uv python install [--mirror <site-mirror>] <ver>` → `uv venv
  --relocatable --managed-python --no-python-downloads --python <ver> <staging>` →
  `uv pip install --python <staging>/bin/python <source>` using the site package
  index → write `freeze.txt` → validate entrypoint → atomic rename →
  register/reconcile the path-catalog entry. Relocatable mode keeps console-script
  shebangs valid after the staging directory is renamed.
- Layout: `runtime/envs/`, overridable via `ARRIERO_ENVS_DIR`. Envs are immutable: a new version = a new venv; no in-place upgrades.
- Delete = remove venv dir + catalog entry; refused while any instance references the entry via `binaryPathRefId`.
- API supports list/create/rebuild/delete, one active install job, cancel, and polled log tail. Delete is guarded by instance references and active jobs.

Acceptance: create env → entrypoint appears in path catalog tagged `vllm`; delete guarded; env recreatable from spec after wiping `runtime/envs/`.

### Engine contract delivered in phase 2

Core:

- `INSTANCE_KINDS` += `"vllm"`; `Record` exhaustiveness drives the rest.
- Descriptor: http `{ defaultHost: "127.0.0.1", defaultPort: 8000, hostArgKeys: ["--host"], portArgKeys: ["--port"], apiPrefixArgKeys: [] }`; proxy flags per decisions; `probe: { id: "openai-http", httpHealth: true }`; `nativeApi: "none"`; `launch: { injectSlotSavePath: false, argv: "flag-map", argvPrefix: ["serve"] }` (new field, `[]` for existing kinds); `preflight.engineChecks: "none"` initially; `argumentCatalogParser: "vllm-help"`; `logs.parser: "vllm"`; `estimator: "none"`; `resourceProfile: "vllm-args"`.

API registries:

- `engine-probe.ts`: `openai-http` → `/health` readiness + `/v1/models` model listing; **decide and document the offline/probe payload shape for non-llama engines** (today's offline shape is llama-flavored — record the outcome in `ENGINE_ADAPTERS.md` quirks).
- `log-parsers/vllm.ts`: readiness ("Application startup complete."), weight-load progress, error extraction — per spike findings.
- `arguments/`: `vllm-help` parser over `vllm serve --help`; existing cache rows/sidecars already carry `parserId`, so no cache work.
- `instance-resources.ts`: `vllm-args` strategy — gpu unless `--device cpu`; reads `--tensor-parallel-size`, `--gpu-memory-utilization`, `CUDA_VISIBLE_DEVICES`.
- `process/runtime-memory.ts`: replace the llama-name descendant filter with a per-kind matcher (vLLM workers are python processes — match by descent from the instance pgid, not command name). **Scheduler correctness depends on this**: unmatched workers make VRAM/RSS vanish from the memory layout and the eviction planner evicts into occupied memory.

Acceptance: a vllm instance is creatable via API, launches (`<env>/bin/vllm serve <model> --port …`), reaches `running/ready`, survives manager restart via adoption, stops cleanly; argument catalog parses and serves via `GET /api/llama-args?kind=vllm`.

## Phase 4 — environments web view + instance form/UI gating (done)

- Minimal Environments view (list, create/rebuild/delete, job log polling), placed next to Build in the sidebar.
- Kind selector already registry-driven; binary picker uses the phase-1 tag.
- Model positional input for kinds with `argvPrefix` (writes `instance.positionalArgs`); GGUF/preset/HF sections gated off for vllm via a descriptor-driven form flag (e.g. `form.modelSource: "gguf" | "free-text"`) instead of kind equality checks.
- Instance details sanity pass for `nativeApi: "none"` + `httpHealth: true` (probe pills meaningful, llama panels hidden — the gates exist, verify the combination).

Acceptance: full create-launch-observe flow for a vllm instance through the UI, no llama-specific controls visible.

## Phase 5 — proxy integration + estimator (done)

- Verify the generic path end-to-end with a managed vllm target: endpoint catalog entry, target creation, autostart via `start-instance`, domain lease (manual draws), plain forwarder streaming, drain on self-update. Expected to mostly "just work" via `serveEndpoint`/`requestLease`; this phase is the proof plus fixes.
- `vllm-gpu-util` estimator: gpu draw = explicit `--gpu-memory-utilization` × bound gpu pool capacity, split across `--tensor-parallel-size` pools when applicable; host draw stays manual. The estimator refuses an omitted utilization because upstream defaults vary by vLLM version (0.26.0 uses 0.92 while older releases used 0.9). Dispatch in `memory-estimate/service.ts` (the seam is prepared).
- Stats/traces sanity: no `sseTimings` — verify usage metering falls back correctly for a managed non-llama OpenAI upstream.

Acceptance: vllm model served through `/v1/*` with autostart, queueing, and correct memory accounting.

Delivered integration details: stopped vLLM instances expose their first positional model (or `--served-model-name`) to target discovery; start/stop-only scheduler capabilities suppress llama model/slot verbs; `requestLease` gates compute-domain acquisition; and the estimator applies `--gpu-memory-utilization` independently to each `CUDA_VISIBLE_DEVICES`/tensor-parallel GPU pool. Host RAM remains an explicit manual draw.

## Phase 6 — deferred (explicitly out of scope now)

- Sleep/wake (`--enable-sleep-mode`, `/sleep`/`/wake_up`) as a new proxy capability — a rough slot-save analog for the preemption scheduler.
- Model entity: format discriminator (GGUF file vs HF directory), HF cache scanner, download management.
- Russian argument-docs pipeline for vllm args (llama-only by design, stays that way).
- Third engine (SGLang) — validates that the seam generalized correctly.
