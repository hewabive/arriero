# Python engine environments

The Environments domain provisions immutable Python-engine installations. It is
separate from the llama.cpp CMake Build domain. Engine-specific package, entrypoint,
validation, availability, and catalog behavior is selected through the API-side
provisioner registry; orchestration remains shared.

## Desired state and runtime state

Portable specs live in `data/config/envs.json`. Runtime environments live under
`runtime/envs/` (override with `ARRIERO_ENVS_DIR`) and are safe to delete and rebuild.
A spec records the engine/version, runtime variant (`cuda`, `cpu`, or `rocm`), Python
request, application install source, and the id of its generated path-catalog entry.
Repository infrastructure is deliberately not copied into each spec; the node-wide
environment repository profile lives in `data/config/settings.json`.

Status is derived rather than persisted:

- `missing`: spec exists, final entrypoint does not;
- `installing`: this manager owns the active job;
- `installed`: the final entrypoint, Python, freeze file, relocatable launcher, and
  engine-specific import and exact-version validation all succeeded;
- `failed`: the latest in-memory job failed or was canceled and no final entrypoint
  exists.

After a manager restart job history is intentionally lost; abandoned `.staging`
directories are swept and the durable spec becomes `missing`, ready for rebuild.

Installation state is separate from hardware availability. For vLLM, an installed CPU
variant is `usable`, CUDA requires an NVIDIA device visible through NVML, and ROCm
requires `/dev/kfd`. KTransformers is usable only on Linux x86-64 with Python 3.11 or
3.12 and a visible NVIDIA GPU. An ABI-valid environment without its accelerator remains
`installed` but is reported as `unavailable` with a reason.

Hardware checks run before the installed check, so a spec on an incompatible host is
reported `unavailable` (with the reason) instead of `not-installed` — the warning is
visible before anything is downloaded. Install itself is not blocked.

### CUDA compute-capability floor

Current vLLM and KTransformers wheels ship PyTorch/kernels compiled for CUDA compute
capability 7.5 (Turing) and newer — vLLM's bundled torch lists its supported CC range at
startup, and KTransformers runs through `sglang-kt`, whose FlashInfer/sgl-kernel stack
is likewise sm75+. The floor lives in core as
`ENGINE_MINIMUM_CUDA_COMPUTE_CAPABILITY`, a constant for current engine versions
(supporting older engine releases is explicitly not a goal). The per-device capability
comes from NVML (`nvmlDeviceGetCudaComputeCapability`), captured once per device into
`SystemAccelerator.computeCapability`; a device whose capability NVML cannot report is
treated as possibly-capable, never failed (`null`, not a substituted value).

The floor gates two places:

- **Environment availability** (`envs/availability.ts`,
  `cudaComputeCapabilityShortfall` in core): a CUDA-variant environment on a host where
  every NVIDIA GPU reports a capability below the floor is `unavailable`, naming the
  GPUs and their capabilities.
- **Instance-start preflight** (`process/preflight-vllm.ts`,
  `process/preflight-ktransformers.ts`, shared `process/preflight-cuda.ts`): a vLLM
  instance whose binary resolves into a CUDA-variant managed environment
  (`environmentSpecForBinaryPath`) errors when no NVIDIA GPU is present, when
  `CUDA_VISIBLE_DEVICES` disables CUDA, or when no visible GPU meets the floor — the
  issue blames `env.CUDA_VISIBLE_DEVICES` when the narrowing hides a capable GPU and
  `gpu` when the hardware itself is below the floor. CPU/ROCm-variant environments skip
  the CUDA checks; a vLLM binary outside any managed environment downgrades the
  capability error to a warning (its build flavor is unknown). KTransformers preflight
  applies the same floor unconditionally (its environments are always CUDA).

## Transactional install

Only one environment job runs at a time. The runner executes:

1. `uv python install <pythonVersion>`, adding `--mirror <pythonMirrorUrl>` when the
   site profile configures one;
2. `uv venv --relocatable --managed-python --no-python-downloads
   --python <pythonVersion> <staging>`;
3. one `uv pip install --python <staging>/bin/python <exact application roots>`
   transaction, using the configured package index;
4. `uv pip list --format freeze` into runtime `freeze.txt`;
5. validate the staging entrypoint and atomically rename staging to final;
6. run engine imports and exact distribution-version checks from final Python;
7. reconcile the engine-tagged Path Catalog entry.

The environment engine requires `uv` but does not enforce a minimum version. uv
bundles its Python download catalog, so different uv releases can request different
python-build-standalone builds from the same mirror. Diagnostics reports the installed
uv version; the configured mirror must cover that consumer version.

Every uv invocation uses `--no-config`, so a user-level `uv.toml` cannot alter
resolution. The enforcing layer is `UV_NO_CONFIG=1` in the runner's child-process
environment, which covers every uv child unconditionally; the per-command
`--no-config` flag is kept so recorded step commands stay reproducible when replayed
outside the runner. The runner also removes inherited `UV_*` policy variables such as extra
indexes, find-links, offline mode, and Python catalog/mirror overrides. Authentication
variables, certificate/TLS settings, proxies, and HTTP timeout/retry settings remain
available to the child process. Arriero owns the interpreter store and uv cache under
`runtime/python/` and `runtime/uv-cache/` (overridable with `ARRIERO_PYTHON_DIR` and
`ARRIERO_UV_CACHE_DIR`). This keeps service installs independent of the account's uv
directories and ensures the interpreter installed in step 1 is discovered in step 2.

The child owns a process group so cancel and manager shutdown terminate uv and its
descendants. Failure removes staging and never publishes a partial final environment.

`pythonMirrorUrl` is a site-level `file:`, HTTP, or HTTPS uv mirror. The mirror exposes
Python archives under the upstream release-build paths expected by `uv --mirror`.
Arriero delegates archive selection, archive-format validation, and interpreter-layout
validation to uv; there is no Arriero-specific Python download catalog.

## Engines and application sources

The vLLM provisioner installs:

- PyPI: `vllm[extras]==version`;
- wheel: one file, HTTP, or HTTPS URL with optional SHA-256;
- entrypoint: `bin/vllm`;
- validation: `import vllm`, exact `vllm` metadata and module version;
- catalog tag: `vllm`.

The KTransformers provisioner installs a matched pair in one transaction:

- PyPI: `kt-kernel==version` and `sglang-kt==version`;
- wheels: exactly one artifact for each root distribution, each with an optional
  SHA-256;
- entrypoint: `bin/sglang`;
- validation: `import kt_kernel`, `import sglang`, exact metadata versions for both
  distributions, both exact pins in `freeze.txt`, and a minimal
  `kt_kernel_ext.CPUInfer(1)` construction;
- catalog tag/name: `ktransformers` / `KTransformers <version> [<id>]`.

KTransformers wheel artifacts may be listed in any order; the provisioner normalizes
installation order to `kt-kernel`, then `sglang-kt`. A missing or duplicate root is
rejected by the portable schema. Local file artifacts with a SHA-256 are verified before
uv runs.

## Repository profile and rolling resolution

`GET/PUT /api/environments/settings` manages one node-wide profile:

- `packageIndexUrl`: a credential-free HTTP(S) PEP 503/691 Simple API root;
- `pythonMirrorUrl`: a credential-free file or HTTP(S) uv Python mirror.

The package index is installed as uv's `--default-index`, replacing public PyPI. It
must therefore contain the application root wheels and their complete dependency
closure. This is the repository boundary: Arriero does not read mirror-production
plans or locks and does not need to know which system produced an artifact.

Both settings are independent and optional. An absent URL selects uv's default source;
a configured URL is passed explicitly for every new install and rebuild. Arriero does
not classify hostnames as public or private, infer whether the node is disconnected, or
require mirrors to have a particular package composition. Network reachability and
mirror completeness belong to deployment infrastructure. URL credentials are rejected;
repository authentication belongs in the manager process environment.

An environment spec is recreatable but is intentionally not a long-lived dependency
lock. Creating a newly selected vLLM or KTransformers release resolves its current
closure from the site index into a new immutable environment. Existing environments
remain available for rollback. `freeze.txt` records what was realized for diagnostics;
it is runtime state, not portable configuration.

## Index version discovery

`GET /api/environments/index-versions?engine=&pythonVersion=` reads the Simple API
selected by the site profile and returns versions newest first. An absent site index
means uv's default package index. Distribution names come from the provisioner registry,
so vLLM queries `vllm` and KTransformers queries both `kt-kernel` and `sglang-kt`; a
version published for only one matched root is returned with `missingDistributions`
instead of being hidden.

The lookup runs server-side because the browser may not reach a registry without CORS.
It sends no credentials. PEP 691 JSON is preferred, with PEP 503 HTML as fallback for
registries such as Gitea. Ordering follows PEP 440 rather than lexical ordering, and
wheel tags plus `requires-python` are used to annotate compatibility.

The create form is ordered as engine/Python/variant → application source kind → release
→ review. The repository profile is configured once above it. Manual version entry
remains available when an index is stale or unreachable. Lookup status distinguishes
`empty`, `not-found`, `auth-required`, and `unreachable`.

## Ownership and deletion

Final directories are derived from the stable spec id and are root-confined. The
generated binary entry is tagged with the spec engine; reconciliation repairs a missing
or edited entry. Delete is refused while its catalog entry is referenced by an instance
or its install job is active.

The Environments API exposes create/rebuild/delete, repository settings, current uv
availability, the active job, cancellation, and a polling log tail. Once ready, a
generated binary is available only to an instance of the matching tagged engine kind.

Repository choices are site-level settings rather than part of an individual
environment's identity. The host network policy determines whether their configured or
default URLs are reachable.
