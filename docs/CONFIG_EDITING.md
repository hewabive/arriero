# Config editing contract

How file-backed configuration is read, changed and applied — for humans and for AI agents. The
mechanism lives in `apps/api/src/config-store/`; the git layer on top is `CONFIG_GIT.md`.

## The model: disk is staging, memory is the applied state

Every JSON config store (instances, all `proxy/*.json`, `settings.json`, `argument-defaults.json`,
`path-catalog.json`, `resources.json`, `nodes.json`, `envs.json`, `.secrets.json`) is backed by one
primitive — `config-store/file-store.ts` for single files, `config-store/directory-store.ts` for
`instances/*.json` — with uniform rules:

1. **Reads serve the applied (cached) state.** A broken file on disk never breaks request serving;
   the last valid state keeps answering.
2. **External edits are detected, not hot-applied.** Each store remembers the mtime it loaded from;
   `GET /api/config/state` reports per-file `dirtyOnDisk` and the Configuration page shows a yellow
   banner. Activation is explicit: `POST /api/config/reload`.
3. **Reload is validate-then-apply, all-or-nothing.** The reload endpoint re-reads the whole tree
   fresh from disk, runs full validation (per-file Zod + cross-file references, the same
   `validateConfigRoot` used by config-git operations), and only when every file passes swaps all
   store caches in one synchronous step, then re-normalizes portable paths. An invalid tree returns
   400 with per-file issues and changes nothing. 409 while a build / environment install / source
   operation runs. Running managed instances do not block a reload — it is equivalent to a batch of
   ordinary API edits, and config-drift detection covers live processes.
4. **Server writes are conflict-guarded.** If a file changed on disk after the store loaded it, an
   API mutation that would write that file fails 409 (`ConfigWriteConflictError`) instead of
   silently clobbering the hand edit — reload (or discard the edit) first. A write with no prior
   load (blind full replace, e.g. `PUT /api/arguments/defaults`) is not guarded.
5. **Invalid files quarantine instead of killing the process.** At boot `initConfigStores()`
   (`config-store/registry.ts`) attempts every store; a failure is captured per store — the server
   always starts, the boot log and `GET /api/config/state` (`error` per file) carry the details,
   and reads of the broken store answer 503 naming the file. Instances quarantine **per file**:
   valid records keep serving, and process reconcile defers (never stale-closes) an open run whose
   instance file is quarantined while its cmdline still matches the launch snapshot. Fixing the
   files and POSTing reload recovers live; a restart is never required for recovery.

6. **Unknown keys survive read-modify-write.** Every persisted shape is parsed through a stored
   variant that accepts unknown keys (`.catchall(z.unknown())`; request schemas stay strict), and
   update flows merge onto the stored record instead of rebuilding it field-by-field. A file
   written by newer code therefore keeps its newer sections and fields when older code edits it —
   the forward-compatibility floor for a config tree shared between hosts through one git origin
   (`CONFIG_GIT.md`). A shape old code cannot parse at all still fails loudly (quarantine, refused
   pull), never a silent stripped rewrite. The boundary is record/section level: unknown keys
   inside nested strict shapes (pipeline nodes, webapp settings variants) do not ride along. The
   one deliberate exception: legacy `createdAt`/`updatedAt` keys are removed at the same boundary
   (`stripLegacyConfigTimestamps` in core) — tracked config files carry no timestamps
   (`CONFIG_FILES.md`), so those keys are always a stale marker for `normalizeConfigFiles()`, not
   forward data.

Errors are typed (`config-store/errors.ts`) and mapped centrally in `http-errors.ts`: quarantined
read → 503 `{ error: { message, configFile } }`, write conflict → 409, malformed request body →
400.

## Three ways to change configuration

- **Admin HTTP API (preferred, always safe).** Every mutation is Zod-validated (400 with a
  flattened error), cross-reference-checked on write and on delete, and applied atomically to both
  cache and disk. Nothing here ever needs a reload.
- **Direct file edits + reload.** The workflow for hand or agent edits, bulk changes, and files
  arriving via git:
  1. edit files under `data/config/` (write via temp file + rename to avoid torn reads);
  2. `GET /api/config-git/validation` — validates the tree fresh from disk, works without git;
  3. `POST /api/config/reload` — applies. Response: `{ applied, issues, normalizedFiles }`.
  Absolute paths under managed roots may be written as-is; normalization rewrites them to
  `${ARRIERO_*}` placeholders on apply (`PORTABLE_PATHS.md`).
- **Config-git operations** (`CONFIG_GIT.md`). Tree-level ops (clone/pull/switch/checkout/reset/
  restore-files) validate before activating and reload the caches themselves; they keep their
  stricter guards (clean tree, no running managed processes for tree replacement).

## Exceptions to the staged model

- **`config/presets/*.ini`** stay live: read fresh per request and written with an explicit
  `expectedMtimeMs` conflict check (409 returns the current document). `llama-server` co-owns these
  files and reads them from disk at launch, so the file itself is the state — reload neither caches
  nor applies them (tree validation still checks their structure).
- **`config/.secrets.json`** is gitignored machine state: schema-light, write-only through
  endpoint/source/node mutations, reloaded with the tree swap but not part of tree validation.
- Boot-time data migrations (`migrations/index.ts`) are individually guarded: a migration that
  fails (e.g. against a quarantined file) is logged and retried on the next start instead of
  aborting boot.

## Store roster

| Store id | File(s) | Portable paths |
| --- | --- | --- |
| `settings` | `settings.json` | yes |
| `argument-defaults` | `argument-defaults.json` | yes |
| `instances` | `instances/*.json` (per-file quarantine) | yes |
| `proxy:targets.json` … `proxy:settings.json` | `proxy/*.json` | no |
| `proxy:secrets` | `.secrets.json` | no |
| `path-catalog` | `path-catalog.json` (machine state) | yes |
| `resources` | `resources.json` | no |
| `nodes` | `nodes.json` | no |
| `environments` | `envs.json` (machine state) | no |
| `environments-state` | `envs-state.json` (machine state) | no |
| `webapps` | `webapps/*.json` (per-file quarantine) | no |
| `benchmark:prompts` | `benchmark/prompts.json` | no |

`resources` additionally refreshes `autoCapacity` pool capacities in memory only (never dirtying
git) via `replaceCachedValue` — the one sanctioned case where applied state deliberately diverges
from disk.
