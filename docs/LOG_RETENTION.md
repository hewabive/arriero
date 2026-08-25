# Log and history retention

What accumulates on disk over time, what the retention loops delete, and where the knobs live. The
per-path inventory is `docs/RUNTIME_LAYOUT.md`; this document owns the deletion policy. Both loops
follow the shared scaffold `db/retention.ts` — a prune at boot, an hourly pass, a stop on shutdown —
wired in `apps/api/src/index.ts`.

## Managed log files — `runtime/logs/`

One flat directory holds every managed log, all named `<owner>-<epochMs>.log`:

- instance run logs (`<instance>-<ts>.log` filtered + `<instance>-<ts>.raw.log` verbatim), one pair
  per start;
- webapp run logs with the same naming under `runtime/logs/webapps/`;
- job logs with no owning entity: `build-<ts>.log`, `env-<specId>-<ts>.log`, `update-<ts>.log`.

`apps/api/src/logs/retention.ts` prunes them against the `logs` section of `settings.json`
(`GET`/`PUT /api/logs/settings`, edited on `#/maintenance`):

- `retentionDays` (default 30) — files whose filename timestamp is older are deleted;
- `maxTotalMb` (default off) — after the age pass, if the directory still exceeds the cap, the
  oldest deletable files go first until it fits.

A file is never deleted when any of these hold:

- it is referenced by an **open** `process_runs` / `webapp_runs` row — a long-lived process keeps
  its log regardless of age;
- it belongs to the **latest** run of its instance or webapp — the Logs panel of a stopped entity
  keeps working;
- it is **younger than 24 hours** — which also shields logs of build/env/update jobs still running,
  since their job records are in-memory only;
- its name carries no `<epochMs>` stamp — unrecognized files are counted in usage but never touched.

Category attribution (instance / webapp / build / env / update / other) is derived from the
filename; protection is derived from the log paths recorded in the run rows, so an instance whose
name collides with a job prefix is still protected correctly. Files of older retained closed runs
are deleted once past retention; the run row survives and the log tail reports the file as
unreadable instead of failing. Instance/webapp deletion still removes its log files immediately
(`instances/delete-cleanup.ts`), independent of retention.

## Proxy request history — `proxy_request_traces` + `data/proxy-requests/`

`traceRetentionDays` in `config/proxy/settings.json` (default 30, `PATCH /api/proxy/settings`,
edited on `#/maintenance`) bounds both stores: one pass in `proxy/traces-repository.ts` deletes DB
rows past the cutoff and the matching capture-artifact directories by directory timestamp. The
traces page surfaces the active value via `facets.retentionDays`.

## Manual controls

- `GET /api/logs/usage` — per-category file count and size of `runtime/logs/` plus the size of the
  captured proxy request artifacts;
- `POST /api/logs/prune` — an immediate pass over both managed logs and the proxy request history
  (the "Prune now" button on `#/maintenance`).

## Deliberately not auto-deleted

Benchmark artifacts (`data/benchmarks/<runId>/`, removed with their run), config backups
(`data/config.backup-*`, deletable one by one from the Configuration page — `docs/CONFIG_GIT.md`),
models, source checkouts, Python environments and build trees are operator-owned data — retention
never touches them.
