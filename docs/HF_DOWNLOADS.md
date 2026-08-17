# HuggingFace downloads

The `hf` domain (`apps/api/src/hf/`) downloads model files from HuggingFace Hub — GGUF quants with
variant/split-aware selection, or arbitrary repos (safetensors snapshots for the Python engines) —
and tracks whether the downloaded files were later updated upstream. UI: the Downloads leaf of the
Models & files section (`apps/web/src/ui/views/HfDownloadsView.tsx`, route `#/downloads`).

## Browse

`GET /api/hf/browse?repo=<id-or-url>&revision=` (`apps/api/src/hf/browse.ts`) accepts an
`owner/repo` id or any huggingface.co URL (`parseHfRepoInput` in `packages/core/src/hf.ts` also
extracts a `/tree/<rev>` revision). The requested revision is resolved to a commit sha up front
(`GET /api/models/{repo}/revision/{rev}` → `sha`) and the file tree is listed **at that sha**, so
what the user sees is exactly what a download pins. The tree is fetched without `expand`
(1000 entries/page, `Link: rel="next"` pagination, capped at 10 pages → `truncated: true`).

GGUF grouping (`apps/api/src/hf/grouping.ts`) is server-side: multi-part splits
(`-00001-of-00003.gguf`, reusing `parseSplitInfo` from `apps/api/src/models/split.ts`) collapse
into one variant with aggregate size and a `complete` flag; the quant label comes from the
filename or — for per-quant-subfolder repos — the immediate parent directory name; `mmproj` files
are a separate kind. Repos without GGUF files get `ggufVariants: null` and the UI falls back to
the generic per-directory checkbox tree.

## Download jobs

`POST /api/hf/downloads` starts one background job per repo (registry domain `hf-download`,
`entityId = repoId`, so different repos download in parallel). The runner
(`apps/api/src/hf/download-runner.ts`) is in-process async work on the shared jobs kernel — no
child processes; `createLatestJobStore` keeps the latest job per repo and per-chunk byte progress
lives in a side map merged into the record at read time.

Start phase (synchronous, errors map to HTTP statuses in `apps/api/src/routes/hf.routes.ts`):
sanitize repo-relative paths (traversal guard in `apps/api/src/hf/paths.ts`), resolve the
destination (`<models dir>/<owner>/<repo>` by default, override allowed), pin the revision sha,
fetch authoritative per-file metadata via `paths-info` (`expand: true`), and check free space via
`capacityFromStatFs` with a 256 MiB headroom.

Per file, sequentially: a file already on disk with matching size and manifest oid (or matching
content hash) is `skipped`; otherwise the file streams to `<name>.part` and is renamed into place
only after verification. A leftover `.part` resumes with `Range: bytes=<offset>-` — the hash is
re-primed from the existing bytes first; a `200` on a resume attempt truncates and restarts, a
`416` retries once from zero. Every file is verified while streaming: sha256 against `lfs.oid`
for LFS files, git blob sha1 (`blob <size>\0` prefix) against `oid` for small plain files; a
mismatch deletes the `.part` and fails the file. Per-file failures are recorded and the job
continues; `unauthorized`/`gated`/`rate-limited` fail fast. Cancel keeps the current `.part` for
a later resume. A completed `.gguf` triggers a model rescan.

## Manifest and the downloads list

Each repo directory carries a sidecar manifest `.arriero-hf.json`
(`apps/api/src/hf/manifest.ts`, versioned schema, atomic write) recording `repoId`, the pinned
`revision` sha and per-file `oid`/`lfsOid`/`lastCommitId`. It is written after **every** completed
file, so an interrupted job leaves a valid partial manifest and the next run resumes.

`GET /api/hf/downloads` (`apps/api/src/hf/downloads.ts`) discovers manifests by walking the model
scan roots (`apps/api/src/models/roots.ts`) with a 30 s cache — there is no DB table; the manifest
travels with the files and survives DB recreation. A destination outside every scan root still
downloads but is not listed (the UI warns). `POST /api/hf/downloads/delete` removes a repo
directory after confirming no job is running for it.

## Update checks

No background loop — "no check ≠ current", mirroring the sources-drift stance.
`POST /api/hf/downloads/check {dirs}` (`apps/api/src/hf/update-check.ts`) fetches the current
head sha per repo; an unchanged sha short-circuits to `in-sync`, otherwise one `paths-info` call
compares stored oids per file → `current | updated | deleted`. Repo status is
`unchecked | in-sync | drift | error`, cached in memory with `checkedAt` and merged into the
downloads list. The cache has no TTL — an entry is replaced by the next check, dropped when the
download is deleted, and lost on manager restart; `checkedAt` is the honesty stamp shown in the
UI. Every finished download job clears the (now stale) cached entry for its directory, and a
**succeeded** job seeds a fresh check right away — so a new download shows `in-sync` as of its
completion and a finished "Download updates" run stops showing the old `drift`; failed/canceled
jobs fall back to `unchecked`. The repo-level sha alone is never the drift signal (a README edit would
false-positive). "Download updates" is the ordinary start endpoint called with the check's pinned
sha, the `updated` paths and the existing directory; `deleted` files are reported, never removed
locally.

## Token

`PUT /api/hf/token` stores the token in `data/config/.secrets.json` under `hf:token`
(`apps/api/src/hf/token.ts`); the API accepts a token and only ever returns
`{ tokenConfigured }` — the value is write-only. Anonymous access works for public repos; the
token is sent as `Authorization: Bearer` and undici drops it on the cross-origin CDN redirect.

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /api/hf/token`, `PUT /api/hf/token` | write-only token surface |
| `GET /api/hf/browse?repo=&revision=` | repo info + tree + GGUF variants |
| `GET /api/hf/dest-check?dir=` / `?repo=` | free space + inside-scan-roots for a destination |
| `POST /api/hf/downloads` | start a download job (201) |
| `GET /api/hf/downloads` | downloaded repos from manifest discovery |
| `POST /api/hf/downloads/check` | manual update check for up to 50 dirs |
| `POST /api/hf/downloads/delete` | delete a downloaded repo directory |
| `GET /api/hf/jobs`, `GET /api/hf/jobs/:owner/:repo` | job list / single job with live progress |
| `POST /api/hf/jobs/:owner/:repo/cancel` | cancel a running job |

Upstream HF errors map to: 403 (`unauthorized` and `gated`), 404, 429, 502; our own 401 stays
reserved for the admin session (`requireAdmin`). Note HF answers anonymous requests for
nonexistent repos with 401 rather than 404 (it hides repo existence), so the `unauthorized`
message covers both "repo not found" and "token missing/invalid".
