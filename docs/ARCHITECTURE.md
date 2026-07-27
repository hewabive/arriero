# Architecture

`arriero` is a local single-user control plane for `llama.cpp`.

## Stack

- Runtime: Node.js 24+
- Package manager: pnpm workspaces
- API: Hono on `@hono/node-server`
- UI: React + Vite + Mantine
- Validation and shared contracts: Zod in `packages/core`
- Server state in UI: TanStack Query
- Persistence: SQLite via Drizzle ORM and `better-sqlite3`
- Process control: Node `child_process.spawn`
- Realtime: SSE first, WebSocket only when bidirectional terminal-like control is needed

## Packages

- `apps/api`: local API server, process supervisor, SQLite persistence
- `apps/web`: browser UI for managing instances
- `packages/core`: shared schemas and TypeScript types

## MVP Assumptions

- Single local user.
- API binds to `127.0.0.1` by default.
- Admin auth is optional and disabled until `ARRIERO_ADMIN_PASSWORD` or
  `ARRIERO_ADMIN_PASSWORD_HASH` is configured.
- The public status route exposes only redacted diagnostics; admin routes expose
  process control, paths, arguments and logs after login.
- System resources are modeled as a shared contract with RAM data now and an
  accelerator list reserved for GPU/VRAM inventory later.
- `systemd` is not the source of truth; it can be added later as an optional Linux adapter.
- Instances are managed directly as child processes.
- SQLite stores durable runtime state and rebuildable caches; portable, hand-editable config is file-backed. Running process state is in memory and reconstructed from health checks.

## Durable Data

- `data/arriero.db`: instance definitions, binary path-catalog, process-run
  metadata (pruned to the latest + open run per instance), proxy config, and
  rebuildable caches (model scan, parsed `--help`).
- File-backed config, loaded at startup (restart to apply):
  - `data/config/presets/<name>.ini`: `--models-preset` files; the file on disk
    is the source of truth and instances reference a preset by filename.
  - `data/config/settings.json`: `modelScan` / `sourceRepositories` / `build`
    sections. Managed source paths are derived from the local runtime root;
    portable source specs hold adapter, origin and location policy. The
    `llama-cpp` source is shared by build, source status and argument-docs sync.
  - `data/config/argument-defaults.json`: default instance arguments.
    JSON files seed from git-tracked `config/*.json` and fail loud on malformed JSON.
- `runtime/logs`: stdout/stderr logs for managed processes
- `runtime/sources`: managed inference source checkouts

## Extension Points

- Build jobs: a build runner drives `git pull`, CMake configure and CMake build;
  jobs are tracked in memory (recent-history cap), not persisted in the DB.
- Source repositories: adapter-defined managed/external Git checkouts with
  staged clone, configurable origin and strict top-level validation. See
  `docs/SOURCE_REPOSITORIES.md`.
- Argument schema sync: extract `llama-server --help` or `common/arg.cpp` from
  the canonical source repository into generated JSON, then store Russian help
  as an overlay.
- Argument documentation sync: `/api/llama-args/docs-sync` compares the stored
  generated help snapshot in `content/llama-args/source/` with the current
  `tools/server/README.md` `HELP_START` block from the canonical source repo.
  Commit changes alone do not mark all argument docs stale. The repo-local
  Codex skill `.codex/skills/llama-arg-help-sync` drives agent updates.
- Model scanner: scan GGUF directories, cache metadata by path, size and mtime.
- Model presets: edit `llama-server --models-preset` INI files where the file on
  disk is the source of truth. Presets live in `data/presets/<name>.ini` (identity
  = filename); the `presets` domain reads/parses/validates and writes the file
  (atomic, with an mtime conflict check). Instances link a preset by name. No
  preset content or catalog is stored in the DB.
- Process health: combine child process state with `/health`, `/props`, `/slots` and `/metrics`.
- API proxy: keep proxy contracts, scheduling decisions and HTTP forwarding in
  a separate `proxy` domain. See `docs/API_PROXY_FOUNDATION.md`.
