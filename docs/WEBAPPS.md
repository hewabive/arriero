# Web apps

The `webapps` domain (`apps/api/src/webapps/`) installs, configures and supervises third-party chat
web UIs as managed child processes wired to this node's API proxy. A webapp is deliberately **not**
an instance: it draws no memory pools, takes no part in admission or scheduling, and never appears
in the proxy endpoint catalog — it is a *client* of the proxy, not an upstream. Open WebUI is the
first supported kind.

## The adapter

`webappDescriptor(kind)` (`packages/core/src/webapp-descriptor.ts`) is the per-kind contract,
mirroring `engineDescriptor`: a `Record<WebappKind, WebappDescriptor>` whose exhaustiveness makes
the compiler point at every spot a new kind must fill in. A descriptor declares the install channel
(`python-env` — distribution and entrypoint inside a managed environment), default host/port, the
launch argv shape, the health-probe path, the config-render id (implemented api-side in
`webapps/render.ts`), the env keys the renderer owns (`reservedEnvKeys` — rejected in user
`extraEnv` by a core schema refinement), the files to back up before a version switch, and an
install footprint note surfaced by the create form. `install.kind` is a discriminated slot: future
kinds may install from a source build or a released binary without reshaping the record.

## Installation rides the environments domain

An Open WebUI installation **is** a Python environment: the `open-webui` provisioner in
`apps/api/src/envs/provisioners.ts` installs the pinned PyPI distribution into an immutable
uv-managed venv exactly like vLLM/SGLang (`docs/ENVIRONMENTS.md`). Unlike engine environments it
sets `catalogEngineKind: null`, so no path-catalog binary entry is generated — instances can never
select it, and webapps reference the environment spec directly through `envSpecId`. Deleting an
environment referenced by a webapp is refused. Version upgrades follow the engine culture: install
the new version as a new environment, repoint the webapp (refused while it runs), keep the old one
for rollback.

## Definition and storage

`WebappConfigRecord` (core `webapp.ts`) is file-per-name portable config under
`data/config/webapps/<name>.json`, on the standard directory store (staged reload, 409 write
conflicts, quarantine — `docs/CONFIG_EDITING.md`). Identity = `name`, same charset and semantics as
instances; `kind` is immutable; `settings` is a kind-discriminated union (Open WebUI: `auth`,
`slim`, `defaultModels`, `extraEnv`). Rename is refused while a run is active and cascades to
`webapp_runs`, the `.secrets.json` key and the data directory; changing `envSpecId` is likewise
refused while running. Secrets never live in the record: the app's stable session secret is
`webapp:<name>` in `config/.secrets.json`, created on first start.

## Config render: environment at spawn, no files

`webapps/render.ts` renders the child-process environment on **every start** — nothing is written
to disk, so there is no config file to drift. The Open WebUI renderer pins determinism
(`ENABLE_PERSISTENT_CONFIG=False` makes env authoritative on each boot; admin-UI edits do not
survive a restart by design), wires the proxy (`OPENAI_API_BASE_URL` → this manager's `/v1`, the
key of the linked request source), sets identity (`DATA_DIR` under `runtime/webapps/<name>`, the
session secret), and applies policy (`WEBUI_AUTH`, the slim profile that keeps the embedded
embedding/STT models off — they would otherwise be downloaded and loaded into RAM on top of the
~1.1 GB idle RSS measured for 0.11.0 with the slim profile on). `settings.extraEnv`
is appended last; reserved keys are rejected at the schema. The model list is never rendered — the
app discovers it from the proxy's `/v1/models`, so federation reach comes for free.

## Supervision

`webapps/supervisor.ts` follows the process-domain model with the engine-specific layers removed:
detached spawn with its own pgid, stdout/stderr straight to a raw-log fd, `RawLogTail` building the
filtered log (uvicorn probe-noise grammar), SIGTERM → SIGKILL stop escalation against the process
group. Children survive manager restarts; `webapps/reconcile.ts` re-adopts open `webapp_runs` rows
by pid + `/proc/<pid>/cmdline` match against the launch snapshot, defers quarantined definitions,
and marks unmatched live pids `stale` (`webapps/stale.ts` stops those). `ARRIERO_STOP_MANAGED_ON_EXIT`
applies to webapps too. After reconcile, boot starts every `autostart: true` webapp that has no
live run — the one supervision behaviour instances do not have, because nothing else would ever
wake a webapp.

The launch snapshot (`webapps/launch.ts`) stores argv, cwd, `envSpecId` and a **hash** of the
rendered environment — never the values, which contain secrets. Drift between the stored snapshot
and a re-render of the current record surfaces as `configDrift` on the served `Webapp`. When the
snapshot's `envSpecId` differs from the record's at start, the descriptor's `upgradeBackupFiles`
are copied aside (`webui.db` → `webui.db.bak-<oldEnv>`) before the new version boots — automatic
insurance against upstream DB migrations.

## Proxy wiring

Creating a webapp offers (default on) creating an API-proxy **request source** named after it: the
generated key lands in `.secrets.json`, the renderer hands it to the app, and from then on the
chat's traffic is labeled in traces and stats, can be blocked by disabling the source, and keeps
working under `allowAnonymous: false`. Deleting the webapp offers deleting the source. Start
preflight (`webapps/preflight.ts`) errors on a missing/uninstalled environment or an occupied port
and warns when the app listens on a wildcard host with authentication disabled.

## Surfaces

`/api/webapps*` (CRUD, start/stop/restart, runtime + live health probe, preflight, log tail) and
the web **Web apps** page (create form with inline environment install, status/env/drift badges,
Open link, logs). Runs live in the `webapp_runs` table (`docs/RUNTIME_LAYOUT.md`), last 20 closed
per webapp, `stopReason ⊂ {operator, shutdown, delete, stale, crash}`.

## Out of scope, deliberately

Source-build and binary install channels (chat-ui, llumen — the descriptor slot exists, no
implementation), federation visibility of peer webapps, RSS accounting in memory pools, and any
reverse-proxy/subpath facade.
