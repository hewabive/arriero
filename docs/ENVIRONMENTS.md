# Python engine environments

The Environments domain provisions immutable Python-engine installations. It
is separate from the llama.cpp CMake Build domain. Engine-specific package,
entrypoint, validation, availability, and catalog behavior is selected through
the API-side provisioner registry; orchestration remains shared.

## Desired state and runtime state

Portable specs live in `data/config/envs.json`. Runtime environments live under `runtime/envs/` (override with `ARRIERO_ENVS_DIR`) and are safe to delete and rebuild. A spec records the engine/version, runtime variant (`cuda`, `cpu`, or `rocm`), Python request, install source, and the id of its generated path-catalog entry.

Status is derived rather than persisted:

- `missing`: spec exists, final entrypoint does not;
- `installing`: this manager owns the active job;
- `installed`: the final entrypoint, Python, freeze file, relocatable launcher, and
  engine-specific import and exact-version validation all succeeded;
- `failed`: the latest in-memory job failed or was canceled and no final entrypoint exists.

After a manager restart job history is intentionally lost; abandoned `.staging` directories are swept and the durable spec becomes `missing`, ready for rebuild.

Installation state is separate from hardware availability. For vLLM, an
installed CPU variant is `usable`, CUDA requires an NVIDIA device visible
through `nvidia-smi`, and ROCm requires `/dev/kfd`. KTransformers is usable only
on Linux x86-64 with Python 3.11 or 3.12 and a visible NVIDIA GPU. An ABI-valid
environment without its accelerator remains `installed` but is reported as
`unavailable` with a reason instead of being mislabeled as corrupt.

## Transactional install

Only one environment job runs at a time. The runner executes:

1. either `uv python install <pythonVersion>` or, in offline mode,
   `uv python find --managed-python --no-python-downloads <pythonVersion>`;
2. `uv venv --relocatable --python <pythonVersion> <staging>`;
3. one `uv pip install --python <staging>/bin/python <pinned roots>`
   transaction;
4. `uv pip freeze` into runtime `freeze.txt`;
5. validate the staging entrypoint and atomically rename staging to final;
6. run engine imports and exact distribution-version checks from final Python;
7. reconcile the engine-tagged Path Catalog entry.

The child owns a process group so cancel and manager shutdown terminate uv and its descendants. Failure removes staging and never publishes a partial final environment.

`pythonProvisioning` makes runtime acquisition explicit. The default,
`download-if-missing`, preserves the normal uv-managed download flow.
`require-existing` is the closed-network mode: the API performs a local-only preflight
before persisting a new spec or starting a rebuild, and the first recorded job step
repeats that check. If the requested managed interpreter is absent, installation fails
with an actionable error before a venv or package download is attempted. The UI exposes
this as the offline Python-runtime switch.

`mirror` is the portable closed-network alternative. `pythonMirrorUrl` points at the
`python-runtime-mirror` directory created by airgap-sync (a `file:`, HTTP, or HTTPS URL).
The recorded install step runs `uv python install --mirror <url> <version>`; uv replaces
the public python-build-standalone release base with this mirror, so a missing runtime
can be installed without public-network access. airgap-sync verifies the archive SHA-256
and ships `python-runtime-manifest.json`; arriero still delegates archive-format
and interpreter-layout validation to uv.

## Engines and sources

The vLLM provisioner preserves the existing contract:

- PyPI: `vllm[extras]==version`;
- wheel: one HTTPS or file URL with optional SHA-256;
- entrypoint: `bin/vllm`;
- validation: `import vllm`, exact `vllm` metadata and module version;
- catalog tag: `vllm`.

The KTransformers provisioner installs a matched pair in one transaction:

- PyPI: `kt-kernel==version` and `sglang-kt==version`;
- wheels: exactly one artifact for each root distribution, each with an
  optional SHA-256;
- entrypoint: `bin/sglang`;
- validation: `import kt_kernel`, `import sglang`, exact metadata versions for
  both distributions, and both exact pins in `freeze.txt`;
- catalog tag/name: `ktransformers` / `KTransformers <version> [<id>]`.

KTransformers wheel artifacts may be listed in any order; the provisioner
normalizes installation order to `kt-kernel`, then `sglang-kt`. A missing or
duplicate root is rejected by the portable schema.

## Reproducibility and network policy

PyPI sources accept a credential-free index URL. Wheel sources accept HTTPS or
file URLs, optional SHA-256 fragments, an optional uv torch backend, and a
credential-free dependency index URL. The latter is essential for
closed-network wheel installs: every root wheel and transitive dependency can
come from the same internal index instead of silently falling back to public
PyPI. URL credentials are rejected; private-index authentication must come from
the manager process environment.

The spec is recreatable but not an exact lock: dependency resolution may change on a later rebuild. `freeze.txt` is diagnostic runtime state, not portable configuration.

## Ownership and deletion

Final directories are derived from the stable spec id and are root-confined.
The generated binary entry is tagged with the spec engine; reconciliation
repairs a missing or edited entry. Delete is refused while its catalog entry is
referenced by an instance or its install job is active.

The Environments API exposes create/rebuild/delete, current uv availability,
the active job, cancellation, and a polling log tail. The web form supports
engine-specific vLLM and matched-pair KTransformers sources. Once ready, a
generated binary is available only to an instance of the matching tagged
engine kind.

Mirror provisioning also activates a no-public-network policy before the job starts.
PyPI sources must name an explicit non-public index; wheel sources must use a non-public
root URL plus an explicit non-public dependency index; runtime mirrors cannot point at
GitHub, PyPI, pythonhosted.org, or Astral's public hosts. This prevents a typo or omitted
index from silently falling back to the Internet.
