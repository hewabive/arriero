# Config store unification plan

Status: planned (2026-08-14). Tracks the staged refactor of every file-backed config store onto one
primitive with uniform validate-then-apply editing rules. Companion docs: `CONFIG_GIT.md`,
`PORTABLE_PATHS.md`.

## Motivation

Today the stores split into two ad-hoc camps with different failure modes:

- **Per-request read** (`settings.json`, `argument-defaults.json`, presets): external edits apply
  instantly, an invalid file 500s every dependent route until fixed, no transactionality across
  files.
- **Process-lifetime cache** (instances, `proxy/*.json`, `.secrets.json`, `path-catalog.json`,
  `resources.json`, `nodes.json`): external edits are invisible until restart, are silently
  clobbered by the next API write (whole cached array written back), and an invalid file kills the
  next boot before `serve()`.

Shared weaknesses: no `app.onError` (store failures surface as bare 500, the real message only in
stderr), 42 unguarded `c.req.json()` sites (malformed body → 500 instead of 400), five copies of
`atomicWrite`/`parseJsonFile`, bare `.parse()` (raw ZodError) in settings/defaults vs wrapped
`safeParse` elsewhere, and `normalizeConfigFiles()` flags proxy/nodes/resources files via
`hasPortablePathCandidate` even though their stores do no portable-path conversion (non-converging
rewrite churn on every boot).

## Target semantics (the contract)

**Disk is staging; memory is the applied state; the only transition is a full-tree
validate-then-apply.** Concretely, for every JSON config store:

1. Reads serve the applied (cached) state. Broken files on disk never break request serving.
2. External edits are **detected** (mtime probe), surfaced as `dirty on disk`, and activated only by
   `POST /api/config/reload` — fresh read of the whole tree, full validation (per-file Zod +
   cross-file refs), then one atomic cache swap. Invalid tree ⇒ nothing applies, old state keeps
   serving, per-file issues returned.
3. Server writes conflict-guard: if the file changed on disk since the store loaded it, the write
   fails 409 instead of silently clobbering the hand edit (the preset `expectedMtimeMs` pattern,
   generalized).
4. Boot with invalid config **quarantines** instead of dying: the server starts, broken stores/files
   are flagged, dependent routes 503 with the issues, and fix + reload recovers without a restart.

Exclusions:

- **Presets** keep live per-request reads and their existing mtime-conflict write — the INI files
  are co-owned by `llama-server`, which reads them from disk at launch; "applied state" has no
  meaning for them. Tree validation still covers them read-only.
- **`.secrets.json`** stays schema-light and gitignored; it participates in the reload swap
  (cache reset) but not in tree validation.
- The original "last-known-good fallback" idea dissolves into this architecture: the applied cache
  *is* the last known good. LKG-specific code is only needed at boot (quarantine) — never at
  runtime.

Semantic change to call out: `settings.json` and `argument-defaults.json` lose hot per-request
adoption of external edits; they become detected-then-applied like everything else. Uniform rules
beat two special cases, and the reload endpoint plus the dirty indicator replace the hot path.

## Stage 1 — `config-store` primitive, behavior-preserving migration

New module `apps/api/src/config-store/`:

- `file-store.ts`: `createJsonFileStore<T>({ id, path, schema, emptyValue, portablePaths })` →
  `{ read, write, reset, status }`. Owns: atomic write via `utils/atomic-write.ts`, JSON parse with
  `Invalid JSON in <path>` wrap, `safeParse` with `Invalid config in <path>` wrap (typed
  `ConfigFileError { path, stage: "json" | "schema", message }`), optional
  `fromPortableConfig`/`toPortableConfig` at the boundary, loaded-mtime bookkeeping (recorded now,
  used from Stage 3).
- `directory-store.ts`: the file-per-record variant for `instances/*.json` (same core, keyed map).
- `registry.ts`: every store self-registers `{ id, files(), reset() }`; single enumeration point for
  status, reload, and boot.

Migrations (public repository signatures unchanged; each is a mechanical internal swap):
`settings/store.ts`, `arguments/defaults-repository.ts`, `path-catalog/repository.ts`,
`resources/repository.ts`, `nodes/repository.ts`, `proxy/config-files.ts` (generic
`readCollection`/`writeCollection` become thin wrappers; secrets stay a special store),
`instances/config-files.ts`. `envs/repository.ts` registers in the registry (it already participates
in `reloadPortableConfigCaches`); migrate it onto the primitive only if trivial.

Also in this stage (pure cleanup): delete the five local `atomicWrite`/`parseJsonFile` copies;
replace the bare `.parse()` reads in settings/defaults with the wrapped form; fix
`config-normalize.ts` to only consider portable-mapped stores (drops the proxy/nodes/resources
rewrite churn).

Cache semantics do **not** change in this stage — currently-cached stores stay process-cached,
settings/defaults stay per-request — so the stage is a safe, committable no-op behaviorally.

Tests: unit tests for the primitive (parse/validate/portable-mapping/atomic write), existing suite
green.

## Stage 2 — typed errors, `app.onError`, store status

- `app.onError` in `http.ts`: `ConfigFileError` → 500 `{ error: { message, configFile } }` (and
  `logger.error`); JSON body `SyntaxError` from `c.req.json()` → 400
  `{ error: "invalid JSON body" }` (fixes all 42 sites at once); fallback → logged 500. From
  Stage 3 it also maps `ConfigWriteConflictError` → 409.
- Core schemas `ConfigStoreStatus` (+ per-file entries) in `packages/core`; a new config routes
  module (routes/config.routes.ts) with `GET /api/config/state`: per registered file — store id, path,
  applied mtime, disk mtime, `inSync`, `missing`, current quarantine issue if any; plus an aggregate
  `dirtyOnDisk` flag.
- Web: a status chip/banner on the Configuration Git view (grows into the general "Configuration"
  surface in Stage 4) showing dirty-on-disk files and store errors.

## Stage 3 — mtime detection + write conflict guard

- Every JSON store's `read` stats the file (µs-cheap) to keep `diskMtimeMs` fresh for
  `/api/config/state`; **reads still serve the applied state** — detection only, no hot adoption.
- `write` compares the file's current mtime against the store's loaded mtime; mismatch ⇒
  `ConfigWriteConflictError` → 409 with a hint to `GET /api/config-git/validation` +
  `POST /api/config/reload` (or to re-read). This kills the silent-clobber failure mode for hand
  edits. Server-initiated writes update the tracked mtime, so normal API flows never conflict.
- The settings/defaults semantic change lands here; release note in the commit message.

## Stage 4 — validate-then-apply (`POST /api/config/reload`)

- Close the parity gap in `config-git/validation.ts:validateConfigRoot` so it validates everything
  the per-route checks do: proxy target → endpoint refs, model `routeTo` refs (target/pipeline/
  endpoint), endpoint self-reference, instance `rpcWorkers` refs. (Pipeline graphs, instance→pool
  refs, name/file match, symlink rejection already exist.)
- `POST /api/config/reload` in the config routes module:
  1. Quiescence: refuse (409) while build/env/source-repository jobs run (they read settings
     mid-job). Running managed instances do **not** block — a reload is a batch of ordinary config
     edits, and `configDrift` detection already covers live processes.
  2. Fresh-read + `validateConfigRoot(config.configDir)`. Any issue ⇒ 400
     `{ applied: false, issues }`, applied state untouched.
  3. Swap: `reloadPortableConfigCaches()` (registry-driven after Stage 1) + `refreshAutoCapacities`.
     The entire read-validate-swap path is synchronous, so it is atomic with respect to request
     handling — no half-applied state is ever observable.
  4. `normalizeConfigFiles()` after the swap (placeholder-izes hand-written absolute paths, exactly
     like boot), then re-stat all files so `/api/config/state` is clean.
  5. Response: `ConfigReloadResult { applied, issues, normalizedFiles }` (core schema).
- Web: "Apply changes from disk" button next to the dirty banner; issue list rendered from the
  validation shape already used by the config-git UI.
- Agent workflow becomes: edit files → `GET /api/config-git/validation` → `POST /api/config/reload`.

## Stage 5 — boot quarantine (riskiest stage)

- `registry.initAllStores()` replaces the scattered boot init calls: each store attempts its first
  load; a `ConfigFileError` is captured as the store's quarantine issue instead of propagating.
  Boot always reaches `serve()`; the boot log and `/api/config/state` (and the public status page)
  carry the issues.
- Quarantined store reads throw the stored `ConfigFileError` → `app.onError` → 503 with the file
  and message; every other domain keeps working. Fix the file + `POST /api/config/reload` recovers
  live (reload validates the whole tree, so recovery clears quarantine atomically).
- Instances get **per-file** quarantine: `load()` collects invalid files instead of aborting the
  directory; valid records serve normally; `listInvalidInstanceFiles()` feeds route responses and
  the UI (stub rows named by filename, marked config-error, not launchable).
- Reconcile guard: `reconcileProcessRuns` must not stale-close or orphan an open run whose
  `instanceId` matches a quarantined file. Adoption matches per-run launch snapshots, not the
  instance config — verify that path needs no record and add a regression test (boot with a live
  process + its instance file corrupted ⇒ run stays adopted, instance shows config-error).
- Explicit non-goal: no auto-repair, no writing to quarantined files from mutation routes (they
  409/503 until reload clears the store).

## Stage 6 — docs + surface polish

- New `docs/CONFIG_EDITING.md`: the unified editing contract (staging vs applied, detection,
  conflict guard, reload, quarantine, presets/secrets exceptions) — written for both humans and
  agents; CLAUDE.md gets a one-line pointer replacing the current per-store cache notes.
- Update `CONFIG_GIT.md` (reload vs git ops; git ops keep their stricter quiescence) and
  `PORTABLE_PATHS.md` (normalize-on-reload).
- Web: promote the config-git view into a "Configuration" page owning: git panel, store state,
  dirty files, validation issues, apply button, quarantine banners.

## Decisions taken (defaults, revisit only with cause)

- Reload is all-or-nothing across the whole tree; no per-file partial apply (consistency of
  cross-file refs is the point).
- Reload does not require stopping managed instances; tree-changing config-git operations keep
  their stricter guards unchanged.
- New routes live under `/api/config/*`; `GET /api/config-git/validation` stays where it is
  (compat) and remains the pre-apply dry run.
- Store repository public APIs stay sync; reload stays sync end-to-end for atomicity.
- Presets and `.secrets.json` keep their special semantics (documented above).

## Out of scope (tracked separately)

The UI-coverage traps found in the 2026-08-14 audit are not part of this refactor: `instance.cwd`
invisible in UI, `scheduling.evictionPolicy` editable only for ktransformers, proxy model
`routeTo:{type:"endpoint"}` destroyed by the model editor's Save, secrets not clearable from UI,
non-llama source-repository `location` read-only, hand-added resource pools undeletable,
argument-defaults with alias/unknown keys invisible on the Arguments page.

## Test plan summary

- Primitive: parse/validation wrap, portable mapping, atomic write, mtime tracking, conflict guard.
- Reload: valid tree applies + normalizes; invalid tree rejects untouched; cross-ref parity cases;
  quiescence 409; dirty-detection round-trip.
- Quarantine: boot with each store broken (JSON + schema), per-file instance quarantine, reconcile
  regression with a live process, live recovery via reload.
- `app.onError`: config error mapping, malformed-body 400, conflict 409.
- Existing suite green at every stage boundary; `pnpm check` is the gate per commit.
