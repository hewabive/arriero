# Config file inventory

What each file under the portable config root holds and the identity rules that govern it. The
read/write mechanism (staging vs applied state, reload, quarantine, 409 conflicts) is
`docs/CONFIG_EDITING.md`; path placeholders are `docs/PORTABLE_PATHS.md`; the git layer is
`docs/CONFIG_GIT.md`.

Portable, hand-editable configuration lives in files, not the DB — the DB holds runtime state and
rebuildable caches (`docs/RUNTIME_LAYOUT.md`). One configurable root, `data/config/`
(`ARRIERO_CONFIG_DIR`). JSON files seed from the git-tracked repo-root `config/*.json` (not
`data/config/`); a malformed file is loudly quarantined, never silently defaulted; runtime-computed
defaults fill absent sections. Tracked config files carry **no timestamps** — provenance is
config-git commit history; `path-catalog.json` and `envs-state.json` are gitignored machine state and the
only files that keep `createdAt`/`updatedAt`.

## `instances/<name>.json` — instance definitions

Store: `instances/config-files.ts` (file-per-instance + in-memory cache), CRUD in
`instances/repository.ts`. Body = `Instance` minus runtime `status`/`pid` (derived on read).
`binaryPath` is stored inline; the optional `binaryPathRefId` re-resolves against the path catalog
on read.

**Identity = `name`** (the filename, charset `^[A-Za-z0-9._-]+$`). There is no separate `id` —
`name` is the runtime key everywhere: `process_runs.instanceId`, the supervisor map, proxy endpoint
`instance:<name>` / `target.instanceId`, the `/api/instances/:id` param.

Renaming cascades (`instances/rename.ts`): proxy `instance:<name>` refs (target `endpointId`, model
`routeTo.endpoint`), local `rpcWorkers[].instanceName`, `process_runs`, memory assessments and
`runtime/slots/<name>` follow the new name. A live instance (open process run) refuses rename with
409, and remote `remote:<nodeId>:<name>` refs held by other nodes stay stale. The edit form
auto-suggests the new name on model change and offers checkbox renames of the referencing target
name / public `modelId` — only while the old value still equals its derived default
(`impliedInstanceModelId` in core, shared by `proxy/target-models.ts` and the form).

Deletion cleans up server-side (`instances/delete-cleanup.ts`: local `rpcWorkers` refs, slots dir,
log files). The web delete dialog offers checkbox deletion of proxy records serving only this
instance — the dead closure over targets/pipelines/models from `web/src/ui/proxy/instance-refs.ts`,
shared with the rename panel; pipelines with other live targets survive and are surfaced as
warnings.

## `webapps/<name>.json` — managed web-UI definitions

Store: `webapps/config-files.ts` (file-per-webapp on the directory store), CRUD in
`webapps/repository.ts`. Body = `WebappConfigRecord`: kind, `envSpecId` (the managed Python
environment holding the app), host/port, `proxySourceId`, `autostart`, and the kind-discriminated
`settings`. Tree validation checks each file's schema, the name/filename match, and that
`envSpecId` / `proxySourceId` resolve against `envs.json` / `proxy/sources.json`; per-file restore
works like any other portable kind. **Identity = `name`** (the filename, same charset as instances) — it keys
`webapp_runs.webappId`, the supervisor map and `runtime/webapps/<name>`. Rename is refused while a
run is active and cascades to runs, the `.secrets.json` key and the data directory. The rendered
process environment is never stored — it is rebuilt from this record on every start
(`docs/WEBAPPS.md`).

## `models.json` — declarative model requirements

Store `hf/requirements.ts` (config-store id `model-requirements`, portable paths on), aggregate
array of `ModelRequirement` records: `{id, repoId, revision, paths, destDir}` — the same shape the
download queue accepts, so a requirement is directly enqueueable. **Identity = `id`** (uuidv7);
records are deduplicated by `(repoId, destDir)`, `destDir: null` meaning the default
`<models dir>/<owner>/<repo>` destination. A requirement is captured automatically when a download
is enqueued (`POST /api/hf/downloads` — the pinned revision sha and the requested file list), and
managed via `GET`/`POST /api/hf/requirements` and `DELETE /api/hf/requirements/:id`; deleting a
downloaded repo removes or trims the matching requirement only with the explicit
`removeRequirement` flag, because freeing space on one host does not mean the fleet stopped
needing the model. Satisfaction (`satisfied`/`partial`/`missing` + revision match) is derived per
host from the on-disk download manifests, never stored.

## `benchmark/prompts.json` — custom benchmark prompts

Store `benchmark/custom-prompts.ts` (config-store id `benchmark:prompts`), aggregate array of
`BenchmarkPrompt` records, **identity = `id`**. Validated and restorable like every portable kind;
details in `docs/BENCHMARK.md`.

## `presets/<name>.ini` — `--models-preset` files

The `presets` domain reads/parses and writes **raw INI verbatim**, atomically, with an mtime
conflict check — the only config file `llama-server` also edits, so it is exempt from the staged
model. The web editor is a plain INI textarea with structural checks only (`presets/validate.ts`).
Identity = filename; instances link a preset through the `--models-preset` arg, resolved at launch.
A router instance (preset, no `--model`) is launchable and observable but is **not** a per-model
proxy target.

## `envs.json` — Python environment specs

Store: `envs/repository.ts` (aggregate array + in-memory cache), CRUD through the
Environments domain (`docs/ENVIRONMENTS.md`). Each spec is host-independent intent:
engine, exact version, runtime variant, Python request, install source. **Identity =
`id`** (uuidv7), and it is load-bearing: the runtime directory
`<envsDir>/<engine>-<version>-<first 12 alnum of id>` and the generated path-catalog
entry name derive from it — which is what makes a cloned spec rebuild at the
byte-identical path on another host. Wheel `file:` URLs are stored verbatim and are a
host-local requirement (identical path or shared mount on every host). The
machine-local companion `envs-state.json` (same repository, gitignored) maps spec ids
to their generated path-catalog entry ids and keeps the local timestamps; it is
reconciled on listing, pruned at boot, and a dangling or absent entry self-heals.

## `settings.json` — host-wide settings sections

Sections `modelScan` / `sourceRepositories` / `build` / `environments` / `registries`
(`settings/store.ts`). Portable source specs store adapter, origin and location policy; managed
paths derive from `config.sourcesDir`. The `build` section holds host-independent intent only —
the physical-host knobs `native` and `parallelJobs` live in the machine-local `machine.json`
(`docs/BUILD.md`), and the file schema strips them if a legacy or foreign tree reintroduces them. `registries.npmRegistryUrl` is the host-wide npm registry
(`GET/PUT /api/registries`), applied as `npm ci --registry` in the llama.cpp `ui-install` build step
— the npm analog of the environments PyPI index, meant for any future npm-based build.
`defaultBinaryPath()` (`arguments/catalog.ts`) is exposed at `GET /api/build/default-binary` and
pre-selects the binary in the New-instance modal.

## `argument-defaults.json` — default args in the New-instance form

`instance` is the llama-server list; `engines.<id>` (`vllm` / `sglang`) covers the Python engines.
`argumentDefaultsForKind` in core maps kind → section via the catalog-parser id, so the `sglang` and
`ktransformers` kinds deliberately share `engines.sglang`. Presets are edited as raw INI and carry
no arg defaults.

## `path-catalog.json` — named paths

`path-catalog/repository.ts`, in-memory array + atomic write-through. Kinds `binary` and
`models-dir`. Identity = `id` (uuidv7); `(kind, name)` is enforced unique in code. `binary` entries
are referenced by `binaryPathRefId` on instances; `models-dir` entries are extra GGUF scan roots.
Not seeded from repo-root and not git-tracked — machine state, since build completion and the env
reconciler rewrite it.

## `resources.json` — memory pools

`resources/repository.ts`, kinds `gpu` / `host`. The file holds **declarations**: identity,
`reservedBytes` intent, and `capacityBytes` only for manual pools — an `autoCapacity` pool stores
`null` and resolves its effective capacity from detected hardware at read time, which keeps the
tracked file host-neutral for a shared origin. `budget = capacityBytes − reservedBytes`; instances
declare a per-pool `memory` draw. The pure ledger `buildResourceLedger` / `checkDrawAdmission` in
core is shared by manual-start admission and the proxy eviction planner. Scaffolded from detected
hardware on first run; a GPU detected later joins only through the explicit "Declare pool" action
(`POST /api/resources/pools`) — runtime never writes this file on its own. A gpu pool whose device
disappeared gets a derived (never persisted) `orphaned` flag, contributes zero budget, and is
deletable via API/UI only while orphaned and unreferenced. See `docs/RESOURCE_MANAGEMENT.md`.

## `proxy/{targets,models,pipelines,endpoints,sources,settings}.json`

Low-level store `proxy/config-files.ts`; CRUD in `proxy/repository.ts`, `proxy/endpoints.ts`,
`proxy/sources.ts`, `proxy/settings.ts`. Aggregate-per-type arrays, except `settings.json` which is a
single object (currently `allowAnonymous`). In-memory cache + write-through; external edits apply on
restart.

API keys live in `config/.secrets.json` (gitignored), never in `endpoints.json`; env-var auth stays
preferred. `sources` = request labeling plus an optional auth gate: an inbound
`Authorization: Bearer` / `x-api-key` is resolved (`resolveApiProxyRequestSource`) to stamp
`trace.sourceId` / `sourceName`. A disabled source's key is always rejected `423` with its
`blockedMessage`; with `allowAnonymous:false` unknown or missing keys get `401`. The gate
(`apiProxyRequestGate`) runs pre-body-read in `proxy/protocol-endpoint.ts` and on `GET /v1/models`,
shaped per facade by the adapter `authError` (`docs/API_PROXY_FOUNDATION.md` § Request sources).
Default `allowAnonymous:true` keeps labeling-only passthrough. Source keys live in `.secrets.json`
keyed `source:<id>`; webapp session secrets live there too, keyed `webapp:<name>`
(`docs/WEBAPPS.md`).
