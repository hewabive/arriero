# arriero

Local web control plane for `llama.cpp`, `llama-server`, vLLM, and
KTransformers (SGLang-KT).

Managed KTransformers support uses a strict Linux x86-64/NVIDIA profile,
matched immutable Python packages, explicit hybrid memory reservations, and an
idle-only scheduling default. See
[KTransformers operations](docs/KTRANSFORMERS_OPERATIONS.md) and the
[implementation record](docs/KTRANSFORMERS_SUPPORT.md). Codex continuation and
GPU-machine handoff state is recorded in
[docs/KTRANSFORMERS_HANDOFF.md](docs/KTRANSFORMERS_HANDOFF.md).

## Development

```bash
pnpm install
pnpm dev
```

Default services:

- API: `http://127.0.0.1:8787`
- Web UI: `http://127.0.0.1:5173`

## Production (serve) & self-update

For a real deployment, run the built app as a single process serving the UI, API
and proxy on one port:

```bash
pnpm serve            # build, then node apps/api/dist/index.js
```

To enable the **Update** button in the UI (pull → install → build → restart
without a shell), install the supervisor unit so the manager can self-restart:

```bash
./scripts/install-service.sh
```

This installs `deploy/arriero.service` as a `systemd --user` unit
(`Restart=always`, `KillMode=process` so managed `llama-server` children survive
the restart) and enables linger. The script needs no sudo; only enabling linger
may need a one-time `sudo loginctl enable-linger $USER` on a headless host (it
skips this when already on). The Updates page then shows this node's version and
a one-click update; it is per-node, so the global node switcher can update a peer
too. Update from the UI is refused in `pnpm dev` (tsx/vite already hot-reload —
`git pull` by hand instead). `./scripts/uninstall-service.sh` reverses the
installation (`--disable-linger` to also turn linger off). See
[docs/SELF_UPDATE.md](docs/SELF_UPDATE.md).

## Portable configuration repository

The portable settings root (`data/config` by default, overridden with
`ARRIERO_CONFIG_DIR`) can be managed as a standalone Git repository from
the **Configuration Git** page. On a new server, start arriero with a
local `.env` containing the admin password/hash and layout overrides, then use
the page to clone the configuration origin. Clone is validated in a staging
directory, the previous bootstrap directory is retained as a backup, and the
gitignored `.secrets.json` is preserved.

The page supports status, diff, history, fetch, fast-forward pull, branch
selection/creation, detached commit checkout, reset, commit, and push. Actions
that replace configuration files are refused while managed processes, a build,
or an environment install is active. See
[docs/CONFIG_GIT.md](docs/CONFIG_GIT.md) for the workflow and secret policy.

## Inference source repositories

On a fresh node, open **Source Sync** to clone llama.cpp into the managed
`runtime/sources/llama.cpp` checkout. The official origin is prefilled and can
be replaced with a fork before cloning; changing it later updates both portable
settings and the checkout's `origin` remote. Managed source storage can be moved
with `ARRIERO_SOURCES_DIR`.

Repository lifecycle is separate from integration drift checks, so a missing or
invalid checkout is reported as unavailable rather than in sync. Existing
legacy/custom llama.cpp paths remain usable as external checkouts. See
[docs/SOURCE_REPOSITORIES.md](docs/SOURCE_REPOSITORIES.md).

## Runtime logs

Managed `llama-server` launches write two log files:

- `runtime/logs/<instance>-<timestamp>.log`: filtered working log used by the app. Routine local GET/HEAD diagnostics such as `/health`, `/props`, `/slots` and `/v1/models` are omitted to keep agent-readable logs compact.
- `runtime/logs/<instance>-<timestamp>.raw.log`: full stdout/stderr stream with no filtering.

Set `ARRIERO_FILTER_PROBE_LOGS=false` to disable filtering of the working log.

## Shutdown

Pressing `Ctrl+C` in the `pnpm dev` terminal sends `SIGINT` to the API. The API closes its HTTP server and then gracefully stops supervised `llama-server` processes. If a child process does not exit before the shutdown timeout, it is force-killed.

Relevant environment variables:

- `ARRIERO_STOP_MANAGED_ON_EXIT=false`: leave supervised `llama-server` processes running when the API exits; they will be reconciled as stale on the next API start.
- `ARRIERO_SHUTDOWN_TIMEOUT_MS`: graceful stop timeout for managed processes, default `10000`.

## NUMA placement (multi-socket hosts)

On a host with more than one NUMA node, each instance can declare a NUMA policy
(form selector, shown only when >1 node). The Resources page shows the topology
and which GPU hangs off which node.

- **Bind** — confine an instance's CPUs and memory to one node (locality,
  co-tenancy isolation, GPU instances pinned to their card's node). Uses a cgroup
  v2 cpuset, so it needs a one-time `cpuset` delegation, applied as root:

  ```bash
  sudo scripts/setup-numa-cgroup-delegation.sh <user-that-runs-arriero>
  ```

  The script writes the `user@.service` `Delegate=cpu cpuset memory pids`
  drop-in, enables linger, and turns `cpuset` on live. Two caveats that bite on
  servers: under linger a plain **logout/login does not activate it** (restart
  `user@<uid>.service` or reboot if the script can't apply it live), and the
  **manager itself must run inside that user session** — one started from an SSH
  shell that lands in `system.slice` cannot pin. Run it as a `systemctl --user`
  service (or `systemd-run --user --scope`). Otherwise a binding is stored but
  not enforced.

- **Interleave** — spread an instance's memory evenly across nodes for full
  aggregate bandwidth (the fast, jitter-free mode for big CPU-resident models).
  Needs only `numactl` on `PATH` — no delegation, no cgroup. Pair it with
  `--numa distribute` in the instance arguments.

No per-node memory budgeting yet — fitting a node's RAM is up to you. See
[docs/NUMA_PINNING.md](docs/NUMA_PINNING.md).

## Public/admin mode

The default route is `/#/status`: a public, redacted diagnostics page. It shows aggregate instance state, RAM usage and sanitized instance names/statuses, but not paths, arguments, logs, PIDs or process details.

Admin routes remain open for local development unless a password is configured:

```bash
ARRIERO_ADMIN_PASSWORD='change-me' pnpm dev
```

Relevant API environment variables:

- `ARRIERO_ADMIN_PASSWORD`: enables admin login with a plain environment password.
- `ARRIERO_ADMIN_PASSWORD_HASH`: enables admin login with a `scrypt$...` password hash.
- `ARRIERO_AUTH_SECRET`: signs admin session cookies; defaults to the configured password/hash when omitted.
- `ARRIERO_SECURE_COOKIE=true`: mark the session cookie secure when served behind HTTPS.
- `ARRIERO_SESSION_TTL_SECONDS`: admin session lifetime, default `43200`.
