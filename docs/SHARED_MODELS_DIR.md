# Shared models directory

Scope: one models directory on a network/distributed filesystem (NFS, CephFS, …) mounted by
several hosts, each running its **own local** arriero. The models directory is the only part of
arriero designed to be shareable across hosts; everything else must stay host-local.

## What may be shared, what must not

- **Share**: the models directory (GGUF/safetensors files, HF download sidecars) and — on
  homogeneous hardware — built `llama-server` binaries: the argument-catalog sidecar
  (`apps/api/src/arguments/sidecar.ts`) travels with the binary, so a binary built on one host is
  fully usable from another via a path-catalog `binary` entry. Build on one host only; build trees
  are not concurrency-safe.
- **Never share** `ARRIERO_HOME` (or any of `data/`, `runtime/`, `config/`) between live managers:
  the SQLite DB runs in WAL mode, which corrupts under multi-host access; process supervision
  re-adopts and kills by local PID (`process/reconcile.ts`, `process/stale.ts`);
  `path-catalog.json`/`envs-state.json` are machine state; startup persists resource pools for locally
  detected GPUs. A fleet gets one UI via the `nodes` domain (`docs/FEDERATION.md`) and shared
  configuration via config-git (`docs/CONFIG_GIT.md`), not via a shared mount.

## Mount points

Either mount the share at the same absolute path on every host, or set each host's
`ARRIERO_MODELS_DIR` to its local mount point — instance configs and the path catalog persist
paths under managed roots as `${ARRIERO_MODELS_DIR}` placeholders (`docs/PORTABLE_PATHS.md`), so
config synced through config-git resolves correctly on every host either way.

## Scanning

Each host keeps its own scan cache (`model_cache` in its local DB), so scans are independent and
duplicated parsing across hosts is expected and harmless. A file another host deletes mid-scan is
skipped with a warning instead of failing the pass, and the post-scan prune drops its cache row.
The walk caps at 2000 model files per root; hitting the cap sets `truncated` on
`GET /api/models` and the Models page shows a warning instead of silently listing a subset.

## Downloads

Run HF downloads into the shared directory **from one host at a time per repo**. The
running-download guard is in-process and does not span hosts: two hosts downloading the same repo
append to the same `.part` files from different offsets, and hash verification only fails the job
at the end, after the bandwidth is spent. The `.arriero-hf.json` manifest is written
last-write-wins for the same reason. Completed files are safe to read from any host — they are
renamed into place only after verification.

## Deletion

The delete in-use guard (`apps/api/src/hf/in-use.ts`) sees **local** live processes only — it
cannot know that another host's instance has the file open. Delete from the host that runs the
model, after stopping instances that use it on every host. This matters more on NFS than on local
disks: unlinking a file another client holds open leaves `.nfsXXXX` silly-rename litter or hits
the reader with ESTALE/SIGBUS on its next major fault.

## Performance

`llama-server` mmaps models, so first load over the network is bandwidth-bound and pages evicted
under memory pressure re-fault over the network. On NFS clients, `cachefilesd` (fscache) gives
repeat loads local-disk speed; alternatively `--mlock` pins pages after the first load.
