# Environment prerequisites

Host tooling this node needs in order to build inference engines and launch
instances, why each piece matters, and the exact command an administrator runs
to install it. The goal is a single copy-paste command when bringing up a new
machine, and a refusal to start long operations that are already doomed.

## Layout

| Concern                     | File                                        |
| --------------------------- | ------------------------------------------- |
| Probe primitive             | `apps/api/src/system/tool-probe.ts`         |
| Distro / package manager    | `apps/api/src/system/os-release.ts`         |
| Startup PATH repair         | `apps/api/src/system/path-repair.ts`        |
| Directories searched        | `apps/api/src/prerequisites/search-paths.ts`|
| Check registry              | `apps/api/src/prerequisites/registry.ts`    |
| Report assembly             | `apps/api/src/prerequisites/report.ts`      |
| Install-command aggregation | `apps/api/src/prerequisites/install-plan.ts`|
| Build fail-fast             | `apps/api/src/build/preflight.ts`           |
| Route                       | `GET /api/prerequisites`                    |
| Page                        | `#/prerequisites`                           |

`tool-probe.ts` is the single PATH-lookup implementation; `build/cuda.ts`
(`findNvcc`) and `envs/uv.ts` (`findUv`) are consumers, not copies.

## What belongs in the registry

A check is added **only after something actually blocked a deployment** — a
build that died, an instance that could not start, an environment that would
not install. The registry is not a general-purpose Linux audit: if its absence
does not break an operation this manager performs, it does not belong here.
Extend the registry when a new blocker is found in the field.

## Status model

| Status        | Meaning                                                              |
| ------------- | -------------------------------------------------------------------- |
| `ok`          | Present and visible to the manager process                           |
| `out-of-path` | Found on disk in a well-known directory, absent from the process PATH |
| `missing`     | Not found                                                            |
| `unknown`     | Cannot be verified (the probe's own dependency is unavailable)        |

`missing` **and** `unknown` both feed the aggregated install command —
package installs are idempotent, so an unverifiable requirement is included
rather than risking a second round trip for the administrator.

Severity is `required` or `recommended`, resolved per report against what this
node is actually configured to use, not statically: `nvcc` is required only
when `build.cuda` is on, `numactl` only when an instance declares
`numa.mode:"interleave"`, cpuset delegation only for `numa.mode:"bind"`, `uv`
only when at least one environment spec exists.

## PATH is the manager's, not the shell's

Every probe resolves against the PATH of the manager process, because that is
what spawned builds and supervised children actually see. A `systemd --user`
unit has a far shorter PATH than an interactive shell — the classic failure is
a Node.js installed through nvm that works in the terminal and is invisible to
the service.

`augmentProcessPath()` runs once at startup and **appends** every well-known
tool directory that exists but is missing from PATH (`~/.local/bin`,
`/usr/local/bin`, nvm's `node/*/bin`, `/usr/local/cuda/bin`, …). Appending, not
prepending: existing PATH entries keep winning, so nothing the operator chose
is ever shadowed. The change is in-memory only and never persisted, keeping
file-backed config machine-independent. The directories that were added are
reported in `host.autoRepairedPath` and logged at startup.

## Build fail-fast

`buildPrerequisiteIds()` derives the required tool ids from the planned build
steps rather than from a parallel hand-maintained list: `command[0]` of each
step maps to a check id (`git`, `npm`/`node`, `cmake`), plus the compiler,
generator, pkg-config and libcurl headers whenever a `configure` step is
present, plus `nvcc` for CUDA builds. `assertBuildPrerequisites()` runs in
`buildRunner.start()` after `validateSettings()`, so a doomed build is rejected
with a 400 naming every missing tool and the install command — before the
source checkout, `npm ci` and the llama.cpp web UI build burn several minutes.
No job row and no log file are created for a refused build.

## No package installation from the UI

The page shows commands; it never runs them. Installing system packages needs
`sudo`, the manager runs as an ordinary user (`systemd --user`), and admin auth
is **off by default** — a package-install endpoint would be a privilege
escalation reachable by anything that can talk to the port. PATH repair is the
only remediation the manager performs itself, and it needs no elevation.

## Caches

`GET /api/prerequisites` resets the permanently cached `uvToolStatus()` and
NUMA interleave probes first, so the report cannot claim a tool is missing
after the administrator has just installed it. All other probes are executed
per request and are asynchronous, so a slow `--version` never blocks the proxy
event loop.
