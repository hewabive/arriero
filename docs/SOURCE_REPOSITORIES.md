# Source repositories

arriero manages inference source checkouts independently from build and
runtime-engine installation. The first registered source is `llama-cpp`; the
same domain is intended for sources that are inspected for integration drift
even when arriero never builds them.

## Managed and external checkouts

A fresh installation synthesizes this portable source specification:

```json
{
  "id": "llama-cpp",
  "adapter": "llama-cpp",
  "originUrl": "https://github.com/ggml-org/llama.cpp.git",
  "location": { "type": "managed" }
}
```

Managed checkouts live under `runtime/sources/` by default, so llama.cpp is
cloned to `runtime/sources/llama.cpp`. Set `ARRIERO_SOURCES_DIR` to move
all managed source checkouts without putting machine-specific absolute paths in
portable configuration.

An existing legacy or manually selected llama.cpp path is represented as an
`external` location and continues to work. The old implicit sibling checkout
(`../llama.cpp`) is adopted only when it actually exists; a fresh node uses the
managed location.

Source specifications are written to the `sourceRepositories` array in
`data/config/settings.json`. The adapter registry supplies display names,
default origins, managed directory names, checkout validation, and whether a
source has drift checks. Adding another inference source does not require
adding another build implementation.

## Clone and origin behavior

The Source Sync page can:

- clone a missing checkout at its configured managed or external location;
- override the default origin before cloning;
- change the `origin` remote of an existing checkout;
- fast-forward pull the current tracking branch;
- show repository path, branch, commit, tag, and dirty state;
- run adapter-specific integration drift checks.

Clone accepts credential-free HTTPS, HTTP, SSH/SCP, and `file:` URLs (plain
HTTP serves local mirrors; the configuration Git repository still requires
SSH or HTTPS). Private repository credentials must come from an SSH agent or
Git credential helper.
Git commands disable terminal prompts and repository hooks, bound runtime and
output, and redact credentials from returned output.

Clone intentionally fetches the full repository history. It does not use a
shallow or filtered clone because Build exposes local branches and recent tags
for ref selection. Clone and pull start background source-operation jobs; both
Source Sync and Build show their phase, aggregate progress, elapsed time, live
bounded log, terminal result, and cancel action. Leaving either page does not
cancel the operation.

Clone is staged in a temporary sibling directory, validated, and atomically
renamed into place. An existing target is never overwritten. `llama-cpp`
mutations are refused while a llama.cpp build is running, and vice versa.
Staging directories (`.source-clone-*`) orphaned by an interrupted clone are
swept from every configured source parent directory at startup.
The latest job state is kept in API-process memory. A graceful API shutdown
cancels the active Git process; startup clears the previous job state and
sweeps an interrupted clone's staging directory.

## Repository identity

Because managed sources live inside the ignored `runtime/` directory, ordinary
Git discovery would otherwise walk upward and mistake the arriero
checkout for the inference source. Every source operation therefore requires:

1. `git rev-parse --show-toplevel` to succeed;
2. the real top-level path to equal the configured source path exactly;
3. adapter-specific marker validation (for llama.cpp, `CMakeLists.txt`).

A plain directory inside arriero is reported as `invalid`; pull and other
mutations are refused.

## Status and drift

Repository lifecycle state and integration drift are separate:

- repository: `missing`, `busy`, `ready`, `dirty`, `invalid`, or `error`;
- drift report: `unavailable`, `in-sync`, `drift`, or `error`.

Drift checks do not run until a checkout is a valid repository. Consequently a
missing checkout cannot be summarized as “Everything is in sync”, and a source
with no checks is not implicitly considered current.

## API

- `GET /api/source-repositories`
- `GET /api/source-repositories/:id/status`
- `GET /api/source-repositories/:id/operation`
- `GET /api/source-repositories/:id/drift`
- `PUT /api/source-repositories/:id/settings`
- `POST /api/source-repositories/:id/clone`
- `POST /api/source-repositories/:id/pull`
- `POST /api/source-repositories/:id/operation/cancel`

Clone and pull return `202 Accepted` with a
`SourceRepositoryOperationJob`. Poll `operation` while its status is `running`;
the same payload contains current phase, progress, log lines, and terminal
error/output. Only one mutation may run for a source at a time.

The existing `/api/llama-source/*` endpoints remain as compatibility adapters
for llama argument-documentation consumers. Build reads the canonical source
repository status directly so it preserves `busy` and `activeOperation`.

Everything under `/api/source-repositories/*` and the compatibility adapters are
ordinary administrative `/api/*` routes behind `requireAdmin`; there is no extra
listener gate, so exposure is governed solely by whether admin auth is
configured. Repository status and drift reads run on the async Git runner so the
polled status endpoints do not block the event loop of the serving process.
