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

## Download queue

`POST /api/hf/downloads` **enqueues** a job and captures a declarative *model requirement* into the
tracked `config/models.json` (`hf/requirements.ts`, `docs/CONFIG_FILES.md`): the repo id, the
pinned revision sha and the requested file list, deduplicated by repo and destination — so a
config tree cloned onto another host carries which models it needs, not just filesystem paths.
The queue (`apps/api/src/hf/download-queue.ts`) runs
**strictly sequentially** — one active job, FIFO with manual reorder, duplicate enqueues for the
same repo allowed (the on-disk skip fast-path dedupes at execution). The scheduler `pump()` is the
only place a job starts, so there is no start-time race; the active job registers in the jobs
kernel (registry domain `hf-download`, `entityId = destDir`) purely so `shutdownActiveJobs` can
abort it. Parallelism lives **inside** a job: the transfer engine
(`apps/api/src/hf/transfer-engine.ts`) runs N worker connections (the `downloads` settings
section: `connections` 1–16 default 6, `chunkBytes` default 32 MiB — measured ~1.7× over a single
connection at 8 on a ~30 MB/s-per-connection CDN path) over a shared task list: large files split
into ranged chunks, files ≤ one chunk (or with `connections: 1`) stream whole; workers converge on
the earliest incomplete file so early files finish first.

Enqueue phase (synchronous in the request, `apps/api/src/hf/download-plan.ts`): sanitize
repo-relative paths (traversal guard in `apps/api/src/hf/paths.ts`), resolve the destination
(`<models dir>/<owner>/<repo>` by default, override allowed), pin the revision sha, fetch
authoritative per-file metadata via `paths-info` (`expand: true`), and check free space with a
256 MiB headroom (re-checked hard at job start; partial bytes are counted via
`partialBytesFor`, never a raw `.part` stat — chunked parts are preallocated sparse at full size).

**The queue persists** to `data/hf-download-queue.json` (`apps/api/src/hf/queue-store.ts`,
atomic write-through; per-file oids stored so a resume never refetches `paths-info`) on every
state transition — never per byte. Boot adopts the file (`adoptHfDownloadQueue`, a bootStep in
`apps/api/src/index.ts`): a `running` job is normalized back to `queued` at the head and
**auto-resumes**; finished jobs stay as history (trimmed to 20). Shutdown flags the queue
(`beginHfDownloadQueueShutdown`) before `shutdownActiveJobs` aborts the transfer, and the
interrupted job re-persists as `queued` with its `downloading` files back to `pending` — a user
cancel is distinguished by `cancelRequested`, persisted before the abort. An invalid queue file is
quarantined to `.invalid` and logged, never silently defaulted.

Per chunked file the engine keeps a sidecar `<file>.part.json`
(`apps/api/src/hf/chunk-store.ts`: size, frozen `chunkBytes`, expected oid, revision, completed
chunk indexes, rewritten after every completed chunk) next to the sparse preallocated `<file>.part`;
workers write with explicit positions (never the append flag). Resume validates the sidecar
(size/oid/revision + part size) and refetches only missing chunks; a legacy append-`.part` without
a sidecar is adopted as whole completed chunks; a mismatched sidecar restarts the file. Since
chunks land out of order, verification is a **post-pass**: after the last chunk the assembled part
is re-read and hashed (sha256 against `lfs.oid` for LFS files, git blob sha1 with the
`blob <size>\0` prefix against `oid` otherwise), then renamed into place and the sidecar removed;
a mismatch deletes part + sidecar and fails the file. Single-stream files keep the old behavior:
inline hashing, `Range: bytes=<offset>-` resume with the hash re-primed from existing bytes, a
`200` on resume truncates and restarts, a `416` retries once from zero. A file already on disk
with matching size and manifest oid (or matching content hash) is `skipped`.

Failure policy: transient errors (network, 5xx) retry per chunk with exponential backoff (max
30 s + jitter); the 5-attempt limit bounds only **consecutive attempts without byte progress** —
any flushed progress resets the counter. A mid-stream disconnect (undici's raw
`TypeError: terminated` and friends) is classified as a network error by the body-read wrappers,
not just fetch-time failures, and a retry resumes where the data stopped: a chunked retry
re-requests the bounded range from the last byte flushed via the positional file handle, a
single-stream retry from the flushed `.part` size (the write stream is flushed, not destroyed, on
error — buffered bytes are never lost, and a stream write error is captured instead of crashing
the process). All download requests go through a dedicated undici agent
(`apps/api/src/hf/http.ts`): 30 s to response headers, 45 s body idle timeout, replacing undici's
300 s defaults so a silently dead connection fails fast while a slow-but-moving stream is never
cut. A `416`/`200` on a bounded range falls the file back to a single
stream; `429` gets two long retries (30/60 s) then fails the job; `unauthorized`/`gated` and
`ENOSPC` fail the job immediately (remaining files → `canceled`); other per-file failures are
recorded and the job continues.

**Stall pause**: when a chunk (or single stream) exhausts its no-progress attempts, the engine
checks a job-wide progress stamp — if any worker flushed bytes during that failure run, the link
works and only this file fails (status `failed`, job continues); if nothing progressed anywhere,
the link is sick and the whole job transitions to **`paused`** (`pauseReason: "network"`) instead
of grinding through every remaining file: `downloading` files go back to `pending`, parts and
sidecars stay, the queue moves on to the next queued job, and one click (or
`POST /api/hf/queue/:id/resume`) re-queues it. `POST /api/hf/queue/:id/pause` pauses manually —
immediately for a queued job, via abort + finalize for the running one (`pauseRequested` mirrors
`cancelRequested` in the API shape; cancel wins over pause). A paused job survives restarts as
paused (boot adoption auto-resumes only interrupted `running` jobs), is skipped by `pump()`,
retained by reorder, has files droppable like a queued job, and is removable outright.

**Slow-ETA pause**: with `downloads.maxEtaHours` set (default 24, `null` switches the policy off,
editable in the download-settings card), the active job's projected finish time is checked on byte
events after a 90 s measurement window, using the run-average useful rate (not the jumpy short
EWMA); a projection over the limit aborts the run into `paused` (`pauseReason: "slow-eta"`) with
the projection in the message — this catches the trickling-but-hopeless link the no-progress stall
detector cannot (bytes do arrive), and stops a doomed job from blocking the strictly sequential
queue. The paused card offers **Resume** (re-measures; pauses again if still hopeless — the route
may have recovered) and **Continue anyway** (`POST …/resume` with `{ignoreSlowEta: true}`), which
sets a persisted per-job `slowEtaOverride` disabling the policy for that job for good.

**Server-side transfer telemetry**: the active job carries a `transfer` snapshot
(`HfDownloadTransferSchema`; `null` on inactive jobs, never persisted) computed by
`apps/api/src/hf/transfer-telemetry.ts` from engine events: `payloadBps` (EWMA over useful bytes,
nulled after 6 s without wire progress together with `etaSeconds`), `wireBytes` (everything
received, re-downloads included) vs `wastedBytes` (wire minus useful — with mid-chunk resume
normally 0), `resetCount` (transient transport errors), `lastProgressAt` and `stalledSeconds`.
Useful-byte deltas skip each file's first byte report (baseline restoration of resumed parts, not
new progress). The web queue card prefers this server snapshot over its client-side EWMA
(`ui/utils/byte-rate.ts` stays as the fallback) and surfaces resets and re-downloaded bytes; the
server numbers are the basis for pause policies, since the queue outlives any browser tab. Cancel — whole job (`POST /api/hf/queue/:id/cancel`) or per file
(`POST /api/hf/queue/:id/files/skip`, which also drops files from a queued job) — keeps `.part` +
sidecar for a later resume. A completed `.gguf`/`.safetensors` triggers a model rescan. A manifest
header is written at job start so a directory holding only `.part`s is discoverable, and the
downloads cache is invalidated after every completed file so the UI list stays fresh mid-job.

## Manifest and the downloads list

Each repo directory carries a sidecar manifest `.arriero-hf.json`
(`apps/api/src/hf/manifest.ts`, versioned schema, atomic write) recording `repoId`, the pinned
`revision` sha and per-file `oid`/`lfsOid`/`lastCommitId`. It is written after **every** completed
file, so an interrupted job leaves a valid partial manifest and the next run resumes.

`GET /api/hf/downloads` (`apps/api/src/hf/downloads.ts`) discovers manifests by walking the model
scan roots (`apps/api/src/models/roots.ts`) with a 30 s cache — there is no DB table; the manifest
travels with the files and survives DB recreation. Each entry carries the manifest's per-file
records (`path`/`size`/`oid`/`lfsOid` plus an on-disk `present` flag and `partialBytes` — bytes
already on disk for an unfinished file, read via `partialBytesFor`), `orphanParts` (`.part`/
`.part.json` leftovers whose final file is not in the manifest, capped bounded walk) and
server-grouped GGUF `variants` (the same `grouping.ts` browse uses).

The UI (`apps/web/src/ui/views/`) is one page: the collapsible repository browser
(`HfRepoBrowserPanel.tsx` — the Download button always enqueues and hints at the queue length),
the live queue panel (`HfQueuePanel.tsx` + `HfQueueJobCard.tsx`/`HfQueuedJobCard.tsx`/
`HfJobFileRow.tsx`, polling `["hf-queue"]` at 1.5 s while anything is active: overall progress,
client-side EWMA speed + ETA (`ui/utils/byte-rate.ts`), per-file progress bars with per-file
skip, queued cards with reorder/remove, server-side history with dismiss/clear), the library
(`HfDownloadedReposPanel.tsx` — a partial repo shows `X of Y on disk` plus a one-click
**Resume** button that enqueues exactly the missing files into the same directory at the manifest
revision) and the download-settings + token cards. Queue mutations return the full queue state and
land via `setQueryData` — no refetch; `useHfJobsSync` (`use-hf-queue.ts`) invalidates
`["hf-downloads"]`/`["models"]` when a job settles and throttled on per-file completions.

Clicking a repo card opens the repo detail modal (`HfRepoDetailModal.tsx`), the one management
surface: it lazily browses the repo at `main` and joins the tree with the manifest client-side
(`hfManifestOidMatches`, exported from core; row models in `HfRepoDetailRows.tsx`) into checkbox
rows per variant and file with `on disk`/partial (`X of Y`)/`changed upstream`/`missing`/
`not upstream` badges. While its directory has an active or queued job the modal shows the live
progress strip and per-file rows inline (same components as the queue panel) and download buttons
enqueue-gate on this directory only — other repos may download meanwhile; delete stays disabled
until the job is gone. One selection feeds two explicit verbs — `Download N` (the subset absent or
changed upstream) and `Delete N` (the subset present on disk) — and the header actions are
`Check updates`, `Download updates` (on drift), `Download all` (every remote file not current,
sized in the label; an `all files on disk` badge when nothing is left) and `Delete repository`;
an orphan-parts section lists leftovers with their sizes and deletes them (upstream verification
skipped for parts). Modal downloads always target the existing directory, so a repo downloaded
into a custom directory never forks a second copy; free space from `dest-check` gates the download
buttons. When the upstream listing is unavailable the modal degrades to the manifest — deletion
keeps working, downloads switch off. The browser panel keeps the same client-side join for
discovering new repos: an already-downloaded repo shows a banner with its local directory plus a
button to reuse it as the destination. A destination outside every scan root still downloads but
is not listed (the UI warns).

## Deletion

`POST /api/hf/downloads/delete {dir, paths?, verifyUpstream?}` removes a downloaded repo — whole
directory when `paths` is absent, individual manifest files otherwise (a GGUF variant in the UI is
just its file list: the detail-modal variant checkbox toggles all its paths). `paths` may also
name orphan `.part`/`.part.json` leftovers (deleted together with their sidecar, upstream
verification skipped for them); anything else not listed in the manifest is 404. A job actively
downloading into the directory refuses with 409 (queued jobs do not block — they recreate what
they need), and deletion refuses with 409 while a live local process references the targets
(`apps/api/src/hf/in-use.ts`: open process runs with an alive PID, matched by launch-snapshot argv
token; per-file scope also matches sibling shards of a targeted GGUF split and a dir-as-model
reference; local processes only — see `docs/SHARED_MODELS_DIR.md` for multi-host discipline).
Per-file removal also drops the file's `.part` leftover, prunes emptied subdirectories
and shrinks the manifest — the cached update check is pruned to the remaining files instead of
being cleared. A `paths` set covering every manifest file escalates to whole-directory removal
(the UI dialog says so). With `verifyUpstream: true` the server first runs the standard update
check (cached as usual, so `checkedAt` refreshes) and refuses with `412` +
`{error, verification}` (`HfDownloadDeleteBlockedSchema`) when the check errors or a targeted
file is `deleted` upstream — i.e. it could not be re-downloaded; `updated` files stay deletable.
The UI delete dialog verifies by default and turns the confirm button into "Delete anyway" on a
412.

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
| `POST /api/hf/downloads` | enqueue a download job (201; 409 only for insufficient space) |
| `GET /api/hf/downloads` | downloaded repos from manifest discovery (+ `partialBytes`, `orphanParts`) |
| `POST /api/hf/downloads/check` | manual update check for up to 50 dirs |
| `POST /api/hf/downloads/delete` | delete a repo directory, selected files or orphan parts, optional upstream verify |
| `GET /api/hf/queue` | queue state: active job with live progress, queued jobs, history |
| `POST /api/hf/queue/reorder` | reorder queued jobs (`ids` = the complete new order) |
| `POST /api/hf/queue/:id/cancel` | cancel the active job (parts kept for resume) |
| `POST /api/hf/queue/:id/pause` | pause the active or a queued job (parts kept) |
| `POST /api/hf/queue/:id/resume` | re-queue a paused job (`{ignoreSlowEta: true}` disables the ETA policy for it) |
| `DELETE /api/hf/queue/:id` | remove a queued job or dismiss a history entry |
| `POST /api/hf/queue/:id/files/skip` | skip files of the active job / drop files from a queued one |
| `DELETE /api/hf/queue/history` | clear the finished-job history |
| `GET/PUT /api/hf/download-settings` | connection count + chunk size + max ETA hours |

Every mutating queue endpoint returns the full queue state so the UI applies it without a
follow-up fetch.

Upstream HF errors map to: 403 (`unauthorized` and `gated`), 404, 429, 502; our own 401 stays
reserved for the admin session (`requireAdmin`). Note HF answers anonymous requests for
nonexistent repos with 401 rather than 404 (it hides repo existence), so the `unauthorized`
message covers both "repo not found" and "token missing/invalid".
