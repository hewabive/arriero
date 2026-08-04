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
| Display-class PCI inventory | `apps/api/src/system/pci-inventory.ts`      |
| OpenSSL version probe       | `apps/api/src/prerequisites/openssl.ts`     |
| HTTPS usage predicate       | `apps/api/src/prerequisites/https-usage.ts` |
| Report assembly             | `apps/api/src/prerequisites/report.ts`      |
| Install-command aggregation | `apps/api/src/prerequisites/install-plan.ts`|
| Elevation capability probe  | `apps/api/src/prerequisites/install-capability.ts` |
| UI install runner           | `apps/api/src/prerequisites/install-runner.ts` |
| Reboot-required state       | `apps/api/src/prerequisites/reboot-state.ts` |
| Build fail-fast             | `apps/api/src/build/preflight.ts`           |
| Routes                      | `GET /api/prerequisites`, `POST …/install`, `GET …/install/latest` |
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

Per-item commands may also be resolved from `/etc/os-release` when a generic
package name would be unsafe. The NVIDIA driver check is applicable only when a
display-class NVIDIA PCI device is visible through sysfs, or NVML itself already
exposes a GPU. Directly reading `/sys/bus/pci/devices/*/{vendor,class}` avoids a
dependency on the driver, NVML, `nvidia-smi`, `lspci`, or the PCI names database.
Vendor `0x10de` plus PCI base class `0x03` includes VGA and compute-only 3D
controllers while excluding the HDMI audio function commonly paired with a GPU.
An unreadable PCI inventory is `unknown`, never an authoritative CPU-only result.
If neither PCI nor NVML exposes NVIDIA hardware and CUDA builds are disabled, the
whole NVIDIA group is omitted instead of advertising irrelevant recommended
packages on a CPU node.

The ROCm device check follows the same rule with the AMD vendor id `0x1002`: it
is shown only when a display-class AMD PCI device is visible through sysfs, or
`/dev/kfd` already exists — the latter keeps the check visible in a container
that exposes the device without a readable PCI inventory, mirroring the NVML
fallback for NVIDIA.

When PCI sees a GPU but NVML reports that the library or driver is unavailable,
the driver is a **required** host prerequisite. Ubuntu's changing driver branch
numbers make a static package name unsafe, so the check exposes
`sudo ubuntu-drivers install --gpgpu` as its own runnable command. A second
`sudo reboot` row is deliberately manual and never sent to the runner. The
hardware-aware Ubuntu tool selects a compatible headless/server driver and its
NVML runtime; arriero does not pin a branch that will become stale or offer the
Ubuntu command on other distributions. The command does not have to install
`nvidia-utils` or `nvidia-smi` because arriero calls `libnvidia-ml.so.1`
directly. NVML permission, lost-GPU and generic runtime errors remain diagnostic
instead of triggering a blind reinstall. A GPU bound to `vfio-pci` is also
diagnostic-only because it may be intentionally reserved for passthrough.

The same rule keeps `cuda-toolkit` out of the aggregated DNF command. It is an
NVIDIA package, not a package in the default Fedora or RHEL-family repositories;
including it before NVIDIA's repository is configured makes DNF reject the
whole transaction, including otherwise available tools. On supported x86-64
Fedora, RHEL, AlmaLinux, Rocky Linux and Oracle Linux hosts, the `nvcc` check
instead shows and can run a server-generated command that adds the matching
NVIDIA network repository, expires DNF metadata and installs `cuda-toolkit`.

Rocky Linux 9 on x86-64 uses NVIDIA's equivalent hardware-aware helper. Its
remediation enables Rocky's CRB and EPEL dependencies, installs matching kernel
development files, adds NVIDIA's `rhel9/x86_64` network repository, and installs
`nvidia-driver-assistant`. Running the assistant with `--install` selects the
module flavor supported by the detected GPU instead of arriero assuming that
every NVIDIA device can use the open kernel module. Those setup steps form one
`&&`-joined runnable row; `sudo reboot` remains a separate manual row.

On Ubuntu 24.04 the install may repeat
`udevadm hwdb is deprecated. Use systemd-hwdb instead.` while packages are
configured. This warning comes from the current `ubuntu-drivers` integration
and is non-fatal when the command exits successfully. Do not hide it: confirm
that package configuration completed, reboot, then press **Re-check**. The
upstream warning is tracked in
[ubuntu-drivers-common issue 94](https://github.com/canonical/ubuntu-drivers-common/issues/94).

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

`augmentProcessPath()` runs at startup and before each prerequisites report. It
**appends** every well-known tool directory that exists but is missing from PATH
(`~/.local/bin`, `/usr/local/bin`, nvm's `node/*/bin`,
`/usr/local/cuda/bin`, …). Re-check therefore picks up a toolkit installed while
arriero is running without requiring a service restart. Appending, not
prepending: existing PATH entries keep winning, so nothing the operator chose
is ever shadowed. The change is in-memory only and never persisted, keeping
file-backed config machine-independent. The directories added across all
repairs are reported in `host.autoRepairedPath`; startup additions are also
logged.

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

## Package installation from the UI

By default the page shows commands and never runs them: the manager is an
ordinary user and admin auth is off by default, so an unconditional install
endpoint would be a privilege escalation. Run buttons appear only when the
manager can already elevate **non-interactively** — root, or `sudo -n true`
succeeds — probed per report into `installRunner` (`install-capability.ts`).
Then the boundary is already gone (the admin surface can spawn arbitrary
binaries as instances), so the button adds convenience, not privilege.

Runner rules (`install-runner.ts`):

- `POST /api/prerequisites/install` takes `{ scope: "required" | "all" }` or
  `{ checkId }`; the command is re-derived server-side
  (`resolveInstallCommand`) — clients never submit command text.
- Package-manager commands and explicitly allowlisted, server-generated install
  sequences are runnable. The DNF `nvcc` remediation is one such sequence;
  the Ubuntu/Rocky NVIDIA driver setup is another. Driver setup is intentionally
  excluded from the aggregated required/recommended command and is runnable only
  from its own check. Its separate `sudo reboot` command, the delegation script
  and `pipx install uv` stay copy-paste.
- One run at a time, in memory only (log tail 256 KiB), exposed at
  `GET /api/prerequisites/install/latest` and polled while running.
  `DEBIAN_FRONTEND=noninteractive`; under root the `sudo` prefix is stripped.
  On finish the page re-fetches the report.
- A successful per-item install whose definition requires reboot writes its
  check id, timestamp and current `/proc/sys/kernel/random/boot_id` to
  `data/prerequisite-reboot-state.json`. While that boot id is current the play
  action is suppressed and the check shows **Server reboot required**. A manager
  restart preserves the marker; a real host reboot changes the boot id, clears
  it and makes the live probe authoritative again. Failed commands never create
  a marker.

## Caches

`GET /api/prerequisites` resets the permanently cached `uvToolStatus()` and
NUMA interleave probes first, so the report cannot claim a tool is missing
after the administrator has just installed it. All other probes are executed
per request and are asynchronous, so a slow `--version` never blocks the proxy
event loop.
