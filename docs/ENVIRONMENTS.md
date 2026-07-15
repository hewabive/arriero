# Python engine environments

The Environments domain provisions immutable Python-engine installations. It is separate from the llama.cpp CMake Build domain: the managed unit is an official wheel installed into a uv-managed virtual environment.

## Desired state and runtime state

Portable specs live in `data/config/envs.json`. Runtime environments live under `runtime/envs/` (override with `LLAMA_MANAGER_ENVS_DIR`) and are safe to delete and rebuild. A spec records the engine/version, runtime variant (`cuda`, `cpu`, or `rocm`), Python request, install source, and the id of its generated path-catalog entry.

Status is derived rather than persisted:

- `missing`: spec exists, final entrypoint does not;
- `installing`: this manager owns the active job;
- `installed`: the final entrypoint, Python, freeze file, relocatable launcher, and
  `import vllm` validation all succeeded;
- `failed`: the latest in-memory job failed or was canceled and no final entrypoint exists.

After a manager restart job history is intentionally lost; abandoned `.staging` directories are swept and the durable spec becomes `missing`, ready for rebuild.

Installation state is separate from hardware availability. An installed CPU variant is
`usable`; CUDA requires an NVIDIA device visible through `nvidia-smi`, and ROCm requires
`/dev/kfd`. An ABI-valid environment without its accelerator remains `installed` but is
reported as `unavailable` with a reason instead of being mislabeled as corrupt.

## Transactional install

Only one environment job runs at a time. The runner executes:

1. either `uv python install <pythonVersion>` or, in offline mode,
   `uv python find --managed-python --no-python-downloads <pythonVersion>`;
2. `uv venv --relocatable --python <pythonVersion> <staging>`;
3. `uv pip install --python <staging>/bin/python <pinned source>`;
4. `uv pip freeze` into runtime `freeze.txt`;
5. validate `bin/vllm`, atomically rename staging to final, and reconcile Path Catalog.

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
and ships `python-runtime-manifest.json`; llama-manager still delegates archive-format
and interpreter-layout validation to uv.

## Sources and reproducibility

`pypi` installs `vllm[extras]==version` and accepts a credential-free index URL. `wheel` accepts an HTTPS or file URL, optional SHA-256 fragment, an optional uv torch backend (for example `cpu` or `rocm6.3`), and a credential-free dependency index URL. The latter is essential for closed-network wheel installs: the root wheel and every transitive dependency can come from the same Gitea index instead of silently falling back to public PyPI. URL credentials are rejected; private-index authentication must come from the manager process environment.

The spec is recreatable but not an exact lock: dependency resolution may change on a later rebuild. `freeze.txt` is diagnostic runtime state, not portable configuration.

## Ownership and deletion

Final directories are derived from the stable spec id and are root-confined. The generated binary entry is tagged `engineKind: "vllm"`; reconciliation repairs a missing or edited entry. Delete is refused while its catalog entry is referenced by an instance or its install job is active.

The Environments page exposes create/rebuild/delete, current uv availability, the active job, cancellation, and a polling log tail. Once ready, the generated binary appears automatically in the vLLM instance form; that form stores the model repository/path as the first positional argument and the descriptor supplies the fixed `serve` prefix.

Mirror provisioning also activates a no-public-network policy before the job starts.
PyPI sources must name an explicit non-public index; wheel sources must use a non-public
root URL plus an explicit non-public dependency index; runtime mirrors cannot point at
GitHub, PyPI, pythonhosted.org, or Astral's public hosts. This prevents a typo or omitted
index from silently falling back to the Internet.
