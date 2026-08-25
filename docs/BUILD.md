# Building llama.cpp

The `build` domain drives CMake builds of the configured llama.cpp checkout and publishes the
resulting binaries into the path catalog.

Build consumes the canonical source-repository status. When llama.cpp is
missing it offers the same full-clone operation as Source Sync; while clone,
pull, or checkout is active, Pull, ref checkout, and Start job are disabled.
Source-operation phase, progress, live log, and cancellation remain visible on
the Build page without becoming part of the build-job log.

## Build trees live outside the checkout

Build output goes to `runtime/builds/` (`ARRIERO_BUILDS_DIR`), never into the llama.cpp source tree,
so a source build never dirties the checkout that argument-docs sync and the Build UI read.

`BuildSettings.buildDir` is the **base** directory. The runner builds each ref into
`buildDir/<slug(ref)>`, so different branches keep separate trees and do not overwrite each other's
binary. The stored `settings.json` build section carries only host-independent intent, so a config
tree shared through one git origin (`docs/CONFIG_GIT.md`) reproduces the same
`${ARRIERO_BUILDS_DIR}/<slug>/bin/<target>` layout on every host that builds the same ref. Two
knobs are physical-host facts and live in the machine-local `config/machine.json` instead:
`native` (`-march=native`) and `parallelJobs`. `getBuildSettings` composes both sources; the Build
form saves them transparently, and the boot normalizer moves legacy in-file values aside once.

## Ref selection

`BuildJobStart.gitRef` (per-run, optional) is checked out before building:

- `git-checkout` step, then `git pull --ff-only` for branches only (skipped for tags).
- `null` = build the current checkout; the slug is then the current branch.
- The ref must be a known local branch or tag (`listLlamaSourceRefs`, exposed at
  `GET /api/llama-source/refs`). Fetching other branches is out of scope — do it manually.

The Build UI ref selector also switches the working tree **immediately** via
`POST /api/llama-source/checkout` (`checkoutLlamaSourceRef`), so the Arguments source-diff reflects
the selection without a build. That checkout is refused on a dirty tree (the selector is disabled)
and while a build runs (409). The build itself is **not** blocked on a dirty tree.

## Generator and parallelism

The configure step auto-selects Ninja (`-G Ninja`) when `ninja` is on PATH
(`autoNinjaGeneratorArguments` in `build/plan.ts`, probing through `system/tool-probe.ts`) — but only
for a build tree that does not exist yet, is being cleaned this run, or was already generated with
Ninja. An existing tree keeps whatever generator its `CMakeCache.txt` records
(`cmakeCacheGeneratorState` in `build/cmake-cache.ts`), because CMake hard-fails on a generator
mismatch. An explicit generator always wins and suppresses the auto-selection: `-G` /
`-DCMAKE_GENERATOR` in extra CMake args, or a `CMAKE_GENERATOR` variable in the build environment.
The chosen generator is echoed into the job-log header, and the preflight swaps the `make`
prerequisite for `ninja` when the planned configure command targets Ninja.

Every `cmake --build` invocation gets an explicit `-j`: the configured `parallelJobs`, or
`availableParallelism()` when unset. Without it a Make-generated tree builds single-threaded —
`cmake --build` passes no parallelism flag to the native tool by default.

ccache needs nothing from arriero: llama.cpp's own CMake (`GGML_CCACHE`, default ON) picks it up
from PATH at configure time and caches compilations for any generator.

## UI rebuild and the npm registry

The optional `ui-install` step rebuilds the embedded web UI: it removes `tools/ui/dist`, then runs
`npm ci --include=dev && npm run build` in `tools/ui` (`uiInstallCommands` in `build/plan.ts`).

The step is skipped at runtime (`build/ui-install-skip.ts`, evaluated after `git-pull` so a pull
that touches the UI still rebuilds it) when all three hold: the `tools/ui` git tree hash
(`git rev-parse HEAD:tools/ui`) matches the hash recorded on the last successful `ui-install` for
this checkout, the working tree under `tools/ui` is clean (`git status --porcelain`; generated
`dist`/`node_modules`/PWA icons are gitignored upstream and do not dirty it), and
`tools/ui/dist/index.html` exists. The recorded hash lives in `data/ui-build-state.json` (machine
state, keyed by repo path, rebuildable); it is written only when the tree was clean at build time,
so a dirty rebuild never poisons the skip. Any doubt — hash unavailable, dirty tree, missing dist,
unreadable state file — falls back to a full rebuild. This turns the ~70 s unconditional UI
rebuild into a no-op on every build where `tools/ui` did not change.

When
the host-wide npm registry is configured, `npm ci` gets an explicit `--registry <url>` — the mirror
of the uv `--default-index` flag the Python environments use for their PyPI index.

The registry lives in the `registries` section of `settings.json` (`PackageRegistriesSettings` in
core, `GET`/`PUT /api/registries`, `settings/registries.ts`), deliberately **not** in
`BuildSettings`: it is a host-level source profile, and future npm-based builds of other
applications are expected to read the same setting. The Build page edits it next to the build
settings; the URL must be credential-free HTTP(S) (auth via `.npmrc`/env stays out of arriero
config, matching the PyPI index rule).

The registry is resolved once at job start and baked into the recorded `ui-install` step command;
the runner executes exactly that recorded command (`splitCommandChain`), so the job log and step
display always match what ran, and a settings change never affects a job already in flight.

## CUDA

The default `cuda` flag in `defaultSettings()` is auto-detected via `isCudaToolkitAvailable()`
(`build/cuda.ts`, which locates `nvcc` through the shared `system/tool-probe.ts` primitive) — off
when no CUDA toolkit is present.

Required host tooling is derived from the planned build steps and checked before anything runs; see
`docs/PREREQUISITES.md` § Build fail-fast.

## Publishing the binary

On a successful build the produced binary is auto-registered into the path catalog (kind `binary`)
named `<binary> (<ref> @ <latest reachable tag>)`, deduped by path
(`registerBuiltBinaryInCatalog`).

## Relocated build trees

A CMake build tree records the absolute build and source directories it was generated for, so moving
the installation (as the `llama-manager` → `arriero` rename did) makes every existing tree under
`runtime/builds/` unusable: CMake refuses to reconfigure it and the job dies before compiling
anything.

The runner detects this itself — `build/cmake-cache.ts` compares `CMAKE_CACHEFILE_DIR` /
`CMAKE_HOME_DIRECTORY` against the planned directories — and wipes the relocated tree right before
the `configure` step, through the same guarded `cleanBuildDirectory` path as an explicit clean.

A build-only job has no configure step to repair the tree, so it is refused up front with a message
pointing at Configure instead of failing mid-build.

## Default binary

`defaultBinaryPath()` (`arguments/catalog.ts`) picks the binary the New-instance modal pre-selects,
exposed at `GET /api/build/default-binary` as `{path, refId, exists}`. Preference order:
`runtime/builds/master/bin`, then the most-recent existing path-catalog binary, then in-memory build
jobs, then `build-reffdev`.

## Job state

Build jobs are tracked in memory with a recent-history cap; they are not persisted in the DB.
