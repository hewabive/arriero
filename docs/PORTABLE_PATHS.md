# Portable paths in file-backed config

Moving or renaming the application directory used to invalidate the whole
configuration: instance binaries, the path catalog, the build directory and the
model scan root were all stored as absolute paths, even when they pointed inside
the application directory itself.

File-backed config therefore stores such paths as **root placeholders**. A value
that lives under a managed root is written as `${ARRIERO_*}/rest/of/path` and
expanded back to an absolute path when the store reads the file. Nothing
downstream sees a placeholder — repositories, the supervisor, the HTTP API and
the web UI keep working with absolute paths.

## Root vocabulary

| Placeholder | `config` field | Env override |
| --- | --- | --- |
| `${ARRIERO_HOME}` | `rootDir` | `ARRIERO_HOME` |
| `${ARRIERO_DATA_DIR}` | `dataDir` | `ARRIERO_DATA_DIR` |
| `${ARRIERO_CONFIG_DIR}` | `configDir` | `ARRIERO_CONFIG_DIR` |
| `${ARRIERO_RUNTIME_DIR}` | `runtimeDir` | `ARRIERO_RUNTIME_DIR` |
| `${ARRIERO_LOGS_DIR}` | `logsDir` | `ARRIERO_LOGS_DIR` |
| `${ARRIERO_BUILDS_DIR}` | `buildsDir` | `ARRIERO_BUILDS_DIR` |
| `${ARRIERO_SOURCES_DIR}` | `sourcesDir` | `ARRIERO_SOURCES_DIR` |
| `${ARRIERO_ENVS_DIR}` | `envsDir` | `ARRIERO_ENVS_DIR` |
| `${ARRIERO_MODELS_DIR}` | `modelsDir` | `ARRIERO_MODELS_DIR` |
| `${ARRIERO_SLOTS_DIR}` | `slotsDir` | `ARRIERO_SLOTS_DIR` |

Selection rule (`apps/api/src/config-paths.ts`): among the roots that contain the
path, the **narrowest** one wins — a model file serializes as
`${ARRIERO_MODELS_DIR}/…`, a built binary as `${ARRIERO_BUILDS_DIR}/…`, never as
their `${ARRIERO_HOME}/runtime/…` spelling. Every root is independently
overridable, and the defaults nest under the application directory, so the
narrow placeholder expands correctly both on a host that only sets
`ARRIERO_HOME` and on a host that relocates that one root
(`ARRIERO_MODELS_DIR=/mnt/models` — the case a broad placeholder silently
ignores). Ties keep declaration order. A path under no managed root —
`/mnt/nvme/gguf/…`, a system binary — stays absolute verbatim, because it does
not move with the application.

Placeholders are expanded anywhere inside a value, so hand-written entries such
as `LD_LIBRARY_PATH=${ARRIERO_HOME}/lib:/usr/lib` work. Writing only ever
produces a placeholder at the start of a value. Unknown `${…}` text is left
untouched.

## Coverage

Placeholders are applied to every string leaf of these files, at the store's
read/write boundary:

| File | Store | Path-bearing values |
| --- | --- | --- |
| `config/instances/<name>.json` | `instances/config-files.ts` | `binaryPath`, `cwd`, `args` values, `env` values, `positionalArgs`, `engineConfig.model` / `.cpuWeights` |
| `config/path-catalog.json` | `path-catalog/repository.ts` | `path` |
| `config/settings.json` | `settings/store.ts` | `build.buildDir`, `build.env` values, `modelScan.directory`, external `sourceRepositories[].location.path` |
| `config/argument-defaults.json` | `arguments/defaults-repository.ts` | default argument values |

Mapping whole documents rather than named fields is deliberate: a new
path-carrying field is covered the day it is added, and a non-path value can
never match a root prefix by accident.

Deliberately **not** covered:

- `config/presets/*.ini` — `llama-server` owns and rewrites the same file and
  does not understand placeholders; preset model paths stay absolute.
- `config/proxy/*.json`, `config/envs.json`, `config/nodes.json`,
  `config/resources.json` — they carry URLs, ids and free-form user text
  (pipeline patterns, prompts), not filesystem paths. Rewriting free-form text
  is the one way a placeholder could corrupt data.
- `data/arriero.db` and the rest of `data/` / `runtime/` — runtime state and
  rebuildable caches keyed by absolute path (argument catalogs, model cache,
  launch snapshots). A move invalidates them and they refill on the next scan.

## Startup normalization

`normalizeConfigFiles()` (`apps/api/src/config-normalize.ts`) runs once per boot
from `apps/api/src/index.ts`: it scans the files above for absolute paths under
a managed root and for leading placeholders that are no longer canonical under
the selection rule (`${ARRIERO_HOME}/runtime/models/…` written before the
narrowest-root rule) — and every tracked config file for legacy
`createdAt`/`updatedAt` keys — and, for each stale file, re-reads it through its
store (Zod-validated) and writes it back through the same store. Only values
that consist of one leading placeholder are canonicalized; a placeholder in the
middle of a value (`LD_LIBRARY_PATH=${ARRIERO_HOME}/lib:/usr/lib`) or several
placeholders in one value are left untouched, because the write path can only
produce a placeholder at the start of a value. Files without
a stale marker are not touched, so the config Git tree stays clean. The
rewritten file names land in the startup log as `normalizedConfigFiles`.
The same pass also runs after every successful `POST /api/config/reload`
(`docs/CONFIG_EDITING.md`), so hand-written absolute paths are placeholder-ized
at apply time, not only at the next boot.

This is deliberately **not** a registry migration (`docs/MIGRATIONS.md`).
Migrations are one-shot and removable — their legacy marker never comes back
once applied. An absolute path can: hand-editing a config file, or restoring one
from a backup, reintroduces it. So the pass is standing housekeeping, in the
same class as `refreshAutoCapacities()` or `sweepSourceCloneStaging()`, and both
forms stay readable forever — expansion is a no-op on an absolute path.

It is not wired into `reloadPortableConfigCaches()` (config Git init/clone/pull).
Absolute paths in a config tree cloned from another machine point at *that*
machine's layout, so they sit under no local managed root and normalization has
nothing to rewrite — it would only dirty the freshly cloned worktree.

## Renaming the application directory

Convert first, then move:

1. Start the manager once on a build that includes this normalization pass — the
   config files now hold placeholders.
2. Stop the manager, rename or move the directory.
3. Update whatever names the old location: the `systemd --user` unit from
   `scripts/install-service.sh`, `.env` (`ARRIERO_*` overrides), shell aliases.
4. Start the manager.

Managed child processes launched from the old location are not adopted after a
move — their `/proc/<pid>/cmdline` no longer matches the launch snapshot, so they
fall back to `stale` and have to be stopped and started again.

If the directory was moved *before* the pass ever ran, the stored absolute paths
point at the old location and nothing can recover the intent automatically; fix
them once by hand (or re-pick the binary in the UI) and the next restart turns
them into placeholders.

A config root managed through `docs/CONFIG_GIT.md` becomes portable across
machines the same way, as long as each machine keeps its own `ARRIERO_*`
overrides.

When a selection-rule change makes existing placeholders non-canonical, every
host's next boot rewrites the same files to the same content. On a shared
origin, commit that one-time rewrite from **one** host and pull it everywhere
else: two hosts committing the identical rewrite independently produce
diverged histories that the fast-forward-only pull refuses.
