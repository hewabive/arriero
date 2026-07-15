# Python engine environments

The Environments domain provisions immutable Python-engine installations. It is separate from the llama.cpp CMake Build domain: the managed unit is an official wheel installed into a uv-managed virtual environment.

## Desired state and runtime state

Portable specs live in `data/config/envs.json`. Runtime environments live under `runtime/envs/` (override with `LLAMA_MANAGER_ENVS_DIR`) and are safe to delete and rebuild. A spec records the engine/version, Python request, install source, and the id of its generated path-catalog entry.

Status is derived rather than persisted:

- `missing`: spec exists, final entrypoint does not;
- `installing`: this manager owns the active job;
- `installed`: the final entrypoint, Python, freeze file, relocatable launcher, and
  `import vllm` validation all succeeded;
- `failed`: the latest in-memory job failed or was canceled and no final entrypoint exists.

After a manager restart job history is intentionally lost; abandoned `.staging` directories are swept and the durable spec becomes `missing`, ready for rebuild.

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

## Sources and reproducibility

`pypi` installs `vllm[extras]==version` and accepts a credential-free index URL. `wheel` accepts an HTTPS or file URL, optional SHA-256 fragment, and optional uv torch backend (for example `cpu`). URL credentials are rejected; private-index authentication must come from the manager process environment.

The spec is recreatable but not an exact lock: dependency resolution may change on a later rebuild. `freeze.txt` is diagnostic runtime state, not portable configuration.

## Ownership and deletion

Final directories are derived from the stable spec id and are root-confined. The generated binary entry is tagged `engineKind: "vllm"`; reconciliation repairs a missing or edited entry. Delete is refused while its catalog entry is referenced by an instance or its install job is active.

The Environments page exposes create/rebuild/delete, current uv availability, the active job, cancellation, and a polling log tail. Once ready, the generated binary appears automatically in the vLLM instance form; that form stores the model repository/path as the first positional argument and the descriptor supplies the fixed `serve` prefix.
