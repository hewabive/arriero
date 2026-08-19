# Self-update (UI "Update" button)

`arriero` can update itself from the web UI: pull the latest revision,
reinstall, rebuild, and restart — without a shell. This is the per-node
foundation for fleet-wide updates across the node architecture (see
`docs/FEDERATION.md`).

## What it does

The `update` domain (`apps/api/src/update/`) runs the same steps as the
`update:run` script, as a tracked job with step-by-step progress and live logs
(modeled on the `build` domain):

```
snapshot → git-pull (--ff-only) → install (pnpm install) → build (pnpm build) → restart
```

- **snapshot** records the current commit so a failed step can roll back
  (`git reset --hard <commit>`); the node is never left on a half-built tree.
- **restart** is reached only on a clean build. It first drains the proxy
  (new public requests get 503 + `Retry-After`, and non-resumable in-flight
  requests get up to `ARRIERO_UPDATE_DRAIN_TIMEOUT_MS` to finish —
  see `docs/STREAM_RESUME.md` for how resumable generations survive the
  restart), then self-`SIGTERM`s the process, reusing the normal graceful
  shutdown (the HTTP server closes; managed `llama-server` children are
  **not** stopped). The supervisor brings the process back up on the freshly
  built `dist/`.

The job exposes `willRestart`; the UI watches the `restart` step (and the
dropped connection), then polls `GET /api/version` until the commit changes and
the node is back — showing "restarting…" then "updated to `<short-sha>`".

## Run-mode requirement

Self-restart needs an external supervisor, because a process cannot rebuild its
own running code and re-exec cleanly. The endpoint detects the run mode and
**refuses outside the supervised `serve` deployment**:

| Run mode | `mode` | `canUpdate` | Behaviour |
| --- | --- | --- | --- |
| `pnpm dev` (tsx watch + vite) | `dev` | `false` | Refused. tsx/vite already hot-reload; `git pull` by hand (rebuild `core` if it changed). A `git pull` mid-job would race tsx watch. |
| `node dist/index.js` under systemd | `serve` | `true`, `supervised` | Full self-update incl. auto-restart. |
| `node dist/index.js` without a supervisor | `serve` | `true`, not `supervised` | Updates + builds, but does **not** auto-restart; restart manually. |

Detection: `serve` when the entrypoint is `…/dist/index.js`, `dev` when it is a
`.ts` file (tsx). `supervised` is `process.env.INVOCATION_ID` (set by systemd).
A dirty working tree blocks the update up front (`git pull --ff-only` would
fail) and is surfaced in the UI.

## Install the supervisor

```bash
./scripts/install-service.sh
```

Installs `deploy/arriero.service` as a `systemd --user` unit with resolved
absolute paths and a `PATH` that lets the update job find `node`/`pnpm`/`git`.
The script needs **no sudo** (it refuses to run as root and writes only under
`~/.config/systemd/user/`). The one step that can need privilege is enabling
linger (so the node runs without an active login session) — it writes a
root-owned file, so on a headless host run `sudo loginctl enable-linger $USER`
once; the script skips this when linger is already on and prints that command if
it can't enable it unprivileged.

Two unit settings are load-bearing:

- **`Restart=always`** — the self-`SIGTERM` exits 0; the unit must restart on a
  clean exit, not only on failure.
- **`KillMode=process`** — on restart systemd kills only the main process, so
  the detached managed `llama-server` children survive and are re-adopted by
  `process/reconcile.ts` on the next start (matching the app's default
  survive-restart behaviour). The default `control-group` would kill them.

To undo the installation, `./scripts/uninstall-service.sh` stops and disables
the unit and removes the generated unit file. Linger is left enabled (other
`--user` services may depend on it); pass `--disable-linger` to turn it off
too. Stopping the unit follows the manager's default shutdown behaviour:
detached managed `llama-server` children keep running and are re-adopted the
next time the manager starts.

## API

The per-job routes are node-scoped, so the entry node drives a peer through the
reverse proxy (`/api/nodes/<id>/update`). The `/fleet` aggregation runs on the
entry node only.

- `GET  /api/version` — version + run mode + cached update-availability (cheap, offline-safe).
- `POST /api/update/check` — `git fetch` then report commits behind upstream. **Only the entry node fetches.**
- `GET  /api/update/fleet` — aggregate: cached `upstream` + every node's `/api/version`, with per-node `outdated`/`behindCount` computed on the entry node.
- `POST /api/update` — start an update job (`{ restart }`).
- `POST /api/update/restart` — restart without updating: the same drain +
  self-`SIGTERM` the update job ends with, but with no pipeline in front (env
  changes in `.env` are re-read on boot). Refused with 409 when the process is
  not `supervised` (nothing would bring it back) or while an update job runs
  (that job restarts on its own). Responds `202 { restarting, startedAt }`
  before the drain begins; the logic lives in `update/restart.ts`, deliberately
  outside the byte-identical update kit.
- `GET  /api/update/latest`, `GET /api/update/jobs/:id`, `…/logs`, `POST …/cancel`.

`GET /api/version` also reports `startedAt` — the ISO time this process booted
(stamped at route level by `update/restart.ts:withRuntimeInfo`, so the kit's
`getAppVersion()` stays untouched; peers on older builds default to `null`).
The Nodes page uses it as the restart confirmation signal: after
`POST …/restart` it polls the node's `/api/version` until `startedAt` changes.

## Manual pull/build skew detection (build stamp)

The update pipeline is not the only way the checkout can move: an operator can
`git pull` and/or `pnpm build` by hand while the prod process keeps running old
code. `getAppVersion()` reads the **checkout's** HEAD, so on its own the domain
cannot see that skew — after a manual pull it reports the new commit and "up to
date" while the process still runs the old build, and after a pull *without* a
build even a restart would boot the stale `dist`.

The build stamp closes this. The api build ends with
`scripts/write-build-info.mjs`, which records the built commit into
`apps/api/dist/build-info.json`. `update/build-info.ts` (repo-specific, not
part of the shared kit) reads the stamp twice — once at process start (the
commit the running code was built from) and again on each version read (the
commit currently on disk) — and `withRuntimeInfo` derives two `AppVersion`
flags:

- `buildPending` — checkout HEAD ≠ stamped dist commit: someone pulled without
  building. An update run heals it (its `git pull --ff-only` no-ops, then
  install → build → restart apply everything).
- `restartPending` — stamped dist commit ≠ the commit loaded at process start:
  a newer build sits on disk; plain **Restart** applies it.

Both flags (and `builtCommit`/`runningCommit`) are `null` — unknown, never a
fake `false` — when no stamp exists: dev mode, tests, or a dist built before
stamping. The Nodes page shows `build pending` / `restart pending` badges,
enables **Update** for a `buildPending` node even at `behindCount` 0, and
suppresses the teal "up to date" marker; the dashboard attention card surfaces
the same state when no regular update is available.

## Fleet view

The fleet update surface lives on the **Nodes** page (`#/nodes`, a **Network
page** — ignores the node switcher; `#/update` is a legacy alias), merged with
the peer registry: one card per node — self plus every registered peer — carries
both registry controls (edit/remove, reachability from the same
`/api/update/fleet` fan-out) and update state, with the latest remote commit at
the top.

- The remote state is fetched **once, on the entry node** (`/api/update/check`,
  run automatically when the page opens and the cached check is older than
  15 minutes, then on demand). Peers never fetch; their
  `/api/version` just reports their own HEAD, and the entry node compares each
  HEAD to the cached upstream to derive `outdated`/`behindCount`.
- A card shows its commit + date only when the node is **behind**; an up-to-date
  node shows just a marker. Per-card **Update** is enabled only when the node is
  `(outdated || buildPending) && canUpdate && !dirty`.
- Per-card **Restart** (supervised, reachable nodes only) hits
  `POST /api/update/restart` and shows "restarting…" until the node's
  `/api/version` comes back with a new `startedAt` (2-minute confirmation
  timeout). It exists for changes an update cannot deliver — edited `.env`,
  a wedged manager — and drains the proxy exactly like the update restart.
- **Update all** updates every eligible node **peers first, entry node last**
  (restarting the entry node severs the UI and the reverse proxy to peers); the
  fleet view then polls until each node returns on the new commit. Dev / dirty /
  unreachable nodes are shown as such and skipped.

This rides on the F0 reverse-proxy transport; deeper remote control (logs,
lifecycle parity) is the F1 federation layer.

## Browser-cache freshness after an update

Three layers keep the managing browser off a stale bundle after a restart:

- **Static cache headers** (`http.ts`): a wrapper middleware around the
  `web/dist` static mount stamps `Cache-Control` on every static response —
  `no-cache` for `index.html` (direct hits and the SPA deep-link fallback), so
  the browser revalidates the entry document on every navigation, and
  `public, max-age=31536000, immutable` for `/assets/*`, which are content-
  hashed by Vite and safe to cache forever. API namespaces (`/api/`, `/v1`,
  `/proxy/`) are never stamped.
- **Auto hard-reload of the updating tab** (`NodesView`): when the self node's
  update job applies (fleet reports the new commit after restart), the tab
  re-fetches its own document with `cache: "reload"` (bypasses and refreshes
  the HTTP cache — `location.reload(true)` is deprecated) and then reloads
  (`ui/utils/reload.ts:forceReloadUi`).
- **Version-mismatch watchdog** (`ui/use-ui-version-guard.tsx`): the build
  embeds the git commit into the bundle (`__ARRIERO_UI_COMMIT__`, Vite
  `define`); a long-lived tab compares it against `/api/version` — preferring
  `builtCommit` over checkout HEAD, so a pull without a build never prompts a
  reload into an unchanged bundle — on window
  focus and every 10 minutes (throttled to one check per minute) and shows a
  one-shot reload notification on mismatch. Disabled in dev (Vite serves live
  sources; the config-load-time commit would go stale mid-session). The prompt
  is remembered per `(ui commit, server commit)` pair in `sessionStorage`, so
  an unsupervised `serve` node whose dist was rebuilt but whose process was not
  restarted (persistent mismatch) prompts once, not on every focus.

## Shared kit contract

The update domain doubles as a **copyable kit** shared with the sibling repos
(`llm-arena`, `rag-manager`; the canonical contract text lives in
`llm-arena/docs/self-update.md`). The seam is `apps/api/src/update/adapter.ts`
— the only repo-specific file among the core modules: it re-exports the update
schemas/types from the repo's own `core` package and provides
`updateAdapter = { appName, rootDir, logsDir, newJobId(), beforeRestart() }`.
Here `beforeRestart` performs the proxy drain (503 + bounded wait for
non-resumable in-flight requests) before the self-`SIGTERM`.

Copy-identical across the three repos: `version.ts`, `runner.ts`,
`repository.ts`, `logs.ts`, `version.test.ts`, `runner.test.ts`,
`utils/log-tail.ts`, plus the whole `jobs/` background-job kernel
(`docs/BACKGROUND_JOBS.md`) that the update runner is built on — keep them
free of repo-specific imports (only `./adapter.js`, node builtins,
`../jobs/*.js`, and `../utils/log-tail.js`; the `jobs/` files import nothing
repo-specific at all). `scripts/check-update-kit.mjs` verifies byte-identity
against sibling checkouts and silently skips absent ones. Repo-specific here:
`fleet.ts` (multi-node aggregation + the `currentUpstream`/`commitsBehind` git
helpers), the routes, and the fleet UI. The `App*`/`UpdateJob*` Zod schema
block in `packages/core` is part of the contract — keep field names and enum
values identical across repos.
