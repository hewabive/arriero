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
| OpenSSL version probe       | `apps/api/src/prerequisites/openssl.ts`     |
| HTTPS usage predicate       | `apps/api/src/prerequisites/https-usage.ts` |
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
only when at least one environment spec exists, OpenSSL headers only when an
instance uses an argument that needs an HTTPS-capable binary.

`instanceArgsNeedHttps()` decides that last one from the instance arguments
alone (`-hf`/`-hfr`/`--hf-repo`, `-mu`/`--model-url`, `-dr`/`--docker-repo`,
the draft-repo aliases, `--ssl-key-file`/`--ssl-cert-file`). Model presets are
deliberately not parsed for it: a router that downloads from HuggingFace only
through its `.ini` sees `openssl-dev` as `recommended` rather than `required`,
which still lists it on the page and in the aggregated install command.

## Silent degradation

Most checks guard something that fails loudly. OpenSSL does not: `LLAMA_OPENSSL`
is ON by default, but when `find_package(OpenSSL)` comes up empty
`vendor/cpp-httplib/CMakeLists.txt` only emits a CMake *warning* and the build
finishes normally — producing a `llama-server` whose `CPPHTTPLIB_OPENSSL_SUPPORT`
is undefined. Nothing surfaces until much later:

| Symptom                                                   | Source                          |
| --------------------------------------------------------- | ------------------------------- |
| `-hf`, `--model-url`, `--docker-repo` die at model load    | `common/http.h`, `common/download.cpp` |
| `--ssl-key-file`/`--ssl-cert-file` serve plaintext instead | `tools/server/server-http.cpp`  |
| router mode cannot proxy to an https upstream              | `tools/server/server-models.cpp`|

Because the build succeeds, `openssl-dev` is intentionally **not** part of the
build fail-fast set — refusing to build for a node that only ever serves local
GGUF files would be wrong. The Prerequisites page is the surface that catches
it, and the check's note spells out that installing the package only takes
effect after a rebuild.

Presence alone is not enough either: cpp-httplib additionally compiles a version
probe and requires OpenSSL >= 3.0.0, so `openssl.ts` reads the version from
`pkg-config --modversion openssl`, falling back to the `OPENSSL_VERSION_STR` /
`OPENSSL_VERSION_TEXT` defines in `openssl/opensslv.h`. A version it cannot
determine is reported `unknown`, never `ok`.

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
generator and pkg-config whenever a `configure` step is present, plus `nvcc`
for CUDA builds. It deliberately omits `libcurl-dev` (llama.cpp replaced
libcurl with the vendored cpp-httplib and `LLAMA_CURL` is now a deprecated
no-op, so demanding it would refuse builds over a package they no longer need)
and `openssl-dev` (see **Silent degradation** above).
`assertBuildPrerequisites()` runs in
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
