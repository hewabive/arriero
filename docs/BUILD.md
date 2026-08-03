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
binary.

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
