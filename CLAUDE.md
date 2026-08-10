# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`arriero` is a local single-user control plane for `llama.cpp` / `llama-server`: it manages instance
definitions, supervises child processes, scans GGUF models, builds llama.cpp from source, documents
`llama-server` arguments, and exposes an OpenAI/Anthropic-compatible API proxy in front of managed
and external endpoints.

## Commands

```bash
pnpm dev            # build core, then run api (tsx watch) + web (vite) in parallel
pnpm build          # build all workspaces (pnpm -r build)
pnpm serve          # build, then run api alone (pnpm start) serving the built web UI — single process, one port
pnpm check          # THE gate: events, format, build core, tsc --noEmit, arg-doc quality, all tests
pnpm check:events   # run scripts/check-react-event-captures.mjs only
pnpm check:sources  # checks needing a llama.cpp checkout / sibling repos — not part of `check`
pnpm check:silent-catch  # advisory inventory of catches that swallow without a trace
pnpm format         # prettier --write .   (format:check reports instead of writing)
pnpm knip           # unused exports/deps
```

- API: `http://127.0.0.1:8787`, Web UI: `http://127.0.0.1:5173`.
- `pnpm dev` always builds `@arriero/core` first — api and web import the built output, so after
  changing `packages/core` rebuild it (`pnpm --filter @arriero/core build`) before downstream
  typechecks see the change.
- **`pnpm check` is the gate — run it before every commit.** It is the only command that has to
  pass; `check:sources` is separate because it needs machine state (a llama.cpp checkout, sibling
  update-kit repos) that a fresh clone does not have, and each of its checks exits non-zero when
  that input is missing rather than reporting a silent pass.
- Tests live next to sources as `*.test.ts` in `apps/api` and use the Node test runner. They run as
  part of `pnpm check`; on their own: `pnpm --filter @arriero/api test`. The glob is quoted so Node,
  not the shell, expands it — `src/test/test-discovery.test.ts` fails if any test file stops being
  reachable. One file:
  `pnpm --filter @arriero/api exec tsx --import ./src/test/setup-env.ts --test src/proxy/scheduler.test.ts`.
  Filter by name: add `--test-name-pattern "<regex>"`. `src/test/setup-env.ts` points the DB and
  runtime dirs at temp locations.
- Argument-docs maintenance CLIs (api package): `args:docs:source-sync` (compare/`--diff`/`--write`
  the generated help snapshot) and `args:docs:quality`.
- `pnpm browse <cmd>` (`scripts/browse.ts`, `.claude/skills/browse`) — drive the running web UI via
  headless Playwright to visually verify changes (`open`/`goto /#/route`/`act --click`/`screenshot`).
  Invoke as `pnpm browse …` not `node --run browse` (the latter mangles `()` in selectors).

## Architecture

pnpm workspace, Node 24+, ESM throughout. **Relative imports use `.js` extensions** (NodeNext
resolution) even though sources are `.ts`.

- `packages/core` — the contract layer. All request/response shapes and shared types are Zod schemas
  exported from `src/index.ts` (e.g. `InstanceCreateSchema`, `ApiProxyTargetRecord`, `RuntimeState`).
  Both api and web import from `@arriero/core`; treat it as the single source of truth and add new
  shapes here first. Per-`InstanceKind` engine specifics (probe/log-parser/preflight/estimator/
  arg-catalog-parser/argv-builder ids, `nativeApi` gating the web llama panels, proxy capability
  flags gating slot-save/stream-resume/model-load/SSE-timings) hang off `engineDescriptor`
  (`src/engine-descriptor.ts`), implemented by api-side registries and read by the web kind selector
  and gates — contract and new-engine checklist in `docs/ENGINE_ADAPTERS.md`.
- `apps/api` — Hono server on `@hono/node-server`. `src/index.ts` is the entrypoint (migrate DB →
  reconcile process runs → serve, with graceful SIGINT/SIGTERM shutdown of supervised children).
  `src/http.ts` is only the composition root — CORS, `requireAdmin`, static serving, and one
  `register*Routes(app)` call per module in `src/routes/*.routes.ts` (plus
  `proxy/protocol-routes.ts`). Persistence is SQLite via Drizzle + `better-sqlite3`. Logging via
  `pino`.
- `apps/web` — React 19 + Vite + Mantine UI, server state via TanStack Query; `@xyflow/react` powers
  the Routing pipeline canvas (`src/ui/proxy/canvas/`). `src/ui/views/*` are top-level pages;
  `src/api/` is the typed fetch layer (`http.ts` + `base.ts` do the work, `client.ts` re-exports).

### API route conventions (`apps/api/src/routes/*.routes.ts`)

- Every mutating handler parses the body with a core Zod schema via `safeParse` and returns
  `{ error: parsed.error.flatten() }` with 400 on failure; success returns `{ data }`. Cross-entity
  reference checks (e.g. `validateApiProxyTargetRefs`) run after schema parsing and return a plain
  string error.
- `/api/*` routes are gated by `requireAdmin`; the public proxy facades (`/v1/*`, `/proxy/v1/*`,
  `/proxy/anthropic/v1/*`) and `/api/public/status` are not.
- A proxy model has two independent flags: `visible` (listed in `GET /v1/models`) and `enabled`
  (serves requests; `enabled:false` ⇒ `503 model_disabled` before routing/autostart, yet still
  callable by name so hidden models can be tested).
- `GET /v1/models` mirrors llama.cpp router mode with a per-model `status` (`proxy/model-status.ts`,
  off a 2s `getCachedApiProxyRuntimeSnapshot`, never autoloads). Its load `value` is a frozen
  llama.cpp-derived external contract — see `docs/API_PROXY_FOUNDATION.md`. The four status layers
  (process → instance-health → proxy-target → public) and their intentional divergences are mapped
  in `docs/STATUS_LAYERS.md`; do not "unify" them.

### Domain modules (`apps/api/src/`)

Each subdirectory is a domain with a `repository.ts` (DB access or file-backed desired state) and
logic/test files:

`instances` · `process` (supervisor, preflight, reconcile, stale, logs, health-summary) · `proxy` ·
`arguments` · `build` (`docs/BUILD.md`) · `envs` (immutable uv-managed Python engine environments,
`docs/ENVIRONMENTS.md`) · `jobs` (background-job kernel: stores, step transitions, pgid-killing
exec, active-job registry + single shutdown path, log tail — used by build/envs/update/sources and
copy-identical across the update-kit repos, `docs/BACKGROUND_JOBS.md`) ·
`models` (gguf/scanner/cache) · `presets` · `llama` (probe + source repo) ·
`path-catalog` · `resources` (memory pools + capacity ledger) · `memory-estimate` (a-priori per-pool
footprint from GGUF + args) + `memory-assessment` (per-engine analytical/measured evidence receipts +
fingerprint drift + background auto-assess loop that auto-binds analytical / auto-captures measured
evidence for unassessed or stale instances — never touches `mismatch`, never applies draws,
`docs/MEMORY_ESTIMATION.md`) · `system` (host telemetry + the always-on
1 Hz metrics recorder, `docs/SYSTEM_METRICS.md`) · `api-lab` · `filesystem` ·
`nodes` (fleet registry + reverse-proxy transport, `docs/FEDERATION.md`) · `update` (manager
version/run-mode + UI self-update runner, `docs/SELF_UPDATE.md`) · `prerequisites` (host-tooling
registry behind `GET /api/prerequisites` + `#/prerequisites`, `docs/PREREQUISITES.md`) ·
`sources` (engine source checkouts + drift report, `docs/SOURCE_REPOSITORIES.md`) ·
`nvidia` (NVML telemetry over a koffi FFI binding; the only GPU-memory authority) ·
`git` (the one git-process primitive under `config-git`/`sources`) · `settings` ·
`config-git` (`docs/CONFIG_GIT.md`) · `migrations` (`docs/MIGRATIONS.md`) · `numa`
(`docs/NUMA_PINNING.md`) · `db` · `routes` (one `*.routes.ts` per domain) · `utils`.

Two `prerequisites` rules constrain code elsewhere: every PATH lookup goes through the one primitive
`system/tool-probe.ts` (`build/cuda.ts:findNvcc` and `envs/uv.ts:probeUv` included), and the UI
installs packages only via the gated runner (root/passwordless-sudo only, command re-derived
server-side). NVIDIA driver and ROCm `/dev/kfd` applicability come from the driver-independent
display-class PCI inventory (`system/pci-inventory.ts`), and the driver's successful local-only
install is boot-scoped until the operator reboots. A check is added only after it actually blocked a
deployment.

`system/metrics-history.ts` is the single owner of every counter delta (cpu/net/disk): it ticks at
1 Hz always-on and feeds both `/api/system/metrics*` and the `cpu`/`network`/`disk` fields of
`getSystemResources()`. Never sample those counters from a request path — ad-hoc reads corrupt the
rates for every other caller.

### Process supervision

- Instances are launched directly as child processes (`child_process.spawn`, `detached`, own pgid) by
  `process/supervisor.ts` — `systemd` is not involved. Children write stdout/stderr straight to the
  `.raw.log` file fd (no pipes — they survive manager death without EPIPE); the supervisor tails the
  raw file (`raw-log-tail.ts`) to build the filtered log and emit `log` events.
- Managed processes **survive manager restarts by default**: on startup `process/reconcile.ts`
  re-adopts each open `process_runs` row whose PID is alive and `/proc/<pid>/cmdline` matches the
  per-run launch snapshot (`launch-snapshot.ts`). Adopted runtimes are controlled by PID — no child
  handle, exit detected by poll, `exitCode` unavailable, unexpected death ⇒ `error` — and the log
  tail resumes from raw EOF; unmatched live PIDs fall back to `stale` (`process/stale.ts`). Set
  `ARRIERO_STOP_MANAGED_ON_EXIT=true` to stop children on manager exit instead.
- The launch snapshot also powers config-drift detection: `InstanceHealthSummary.configDrift` flags a
  live process whose instance args/env/binary/`numa` changed since launch (web shows a `config drift`
  badge).
- Optional per-instance NUMA control lives in the `numa/` domain (`topology`/`capability`/`cgroup`/
  `launch`): `instance.numa` is a discriminated union of `{mode:"bind",node}` (CPUs+memory confined
  to one node via a cpuset cgroup + spawn shim) and `{mode:"interleave",nodes}` (spawn wrapped in
  `numactl --interleave`, the high-throughput mode for big CPU models). `resolveNumaLaunch(…)` is the
  single place that picks the spawn wrapper; `SystemResources.numa.{bind,interleave}` gate it. On a
  single-node (UMA) host `instance.numa` is inert everywhere — `numaIsApplicable` gates launch, KT
  preflight and the prerequisites numa group (`docs/NUMA_PINNING.md` § Single-node hosts).
  `bind` additionally needs a one-time `Delegate=cpuset` drop-in
  (`scripts/setup-numa-cgroup-delegation.sh`) **and** the manager running inside that user session —
  see `docs/NUMA_PINNING.md`.
- The health summary turns an otherwise-healthy instance `degraded` on two runtime signals sampled in
  `process/runtime-memory.ts`: ≥64 MiB swapped out across the instance's pids (`swapBytes`), and —
  for a running `interleave` instance — NUMA placement skew where one node holds >1.5× its even share
  (`numaPlacement`, `numa skew` badge; the page-cache flood trap is in `docs/NUMA_PINNING.md`).
- `process_runs` keeps the last 20 closed runs + open runs per instance (`runs-repository.ts`);
  every close records a `stopReason` (`operator`/`eviction`/`idle`/`shutdown`/`delete`/`stale`/
  `crash`, owned by core `process.ts:ProcessStopReason`). The filtered log strips routine `/health`,
  `/props`, `/slots`, `/v1/models` probes; `ARRIERO_FILTER_PROBE_LOGS=false` disables filtering.

### API proxy

A separate `proxy` domain fronts both managed `llama-server` instances and external APIs. Overview,
admin surface and telemetry: `docs/API_PROXY_FOUNDATION.md`.

- **The scheduler (`proxy/scheduler.ts`) is pure and side-effect-free** — it takes a runtime snapshot
  and returns an ordered action list (`start-instance`, `load-model`, `save-slot`, `unload-model`,
  `route-request`, …); only the executor (`proxy/public-executor.ts`) translates actions into real
  operations (autostart/autoload, preemption via unload/stop, slot save/restore).
- Request flow in `proxy/protocol-endpoint.ts:proxyProtocolEndpoint`: resolve model → route chain
  (`pipeline.ts`) →
  gateway decision (`gateway.ts`) → acquire domain lease → execute plan → forward (`forwarder.ts`) or
  resumable. `proxy/resumable-forward.ts` survives mid-request preemption (slot save → swap → restore
  → assistant-prefill resume, `docs/API_PROXY_PREEMPTION.md`). Protocol adapters (`openai.ts`,
  `anthropic.ts`, `protocol.ts`) shape errors per public API.
- Two resource axes, documented in `docs/RESOURCE_MANAGEMENT.md`: **memory residency** (scheduler
  fit/eviction over the file-backed pools in `config/resources.json`) and **compute contention** (a
  multi-holder per-domain priority gate/lease in `proxy/domain-coordinator.ts`, keyed on the memory
  pools a request draws from — gpu **and** host, so CPU contention is arbitrated like GPU; no
  declared draws ⇒ no lease ⇒ unmanaged concurrency). Policy is injected via `decide()`
  (`proxy/domain-admission.ts`); competing requests **queue, not 503**.
- **Pipelines** are node graphs resolved as a pure pre-pass before gateway/lease. Ports reference
  nodes/targets/pipelines (a pipeline ref is a tail jump), `call` + named `exit`s give function
  semantics, and loops are forbidden (save-time `pipeline-validation.ts` + runtime budgets). Nodes:
  `replace-text`, `capture-request`, `edit-request`, `reasoning`, `output-limit`,
  `context-limit`, `token-scale`, `strip-attribution`, `cache`, `loop-guard` (repetition-loop
  detection/enforcement, `docs/API_PROXY_LOOP_GUARD.md`), `condition`, `call`, `exit`. Resolution lands in `trace.routeTrace`;
  dry-run via `POST /api/proxy/route-explain`. See `docs/API_PROXY_PIPELINES.md`, and
  `docs/API_PROXY_RESPONSE_CACHE.md` for the `cache` node (short-circuits before gateway/lease,
  single-flight coalescing, streaming fan-out, framing-matched store).
- Inbound Anthropic `messages` to non-anthropic-profile upstreams is **always translated to OpenAI
  chat completions** via the sans-IO workspace package `packages/anthropic-openai-bridge`, wired in
  `proxy/translation.ts`; anthropic-profile endpoints pass through verbatim. Claude Code's
  `x-anthropic-billing-header`/`cch` attribution churns the llama.cpp KV prefix cache, and stripping
  it is **not automatic** — it is the placeable `strip-attribution` node
  (`sanitizeClaudeCodeAttribution` in `proxy/attribution.ts`), inserted where needed (e.g. before a
  cache node). See `docs/ANTHROPIC_OPENAI_BRIDGE.md`.
- Proxy targets reference entries in a shared API-endpoint catalog (`proxy/endpoints.ts`); managed
  instances and the manager-proxy itself are read-only generated entries. **External providers**
  collapse the target layer — an endpoint-routed or passthrough model resolves to a synthetic,
  non-persisted `ApiProxyTargetRecord` (`proxy/external-target.ts`) so the gateway/lease/forwarder
  path stays uniform, and targets persist only for managed instances. See
  `docs/EXTERNAL_PROVIDERS.md`.
- **Stream resume across manager restarts** (`docs/STREAM_RESUME.md`): managed SSE forwards on the
  plain `respond()` path attach a llama.cpp stream session (`X-Conversation-Id`,
  `proxy/stream-session.ts`; the preemptible path is excluded — detached sessions would break slot
  handoff). SIGTERM persists sessions to `data/proxy-pending-resume.json`, boot adopts and verifies
  them, an identical retry claims by resume key pre-gateway and replays through the standard
  downstream tract (`proxy/resume-replay.ts`). Self-update restart drains first (`proxy/drain.ts`).

### Database migrations

Schema is declared two places: `db/schema.ts` (Drizzle table defs for typed queries) and
`db/index.ts:migrate()` (hand-written idempotent `CREATE TABLE IF NOT EXISTS`). There is no
drizzle-kit pipeline and no in-place column migration — the DB is recreated, not migrated; to evolve
the schema, update both places. For an additive column against an existing DB, add an idempotent
`ALTER TABLE … ADD COLUMN` guard in `migrate()`. The DB holds runtime state and rebuildable caches;
portable config is file-backed (below). One-shot data migrations are inventoried in
`docs/MIGRATIONS.md`.

### File-backed config

Portable/hand-editable config lives in files, not the DB, under one configurable root `data/config/`
(`ARRIERO_CONFIG_DIR`). The root can be managed as a standalone git repo through the `config-git/`
domain and Configuration Git UI — in-place `init` (the only tree op allowed while processes run) or
`clone` as a **full replacement** that keeps the old root as `<configDir>.backup-<ts>`. Tree-changing
operations validate a detached worktree first, refuse while managed/build/environment jobs run, then
reset all file-config caches; `.secrets.json` remains local. **Machine-state files
`path-catalog.json`/`envs.json` are gitignored** (`config-git/machine-state.ts`: startup untracker,
snapshot/restore across tree ops, clone carry-over) and are the only config files keeping
`createdAt`/`updatedAt`. See `docs/CONFIG_GIT.md`.

- `config/presets/<name>.ini` — `--models-preset` files; the `presets` domain reads/parses and writes
  **raw INI verbatim** atomically with an mtime conflict check (the only file `llama-server` also
  edits). The web editor is a plain INI textarea with structural checks only (`validate.ts`).
  Identity = filename; instances link a preset via the `--models-preset` arg, resolved at launch. A
  router instance (preset, no `--model`) is launchable + observable but is **not** a per-model proxy
  target.
- `config/instances/<name>.json` — instance definitions (`instances/config-files.ts` file-per-instance
  store + in-memory cache; `instances/repository.ts` CRUD). Identity = `name` (filename, charset
  `^[A-Za-z0-9._-]+$`); there is no separate `id` — `name` is the runtime key everywhere
  (`process_runs.instanceId`, supervisor map, proxy endpoint `instance:<name>` / `target.instanceId`,
  `/api/instances/:id` param). Renaming cascades (`instances/rename.ts`): proxy `instance:<name>`
  refs (target `endpointId`, model `routeTo.endpoint`), local `rpcWorkers[].instanceName`,
  `process_runs`, memory assessments and `runtime/slots/<name>` follow the new name; a live
  instance (open process run) refuses rename with 409, and remote `remote:<nodeId>:<name>` refs on
  other nodes stay stale. The edit form auto-suggests the new name on model change and offers
  checkbox renames of the referencing target name / public `modelId` — only when the old value
  still equals its derived default (`impliedInstanceModelId` in core, shared by
  `proxy/target-models.ts` and the form). Deletion cleans up server-side
  (`instances/delete-cleanup.ts`: local `rpcWorkers` refs, slots dir, log files) and the web delete
  dialog offers checkbox deletion of proxy records serving only this instance — the dead closure
  over targets/pipelines/models from `web/src/ui/proxy/instance-refs.ts` (shared with the rename
  panel); pipelines with other live targets survive and are surfaced as warnings. Body = `Instance`
  minus runtime `status`/`pid` (derived on read). `binaryPath` is stored inline;
  `binaryPathRefId` (optional) re-resolves against the path catalog on read.
- `config/settings.json` — `modelScan` / `sourceRepositories` / `build` sections
  (`settings/store.ts`). Portable source specs store adapter, origin and location policy; managed
  paths derive from `config.sourcesDir`. `defaultBinaryPath()` (`arguments/catalog.ts`) is exposed at
  `GET /api/build/default-binary` and pre-selects the binary in the New-instance modal.
- `config/argument-defaults.json` — default instance args (pre-listed in the New-instance form;
  presets are edited as raw INI and carry no arg-defaults).
- `config/path-catalog.json` — named paths (`path-catalog/repository.ts`, in-memory array + atomic
  write-through; kinds `binary` and `models-dir`). Identity = `id` (uuidv7); `(kind, name)` is
  enforced unique in-code. `binary` entries are referenced by `binaryPathRefId` on instances;
  `models-dir` entries are extra GGUF scan roots. Not seeded from repo-root and not git-tracked
  (machine state: build completion and the env reconciler rewrite it).
- `config/resources.json` — memory pools for capacity-aware scheduling (`resources/repository.ts`;
  kinds `gpu`/`host`). `budget = capacityBytes − reservedBytes`; instances declare a per-pool
  `memory` draw. The pure ledger `buildResourceLedger`/`checkDrawAdmission` in core is shared by
  manual-start admission and the proxy eviction planner. Scaffolded from detected hardware on first
  run; `autoCapacity` pools re-sync in memory at startup without dirtying Git. A gpu pool whose
  device disappeared gets a derived (never persisted) `orphaned` flag and is deletable via API/UI
  only while orphaned and unreferenced by instance draws. See `docs/RESOURCE_MANAGEMENT.md`.
- `config/proxy/{targets,models,pipelines,endpoints,sources,settings}.json` — API-proxy config
  (`proxy/config-files.ts` low-level store; `proxy/repository.ts` + `proxy/endpoints.ts` +
  `proxy/sources.ts` + `proxy/settings.ts` CRUD). Aggregate-per-type arrays (`settings.json` is a
  single object, currently `allowAnonymous`); in-memory cache + write-through, external edits apply
  on restart. API keys live in `config/.secrets.json` (gitignored), never in `endpoints.json`;
  env-var auth stays preferred. `sources` = request labeling + optional auth gate: an inbound
  `Authorization: Bearer`/`x-api-key` is resolved (`resolveApiProxyRequestSource`) to stamp
  `trace.sourceId`/`sourceName`; a disabled source's key is always rejected `403` with its
  `blockedMessage`, and with `allowAnonymous:false` unknown/missing keys get `401` — gate
  (`apiProxyRequestGate`) runs pre-body-read in `protocol-endpoint.ts` and on
  `GET /v1/models`, shaped per facade by adapter `authError`
  (`docs/API_PROXY_FOUNDATION.md` § Request sources). Default `allowAnonymous:true` keeps
  labeling-only passthrough. Source keys live in `.secrets.json` keyed `source:<id>`.

JSON files seed from git-tracked repo-root `config/*.json` (not `data/config/`) and fail loud on
malformed JSON; runtime-computed defaults fill absent sections.

Paths under a managed root are **persisted as `${ARRIERO_HOME}` / `${ARRIERO_*_DIR}` placeholders**
(`config-paths.ts`) in `instances/*.json`, `path-catalog.json`, `settings.json` and
`argument-defaults.json`, expanded at each store's read boundary — repositories, API and UI only ever
see absolute paths, and renaming/moving the app dir keeps config valid. The broadest containing root
wins; paths under no managed root (and preset INIs, co-owned by `llama-server`) stay absolute. A
startup pass `normalizeConfigFiles()` rewrites any absolute path that reappears (hand edits) and
strips legacy `createdAt`/`updatedAt` from tracked config — **tracked config files carry no
timestamps; provenance = config-git commit history** — a standing normalizer, deliberately not a
registry migration. See `docs/PORTABLE_PATHS.md`.

### Argument documentation

Russian "Engineering help" for each `llama-server` argument lives in
`content/llama-args/llama-server/*.md`. The sync source of truth is the `HELP_START`/`HELP_END` block
in the configured llama.cpp checkout's `tools/server/README.md`, snapshotted into
`content/llama-args/source/`. Only the stored snapshot hash is an automatic stale signal — individual
doc files are not marked stale per-commit. Repo-local skills `.claude/skills/llama-arg-help-sync`
(Claude) and `.codex/skills/llama-arg-help-sync` (Codex) are thin wrappers over
`docs/ARGUMENT_HELP_WORKFLOW.md`, the single source of truth for the update procedure.

## Conventions

- **Reply to the user in Russian** (code, identifiers, commit messages, and docs stay in English).
- **Never create git branches unless asked** — commit to the current branch (on `main`, commit to
  `main`).
- **Keep this file token-dense.** Write CLAUDE.md tersely — every line must earn its tokens. Don't
  pad with restated context, examples already obvious from code, or motivational prose. Prefer
  editing/tightening an existing line over appending a new one; remove what's stale. Detail that only
  matters while working inside one domain belongs in that domain's `docs/` file, with a pointer here.
- **No code comments — categorical.** Do not write comments in source code (no `//`, `/* */`, JSDoc,
  or block banners). Code must be self-documenting: express intent through clear names, small
  functions, and types. If something genuinely needs explanation (non-obvious rationale, design
  constraints, gotchas), put it in a dedicated document under `docs/` and reference that doc from the
  relevant code path's surrounding documentation — never inline. This overrides any default tendency
  to add explanatory comments. Enforced by `scripts/check-no-comments.mjs` (in `pnpm check`), which
  reads comment trivia through the TypeScript parser — so `//` inside a string or template literal is
  not a comment — and allows only machine-readable pragmas (`@ts-expect-error`, `@ts-ignore`,
  `@ts-nocheck`, `eslint-disable`, `prettier-ignore`, `@deprecated`, `#!`).
- **A swallowed error must leave a trace.** A `catch` that neither rethrows nor returns a typed
  failure has to log via the shared `logger` (`apps/api/src/logger.ts` — the one place `pino` is
  constructed; background loops still prefer an injected `onError`). Unknown is an acceptable
  result, silently substituting a plausible value for it is not: prefer `null` plus a caller-side
  guard over `?? 0`/`?? []` when the real answer is "not measured".
- **React event captures**: `pnpm check:events` (part of `pnpm check`) fails the build if
  `event.currentTarget`/`event.target` from an outer handler is referenced inside a nested callback
  (setState updater, timer, promise). Read the value into a local first.
- TypeScript is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` — index
  access yields `T | undefined`, and optional properties must be omitted rather than set to
  `undefined`.
- Realtime: prefer SSE (Hono `streamSSE`); WebSocket only for bidirectional terminal-like control.
- Mantine component-wide defaults go in the `createTheme` in `web/src/main.tsx` (e.g. `Tooltip` opens
  on hover/focus/touch so tooltips work on mobile; the heading scale lives there too) — don't set
  per-usage props for behavior every usage should share.
- Web page chrome: the page title + one-line description are owned by the route entry in
  `web/src/ui/routing.ts` and rendered by `App.tsx` — a view never repeats them. Titles and labels are
  sentence case (acronyms kept: "API endpoints", "GGUF files"). Card headers are `Title order={4}`,
  page-level section headers `order={3}`; counted labels go through `ui/utils/plural.ts:countLabel`
  instead of hand-written `N items` / `N item(s)`.

## Runtime layout & key env vars

- `data/arriero.db` (WAL): process-run metadata (`process_runs`); request-trace history
  (`proxy_request_traces`, `proxy/traces-repository.ts` — 30-day retention whose prune also deletes
  `data/proxy-requests/` artifacts past the cutoff; reseeds the in-memory hourly stats at boot;
  browsable with full filters + facets at `#/proxy/traces`); system-metrics history
  (`system_metrics_history`, `system/metrics-repository.ts` — closed hour/day/month buckets upserted
  per bucket, reseeded into the recorder at boot, month backfilled from day rows; hour kept for its
  1 h span, day/month 30 days — `docs/SYSTEM_METRICS.md` § Persistence);
  per-instance memory-assessment receipts (`memory_assessments`,
  `memory-assessment/repository.ts` — one receipt per instance, analytical or measured, renamed and
  deleted with the instance; machine-local evidence, deliberately not in portable config);
  rebuildable caches — `model_cache`; `llama_argument_catalogs` (parsed `--help`, keyed by binary
  path, invalidated by size/mtime, mirrored to a per-binary sidecar read on DB miss
  (`arguments/sidecar.ts`) so it survives DB recreation and travels with the binary);
  `proxy_response_cache`.
- `data/proxy-runtime-metadata.json`: API-proxy runtime metadata (per-target saved-slot ids for
  preemption restore). In-memory map + atomic write-through (`proxy/runtime-metadata-store.ts`);
  rebuildable, not git-tracked. `lastRequestAt` is memory-only.
- `data/config/` (= `ARRIERO_CONFIG_DIR`): file-backed portable config — see above.
- `data/proxy-requests/`: per-request artifact files (opt-in via pipeline nodes like
  `capture-request`), one dir per request `<model>/<timestamp>-<traceId>/<NN>-<kind>.json` (inbound
  proxy model id, sanitized); metadata lands in `trace.files`, content served by
  `GET /api/proxy/request-file?path=` (`proxy/request-files.ts`); pruned with the 30-day
  request-trace retention by directory timestamp.
- `runtime/logs/`: managed-process stdout/stderr.
- `runtime/slots/<instance>/`: per-instance llama.cpp KV slot dumps (`config.slotsDir`).
  `--slot-save-path` is auto-injected at launch (never persisted into the instance JSON) so proxy
  preemption save/restore works without manual config — see `docs/API_PROXY_PREEMPTION.md` § Slots.
- `runtime/models/`: default primary GGUF scan root (`config.modelsDir`, used when `settings.json`
  has no `modelScan.directory`), overridable via `ARRIERO_MODELS_DIR`. The scan (`GET /api/models`,
  no `dir` param) merges all roots from `models/roots.ts` — settings directory + path-catalog
  `models-dir` entries + the llama.cpp download cache (`$LLAMA_CACHE`, else `~/.cache/llama.cpp`) —
  deduped; missing roots are skipped, not errors.
- `runtime/sources/`: managed inference source checkouts (`config.sourcesDir`,
  `ARRIERO_SOURCES_DIR`); `llama-cpp` defaults to `runtime/sources/llama.cpp`. Every Git operation
  requires the checkout's exact `--show-toplevel`, so an internal plain directory can never adopt the
  parent arriero repository. The generic API is `/api/source-repositories/*`; `/api/llama-source/*`
  remains the Build/docs compatibility adapter. See `docs/SOURCE_REPOSITORIES.md`.
- `runtime/builds/`: llama.cpp CMake build trees, **outside** the checkout, one per ref slug under
  the `BuildSettings.buildDir` base. See `docs/BUILD.md`.
- Paths overridable via `ARRIERO_HOME`, `ARRIERO_DATA_DIR`, `ARRIERO_CONFIG_DIR`,
  `ARRIERO_RUNTIME_DIR`, `ARRIERO_LOGS_DIR`, `ARRIERO_BUILDS_DIR`, `ARRIERO_SOURCES_DIR`,
  `ARRIERO_MODELS_DIR`, `ARRIERO_SLOTS_DIR`; host/port via `ARRIERO_HOST`/`ARRIERO_PORT`.
- Admin auth is **off by default** (admin routes open for local dev). Enable with
  `ARRIERO_ADMIN_PASSWORD` or `..._ADMIN_PASSWORD_HASH` (`scrypt$...`; generate via
  `pnpm auth:hash <pw>`); related: `..._AUTH_SECRET`, `..._SECURE_COOKIE` (leave false without TLS),
  `..._SESSION_TTL_SECONDS`. The default `/#/status` route is a public, redacted diagnostics page.
- All env vars seed from a gitignored repo-root `.env` (loaded in `config.ts` before any var is read;
  the real launch env wins). `.env.example` is the tracked template. Legacy `LLAMA_MANAGER_*` keys
  are renamed in place (`env-file-migration.ts`) and keep a read-time fallback (`manager-env.ts`).
- In prod (`pnpm serve`/`pnpm start`) the api serves the built `apps/web/dist` as static (mounted
  only if `dist` exists) — UI + API + proxy on the one `ARRIERO_PORT`; Vite (5173) is dev-only. The
  same build serves from the domain root or any reverse-proxy subpath without a rebuild; see
  `docs/SUBPATH_DEPLOY.md`.
- Shutdown: children survive manager exit by default and are re-adopted next start;
  `ARRIERO_STOP_MANAGED_ON_EXIT=true` stops them on exit; `ARRIERO_SHUTDOWN_TIMEOUT_MS` (default
  10000).
- Self-update (UI Update button) needs the supervised `serve` deployment installed by
  `scripts/install-service.sh` (`deploy/arriero.service`, `systemd --user`). The `update` domain
  refuses in `dev` mode. It doubles as a copyable kit shared with llm-arena/rag-manager —
  `update/adapter.ts` is the repo-specific seam; the other update files and the whole `jobs/` kernel
  stay byte-identical (`node scripts/check-update-kit.mjs` verifies against sibling checkouts). See
  `docs/SELF_UPDATE.md`.
