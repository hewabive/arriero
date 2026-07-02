# Self-update (UI "Update" button)

`llama-manager` can update itself from the web UI: pull the latest revision,
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
  requests get up to `LLAMA_MANAGER_UPDATE_DRAIN_TIMEOUT_MS` to finish —
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

Installs `deploy/llama-manager.service` as a `systemd --user` unit with resolved
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
- `GET  /api/update/latest`, `GET /api/update/jobs/:id`, `…/logs`, `POST …/cancel`.

## Fleet view

The Manager Updates page is a **Network page** (ignores the node switcher). It
shows one card per node — self plus every registered peer — and the latest
remote commit at the top.

- The remote state is fetched **once, on the entry node** (`/api/update/check`,
  run automatically on page load, then on demand). Peers never fetch; their
  `/api/version` just reports their own HEAD, and the entry node compares each
  HEAD to the cached upstream to derive `outdated`/`behindCount`.
- A card shows its commit + date only when the node is **behind**; an up-to-date
  node shows just a marker. Per-card **Update** is enabled only when the node is
  `outdated && canUpdate && !dirty`.
- **Update all** updates every eligible node **peers first, entry node last**
  (restarting the entry node severs the UI and the reverse proxy to peers); the
  fleet view then polls until each node returns on the new commit. Dev / dirty /
  unreachable nodes are shown as such and skipped.

This rides on the F0 reverse-proxy transport; deeper remote control (logs,
lifecycle parity) is the F1 federation layer.

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
`repository.ts`, `logs.ts`, `version.test.ts`, `utils/log-tail.ts` — keep them
free of repo-specific imports (only `./adapter.js`, node builtins, and
`../utils/log-tail.js`). Repo-specific here: `fleet.ts` (multi-node
aggregation + the `currentUpstream`/`commitsBehind` git helpers), the routes,
and the fleet UI. The `App*`/`UpdateJob*` Zod schema block in `packages/core`
is part of the contract — keep field names and enum values identical across
repos.
