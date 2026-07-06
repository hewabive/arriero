# vLLM support plan

Planning document for the second managed engine (vLLM) and the Python environment domain that carries it. Written before implementation; as phases land, durable content moves into `docs/ENGINE_ADAPTERS.md` and a future environments doc, and the phase sections here get marked done or pruned.

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

## Phase 0 — spike (no product code)

Run vLLM by hand in a scratch uv venv and answer the unknowns that shape phases 2–3:

1. `vllm serve --help` — output format (argparse groups?), completeness (are all serve args listed?), and wall time (imports torch; matters for the catalog cache UX, cached per binary path+mtime afterwards).
2. `/health` semantics during model load — when exactly does it return 200 (readiness policy input), and what does `/v1/models` return before ready.
3. SIGTERM to the pgid — graceful shutdown, exit code, shutdown duration.
4. Worker process tree — cmdline shape of EngineCore / tensor-parallel workers (input for the descendant matcher in phase 3).

Deliverable: findings appended to this section; go/no-go on the `vllm-help` parser approach.

## Phase 1 — path-catalog engine tag (small PR)

- Core: optional `engineKind?: InstanceKind` on path-catalog `binary` entries.
- `registerBuiltBinaryInCatalog` tags `llama-server`; manual entries stay untagged.
- Web New-instance form: binary picker filters/preselects by the selected kind's tag; `isRpcServerBinary` sniffing kept only for untagged entries.

Acceptance: tagged and untagged binaries coexist; form behavior unchanged for existing catalogs.

## Phase 2 — environments domain (`apps/api/src/envs/`)

Modeled on the build domain: a job runner with streamed step logs, producing a registered binary.

- `envs/uv.ts` — uv detection, version surfaced in `SystemResources`/Diagnostics.
- Env specs are file-backed portable config: `config/envs.json` (aggregate array, in-memory cache + atomic write-through, same pattern as `path-catalog.json`): `{ id, engine: "vllm", version, pythonVersion, extras?, indexUrl? }`. The venv itself is runtime state — rebuildable from the spec, never in git.
- Job steps: `uv python install <ver>` → `uv venv runtime/envs/<engine>-<version>` → `uv pip install <engine>==<version>` → write `freeze.txt` (uv pip freeze) next to the venv → register the entrypoint in path-catalog (kind `binary`, `engineKind` tag, name `vllm (<version>)`, deduped by path — mirrors `registerBuiltBinaryInCatalog`).
- Layout: `runtime/envs/`, overridable via `LLAMA_MANAGER_ENVS_DIR`. Envs are immutable: a new version = a new venv; no in-place upgrades.
- Delete = remove venv dir + catalog entry; refused while any instance references the entry via `binaryPathRefId`.
- Minimal web view (list, create engine+version, delete, job log via SSE); placement next to Build in the sidebar.

Acceptance: create env → entrypoint appears in path catalog tagged `vllm`; delete guarded; env recreatable from spec after wiping `runtime/envs/`.

## Phase 3 — kind `vllm` (descriptor + registries)

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

## Phase 4 — web form + UI gating

- Kind selector already registry-driven; binary picker uses the phase-1 tag.
- Model positional input for kinds with `argvPrefix` (writes `instance.positionalArgs`); GGUF/preset/HF sections gated off for vllm via a descriptor-driven form flag (e.g. `form.modelSource: "gguf" | "free-text"`) instead of kind equality checks.
- Instance details sanity pass for `nativeApi: "none"` + `httpHealth: true` (probe pills meaningful, llama panels hidden — the gates exist, verify the combination).

Acceptance: full create-launch-observe flow for a vllm instance through the UI, no llama-specific controls visible.

## Phase 5 — proxy integration + estimator

- Verify the generic path end-to-end with a managed vllm target: endpoint catalog entry, target creation, autostart via `start-instance`, domain lease (manual draws), plain forwarder streaming, drain on self-update. Expected to mostly "just work" via `serveEndpoint`/`requestLease`; this phase is the proof plus fixes.
- `vllm-gpu-util` estimator: gpu draw = `--gpu-memory-utilization` (default 0.9) × bound gpu pool capacity, split across `--tensor-parallel-size` pools when applicable; host draw stays manual. Dispatch in `memory-estimate/service.ts` (the seam is prepared).
- Stats/traces sanity: no `sseTimings` — verify usage metering falls back correctly for a managed non-llama OpenAI upstream.

Acceptance: vllm model served through `/v1/*` with autostart, queueing, and correct memory accounting.

## Phase 6 — deferred (explicitly out of scope now)

- Sleep/wake (`--enable-sleep-mode`, `/sleep`/`/wake_up`) as a new proxy capability — a rough slot-save analog for the preemption scheduler.
- Model entity: format discriminator (GGUF file vs HF directory), HF cache scanner, download management.
- Russian argument-docs pipeline for vllm args (llama-only by design, stays that way).
- Third engine (SGLang) — validates that the seam generalized correctly.
