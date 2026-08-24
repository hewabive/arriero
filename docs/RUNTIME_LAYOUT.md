# Runtime layout and environment variables

Where the manager keeps machine-local state, and the environment variables that move it. Portable
configuration is a separate tree — `docs/CONFIG_FILES.md`.

## `data/` — state and rebuildable caches

`data/arriero.db` (SQLite, WAL) holds:

| Table | Owner | Notes |
| --- | --- | --- |
| `process_runs` | `process/runs-repository.ts` | last 20 closed runs + open runs per instance |
| `proxy_request_traces` | `proxy/traces-repository.ts` | 30-day retention; the prune also deletes `data/proxy-requests/` artifacts past the cutoff, and boot reseeds the in-memory hourly stats. Browsable with full filters + facets at `#/proxy/traces` |
| `system_metrics_history` | `system/metrics-repository.ts` | closed hour/day/month buckets upserted per bucket, reseeded into the recorder at boot, month backfilled from day rows; hour kept for its 1 h span, day/month 30 days (`docs/SYSTEM_METRICS.md` § Persistence) |
| `memory_assessments` | `memory-assessment/repository.ts` | one receipt per instance, analytical or measured; renamed and deleted with the instance. Machine-local evidence, deliberately not in portable config |
| `benchmark_runs` | `benchmark/repository.ts` | the serving source for benchmark history |
| `model_cache`, `safetensors_cache` | `models/` | rebuildable; raw facts + derived metadata under separate versions, so a parser bump re-derives instead of re-reading |
| `llama_argument_catalogs` | `arguments/` | parsed `--help`, keyed by binary path, invalidated by size/mtime, mirrored to a per-binary sidecar read on DB miss (`arguments/sidecar.ts`) so it survives DB recreation and travels with the binary |
| `proxy_response_cache` | `proxy/` | rebuildable (`docs/API_PROXY_RESPONSE_CACHE.md`) |

Other entries under `data/`:

- `data/config/` (= `ARRIERO_CONFIG_DIR`) — the portable config tree.
- `data/proxy-runtime-metadata.json` — API-proxy runtime metadata (per-target saved-slot ids for
  preemption restore). In-memory map + atomic write-through
  (`proxy/runtime-metadata-store.ts`); rebuildable, not git-tracked. `lastRequestAt` is
  memory-only.
- `data/benchmarks/<runId>/` — benchmark-run artifacts (`events.jsonl`, `result.json`, plus a
  `run.json` mirroring the finalized run record so the directory is self-contained), deleted with
  the run.
- `data/proxy-requests/` — per-request artifact files, opt-in through pipeline nodes such as
  `capture-request`. One directory per request,
  `<model>/<timestamp>-<traceId>/<NN>-<kind>.json` (inbound proxy model id, sanitized); metadata
  lands in `trace.files`, content is served by `GET /api/proxy/request-file?path=`
  (`proxy/request-files.ts`). Pruned with the 30-day trace retention, by directory timestamp.
- `data/proxy-pending-resume.json` — SSE stream sessions persisted on SIGTERM
  (`docs/STREAM_RESUME.md`).

## `runtime/` — processes, models, sources, builds

- `runtime/logs/` — managed-process stdout/stderr, `<instance>-<timestamp>.log` (filtered) next to
  `.raw.log` (verbatim).
- `runtime/slots/<instance>/` — per-instance llama.cpp KV slot dumps (`config.slotsDir`).
  `--slot-save-path` is auto-injected at launch and never persisted into the instance JSON, so proxy
  preemption save/restore works without manual config (`docs/API_PROXY_PREEMPTION.md` § Slots).
- `runtime/models/` — default primary GGUF scan root (`config.modelsDir`, used when `settings.json`
  has no `modelScan.directory`). The scan (`GET /api/models` without a `dir` param) merges every
  root from `models/roots.ts` — settings directory, path-catalog `models-dir` entries, and the
  llama.cpp download cache (`$LLAMA_CACHE`, else `~/.cache/llama.cpp`) — deduped; missing roots are
  skipped, not errors. HF downloads land in `<models dir>/<owner>/<repo>/` with a `.arriero-hf.json`
  sidecar manifest (`docs/HF_DOWNLOADS.md`). Sharing one models dir across hosts over a network FS:
  `docs/SHARED_MODELS_DIR.md`.
- `runtime/sources/` — managed inference source checkouts (`config.sourcesDir`); `llama-cpp`
  defaults to `runtime/sources/llama.cpp`. Every git operation requires the checkout's exact
  `--show-toplevel`, so an internal plain directory can never adopt the parent arriero repository.
  The generic API is `/api/source-repositories/*`; `/api/llama-source/*` remains the Build/docs
  compatibility adapter (`docs/SOURCE_REPOSITORIES.md`).
- `runtime/builds/` — llama.cpp CMake build trees, **outside** the checkout, one per ref slug under
  the `BuildSettings.buildDir` base (`docs/BUILD.md`).

## Environment variables

Paths: `ARRIERO_HOME`, `ARRIERO_DATA_DIR`, `ARRIERO_CONFIG_DIR`, `ARRIERO_RUNTIME_DIR`,
`ARRIERO_LOGS_DIR`, `ARRIERO_BUILDS_DIR`, `ARRIERO_SOURCES_DIR`, `ARRIERO_ENVS_DIR`,
`ARRIERO_MODELS_DIR`, `ARRIERO_SLOTS_DIR`. Server: `ARRIERO_HOST`, `ARRIERO_PORT`.

Behaviour: `ARRIERO_STOP_MANAGED_ON_EXIT` (default false — children survive manager exit and are
re-adopted), `ARRIERO_SHUTDOWN_TIMEOUT_MS` (default 10000), `ARRIERO_FILTER_PROBE_LOGS` (default
true).

Admin auth is **off by default** (admin routes open for local development). Enable with
`ARRIERO_ADMIN_PASSWORD` or `ARRIERO_ADMIN_PASSWORD_HASH` (`scrypt$…`, generate via
`pnpm auth:hash <pw>`); related: `ARRIERO_AUTH_SECRET`, `ARRIERO_SECURE_COOKIE` (leave false without
TLS), `ARRIERO_SESSION_TTL_SECONDS`. `/#/status` is a public, redacted diagnostics page and the
landing route while signed out; an authenticated session opening the bare root is sent to
`/#/dashboard`.

All variables seed from a gitignored repo-root `.env`, loaded in `config.ts` before any variable is
read; the real launch environment wins. `.env.example` is the tracked template, kept honest by
`pnpm check:env`. Legacy `LLAMA_MANAGER_*` keys are renamed in place
(`env-file-migration.ts`) and keep a read-time fallback (`manager-env.ts`).

## Serving

In production (`pnpm serve` / `pnpm start`) the api serves the built `apps/web/dist` as static
files, mounted only if `dist` exists — UI, API and proxy on the one `ARRIERO_PORT`. Vite (5173) is
dev-only. The same build serves from the domain root or any reverse-proxy subpath without a rebuild
(`docs/SUBPATH_DEPLOY.md`).
