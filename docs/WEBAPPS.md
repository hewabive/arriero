# Web apps

The `webapps` domain (`apps/api/src/webapps/`) installs, configures and supervises third-party chat
web UIs as managed child processes wired to this node's API proxy. A webapp is deliberately **not**
an instance: it draws no memory pools, takes no part in admission or scheduling, and never appears
in the proxy endpoint catalog — it is a *client* of the proxy, not an upstream. Supported kinds:
**Open WebUI** (a PyPI environment) and **Hugging Face Chat UI** (a Node source build of
`huggingface/chat-ui`).

## The adapter

`webappDescriptor(kind)` (`packages/core/src/webapp-descriptor.ts`) is the per-kind contract,
mirroring `engineDescriptor`: a `Record<WebappKind, WebappDescriptor>` whose exhaustiveness makes
the compiler point at every spot a new kind must fill in. A descriptor declares the environment
engine that hosts the kind (`environmentEngine` — create validation and the web environment pickers
derive the kind↔engine link from it rather than comparing the two id strings), default host/port,
the launch argv shape (always `--host`/`--port` flags — Chat UI's generated launcher translates
them into the `HOST`/`PORT` variables its server reads), the health-probe path, the config-render
id (implemented api-side in `webapps/render.ts`), the probe-noise log grammar (`logGrammar`,
`uvicorn` or `pino`, applied by the supervisor's filtered-log tail), whether the kind needs a
manager-issued session secret (`sessionSecret`), the env keys the renderer owns (`reservedEnvKeys`
— rejected in user `extraEnv` by a core schema refinement), the files or directories to back up
before a version switch, and an install footprint note surfaced by the create form.

## Installation rides the environments domain

Every webapp installation **is** an environment referenced through `envSpecId`
(`docs/ENVIRONMENTS.md`); both kinds set `catalogEngineKind: null`, so no path-catalog binary entry
is generated — instances can never select these environments, and deleting one referenced by a
webapp is refused. Version upgrades follow the engine culture: install the new version as a new
environment, repoint the webapp (refused while it runs), keep the old one for rollback. The two
kinds install through different provisioner channels:

- **Open WebUI — `uv` channel**: the pinned PyPI distribution in an immutable uv-managed venv,
  exactly like vLLM/SGLang.
- **Chat UI — `node-source` channel**: a git tag/branch of `huggingface/chat-ui` built from source
  with the host `git`/`npm` (probed on PATH) and run on the manager's own Node. Steps:
  shallow-clone the ref → `npm ci --ignore-scripts` (the husky `prepare` hook breaks a clean
  install) → **manifest patch**: move `mongodb-memory-server` from `devDependencies` to
  `dependencies` — SvelteKit's adapter-node inlines devDependencies into the server bundle, and the
  bundled copy of the embedded-MongoDB fallback crashes at runtime (`__dirname` is undefined in the
  chunk), while a runtime dependency stays external and works → `npm run build` (heap-capped) →
  `npm prune --omit=dev` → freeze the resolved commit hash into `freeze.txt` → finalize writes the
  `bin/chat-ui` launcher (shebang = the manager's Node binary, so the entrypoint path stays in the
  child's argv and pid adoption matches it) → validate the bundle and the patched manifest. The
  launcher maps the `--host`/`--port` flags onto `HOST`/`PORT` and then layers the checkout's own
  `.env` under the rendered environment (rendered values always win) — the built server never loads
  `.env` itself, upstream's Docker entrypoint does it externally, and some of those defaults have
  no code fallback (an empty `COOKIE_NAME` 500s every response that sets a cookie).
  Upstream refs older than the 2025 v2 rewrite (the `legacy` branch) are not supported — they lack
  model discovery.

## Definition and storage

`WebappConfigRecord` (core `webapp.ts`) is file-per-name portable config under
`data/config/webapps/<name>.json`, on the standard directory store (staged reload, 409 write
conflicts, quarantine — `docs/CONFIG_EDITING.md`). Identity = `name`, same charset and semantics as
instances; `kind` is immutable; `settings` is a kind-discriminated union (Open WebUI: `auth`,
`slim`, `defaultModels`, `extraEnv`; Chat UI: `extraEnv` only). Rename is refused while a run is
active and cascades to `webapp_runs`, the `.secrets.json` key and the data directory; changing
`envSpecId` is likewise refused while running. Secrets never live in the record: for kinds with
`sessionSecret` the app's stable session secret is `webapp:<name>` in `config/.secrets.json`,
created on first start (Chat UI needs none — its sessions are anonymous cookies).

## Config render: environment at spawn, no files

`webapps/render.ts` renders the child-process environment on **every start** — nothing is written
to disk, so there is no config file to drift. Both renderers pin determinism and wire the proxy
with the key of the linked request source.

**Open WebUI** (`ENABLE_PERSISTENT_CONFIG=False` makes env authoritative on each boot; admin-UI
edits do not survive a restart by design) gets `OPENAI_API_BASE_URL` → this manager's `/v1`,
identity (`DATA_DIR` under `runtime/webapps/<name>`, the session secret) and policy (`WEBUI_AUTH`,
the slim profile that keeps the embedded embedding/STT models off — they would otherwise be
downloaded and loaded into RAM on top of the ~1.1 GB idle RSS measured for 0.11.0 with the slim
profile on).

**Chat UI** gets `OPENAI_BASE_URL`/`OPENAI_API_KEY` → the same `/v1`, `ENABLE_CONFIG_MANAGER=false`
(otherwise Mongo-stored admin edits override env), `COOKIE_SECURE=false` (upstream defaults the
session cookie to `Secure` in production, which browsers drop over the plain-HTTP LAN access
arriero serves — overridable through `extraEnv` behind a TLS front), and an embedded MongoDB kept
local:
`MONGO_STORAGE_PATH` → `runtime/webapps/<name>/db` (persistent WiredTiger files),
`MONGOMS_DOWNLOAD_DIR` → `.../mongodb-binaries` (the first start downloads an ~80 MB mongod, so it
is slow and needs network). Pointing `extraEnv.MONGODB_URL` at an external MongoDB disables the
embedded fallback entirely. Chat UI has **no built-in sign-in** (OpenID env would go through
`extraEnv`), so preflight warns whenever it listens on a wildcard host. `APP_BASE` is build-time in
SvelteKit — a Chat UI webapp always lives on its own port, never under a subpath.

In both kinds the model list is never rendered — the app discovers it from the proxy's
`/v1/models`, so federation reach comes for free. Chat UI reads that list **once per process** (at
the first request); preflight warns when the proxy catalog is empty, and models added later need a
webapp restart to appear.

## Supervision

`webapps/supervisor.ts` is a thin facade over `process/supervised-child.ts` — the child-lifecycle
kernel both it and the instance supervisor run on: detached spawn with its own pgid, stdout/stderr
straight to a raw-log fd, `RawLogTail` building the filtered log (probe-noise grammar from the
descriptor), SIGTERM → SIGKILL stop escalation against the process group. Children survive manager restarts; `webapps/reconcile.ts` re-adopts open `webapp_runs` rows
by pid + `/proc/<pid>/cmdline` match against the launch snapshot, defers quarantined definitions,
and marks unmatched live pids `stale` (`webapps/stale.ts` stops those). `ARRIERO_STOP_MANAGED_ON_EXIT`
applies to webapps too. After reconcile, boot starts every `autostart: true` webapp that has no
live run — the one supervision behaviour instances do not have, because nothing else would ever
wake a webapp.

The launch snapshot (`webapps/launch.ts`) stores argv, cwd, `envSpecId` and a **hash** of the
rendered environment — never the values, which contain secrets. Drift between the stored snapshot
and a re-render of the current record surfaces as `configDrift` on the served `Webapp`. When the
snapshot's `envSpecId` differs from the record's at start, the descriptor's `upgradeBackupFiles`
(files or directories — `webui.db` for Open WebUI, the `db` MongoDB directory for Chat UI) are
copied aside (`<name>.bak-<oldEnv>`) before the new version boots — automatic insurance against
upstream DB migrations.

## Proxy wiring

Creating a webapp offers (default on) creating an API-proxy **request source** named after it: the
generated key lands in `.secrets.json`, the renderer hands it to the app, and from then on the
chat's traffic is labeled in traces and stats, can be blocked by disabling the source, and keeps
working under `allowAnonymous: false`. Deleting the webapp offers deleting the source. Start
preflight (`webapps/preflight.ts`) errors on a missing/uninstalled environment or a host:port that
cannot be bound (the same bind probe instance preflight uses) and warns when the app listens on a
wildcard host without sign-in, plus the Chat UI empty-catalog warning above.

## Surfaces

`/api/webapps*` (CRUD, start/stop/restart, runtime + live health probe, preflight, log tail) and
the web **Web apps** page (create form with a kind switch and inline environment install —
PyPI-version picker for Open WebUI, git-ref input for Chat UI — status/env/drift badges, Open link,
logs). Runs live in the `webapp_runs` table (`docs/RUNTIME_LAYOUT.md`), last 20 closed per webapp,
`stopReason ⊂ {operator, shutdown, delete, stale, crash}`.

## Out of scope, deliberately

A binary install channel (llumen, later Caddy), federation visibility of peer webapps, RSS
accounting in memory pools, and any reverse-proxy/subpath facade.
