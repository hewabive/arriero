# CLAUDE.md — @arriero/api

Hono server on `@hono/node-server`. `src/index.ts` is the entrypoint (migrate DB → reconcile process
runs → serve, with graceful SIGINT/SIGTERM shutdown of supervised children). `src/http.ts` is only
the composition root — CORS, `requireAdmin`, static serving, and one `register*Routes(app)` call per
module in `src/routes/*.routes.ts` (plus `proxy/protocol-routes.ts`). Persistence is SQLite via
Drizzle + `better-sqlite3`. Logging via `pino`, constructed in exactly one place
(`src/logger.ts`).

Tests live next to their sources as `*.test.ts` and run on the Node test runner:
`pnpm --filter @arriero/api test`, or one file with
`pnpm --filter @arriero/api exec tsx --import ./src/test/setup-env.ts --test src/proxy/scheduler.test.ts`
(`--test-name-pattern "<regex>"` filters by name). `src/test/setup-env.ts` points the DB and runtime
directories at temp locations, and `src/test/test-discovery.test.ts` fails if any test file stops
being reachable.

## Route conventions (`src/routes/*.routes.ts`)

- Every mutating handler parses the body with a core Zod schema via `safeParse` and returns
  `{ error: parsed.error.flatten() }` with 400 on failure; success returns `{ data }`.
- Cross-entity reference checks (e.g. `validateApiProxyTargetRefs`) run **after** schema parsing and
  return a plain string error.
- `/api/*` is gated by `requireAdmin`. The public proxy facades (`/v1/*`, `/proxy/v1/*`,
  `/proxy/anthropic/v1/*`) and `/api/public/status` are not.

## Persistence

Schema is declared in two places: `src/db/schema.ts` (Drizzle table defs for typed queries) and
`src/db/index.ts:migrate()` (hand-written idempotent `CREATE TABLE IF NOT EXISTS`). There is no
drizzle-kit pipeline and no in-place column migration — **the DB is recreated, not migrated**; to
evolve the schema, update both places. For an additive column against an existing DB, add an
idempotent `ALTER TABLE … ADD COLUMN` guard in `migrate()`. The DB holds runtime state and
rebuildable caches only; portable configuration is file-backed. One-shot data migrations are
inventoried in `docs/MIGRATIONS.md`; the table roster and every `data/` / `runtime/` path is
`docs/RUNTIME_LAYOUT.md`.

## Configuration

Portable config is files, not DB, under one root `data/config/` (`ARRIERO_CONFIG_DIR`). **Every JSON
config store rides one primitive (`src/config-store/`): disk is staging, memory is the applied
state.** External edits are detected by mtime and surfaced at `GET /api/config/state`, activated only
by `POST /api/config/reload`; an API write to a file edited since load returns 409 instead of
clobbering it; invalid files at boot quarantine rather than killing the process. The full contract is
`docs/CONFIG_EDITING.md`, the per-file inventory `docs/CONFIG_FILES.md`, the git layer
`docs/CONFIG_GIT.md`.

Paths under a managed root are persisted as `${ARRIERO_HOME}` / `${ARRIERO_*_DIR}` placeholders
(`src/config-paths.ts`) and expanded at each store's read boundary — repositories, the API and the UI
only ever see absolute paths. A startup pass `normalizeConfigFiles()` rewrites absolute paths that
reappear through hand edits; it is standing housekeeping, deliberately not a registry migration.
See `docs/PORTABLE_PATHS.md`.

## Domains (`src/<domain>/`)

Each directory is a domain with a `repository.ts` (DB access or file-backed desired state) plus its
logic and tests. Routes for a domain live in `src/routes/<domain>.routes.ts`.

| Domain | What it owns | Depth |
| --- | --- | --- |
| `instances` | instance definitions, rename/delete cascades | `docs/INSTANCES.md` |
| `process` | supervisor, preflight, reconcile, stale, logs, health summary | `src/process/CLAUDE.md` |
| `proxy` | the OpenAI/Anthropic-compatible proxy | `src/proxy/CLAUDE.md` |
| `arguments` | engine argument catalogs, help registry, defaults | `content/CLAUDE.md`, `docs/ARGUMENT_SOURCE_EXTRACTION.md` |
| `build` | llama.cpp CMake builds | `docs/BUILD.md` |
| `envs` | immutable uv-managed Python engine environments | `docs/ENVIRONMENTS.md` |
| `jobs` | background-job kernel: stores, step transitions, pgid-killing exec, active-job registry, single shutdown path, log tail | `docs/BACKGROUND_JOBS.md` |
| `models` | gguf/safetensors scanning and caches; parsing runs in a single lazy worker thread and is **never** on a request path | `docs/GGUF_PARSING.md`, `docs/SAFETENSORS_PARSING.md`, `docs/GGUF_QUANTIZATION_LABEL.md` |
| `hf` | HuggingFace Hub browser and download jobs | `docs/HF_DOWNLOADS.md` |
| `resources` | memory pools and the capacity ledger | `docs/RESOURCE_MANAGEMENT.md` |
| `memory-estimate` · `memory-assessment` | a-priori footprint; evidence receipts, drift, auto-assess loop | `docs/MEMORY_ESTIMATION.md` |
| `system` | host telemetry and the always-on 1 Hz metrics recorder | `docs/SYSTEM_METRICS.md` |
| `nvidia` | NVML telemetry over a koffi FFI binding — **the only GPU-memory authority** — plus per-GPU health facts (ECC / row-remap / page-retirement, throttle reasons, PCIe link, recovery action, VRAM temp) surfaced as optional `SystemAccelerator` fields and web health badges | — |
| `numa` | topology/capability/cgroup/launch for per-instance pinning | `docs/NUMA_PINNING.md` |
| `benchmark` | engine-agnostic inference-speed benchmark | `docs/BENCHMARK.md` |
| `nodes` | fleet registry and reverse-proxy transport | `docs/FEDERATION.md` |
| `sources` | engine source checkouts and drift report | `docs/SOURCE_REPOSITORIES.md` |
| `update` | manager version/run-mode and the UI self-update runner | `docs/SELF_UPDATE.md` |
| `prerequisites` | host-tooling registry behind `GET /api/prerequisites` | `docs/PREREQUISITES.md` |
| `config-git` | the config root as a git repository | `docs/CONFIG_GIT.md` |
| `migrations` | one-shot boot data migrations | `docs/MIGRATIONS.md` |
| `presets` · `llama` · `path-catalog` · `settings` · `api-lab` · `filesystem` · `git` · `db` · `config-store` · `auth` · `routes` · `utils` | preset INI store · probe + source repo · named paths · settings sections · request lab · path browsing · the one git-process primitive · schema and connection · the config-store primitive · admin sessions · HTTP surface · shared helpers | — |

## Cross-domain rules

- **Every PATH lookup goes through `system/tool-probe.ts`** — `build/cuda.ts:findNvcc` and
  `envs/uv.ts:probeUv` included. The UI installs packages only via the gated runner (root or
  passwordless sudo only, command re-derived server-side). NVIDIA driver and ROCm `/dev/kfd`
  applicability come from the driver-independent display-class PCI inventory
  (`system/pci-inventory.ts`), and a driver's successful local-only install is boot-scoped until the
  operator reboots. A check is added only after it actually blocked a deployment.
- **`system/metrics-history.ts` is the single owner of every counter delta** (cpu/net/disk): it ticks
  at 1 Hz always-on and feeds both `/api/system/metrics*` and the `cpu`/`network`/`disk` fields of
  `getSystemResources()`. Never sample those counters from a request path — ad-hoc reads corrupt the
  rates for every other caller.
- `jobs/` is copy-identical across the update-kit repos, with `update/adapter.ts` as the only
  repo-specific seam; `node scripts/check-update-kit.mjs` verifies it against sibling checkouts.
