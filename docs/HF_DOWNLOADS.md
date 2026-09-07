# HuggingFace downloads

The `hf` domain (`apps/api/src/hf/`) downloads model files from HuggingFace Hub — GGUF quants with
variant/split-aware selection, or arbitrary repos (safetensors snapshots for the Python engines) —
and tracks whether the downloaded files were later updated upstream. UI: the Model library and Downloads leaves of the Models & files section
(`apps/web/src/ui/views/ModelLibraryView.tsx`, route `#/model-library`;
`HfDownloadsView.tsx`, route `#/downloads`).

## Browse

`GET /api/hf/browse?repo=<id-or-url>&revision=` (`apps/api/src/hf/browse.ts`) accepts an
`owner/repo` id or any huggingface.co URL (`parseHfRepoInput` in `packages/core/src/hf.ts` also
extracts a `/tree/<rev>` revision). The requested revision is resolved to a commit sha up front
(`GET /api/models/{repo}/revision/{rev}` → `sha`) and the file tree is listed **at that sha**, so
what the user sees is exactly what a download pins. The tree is fetched without `expand`
(1000 entries/page, `Link: rel="next"` pagination, capped at 10 pages → `truncated: true`).

GGUF grouping (`apps/api/src/hf/grouping.ts`) is server-side: multi-part splits
(`-00001-of-00003.gguf`, reusing `parseSplitInfo` from `packages/core/src/gguf-split.ts`) collapse
into one variant with aggregate size and a `complete` flag; the quant label comes from the
filename or — for per-quant-subfolder repos — the immediate parent directory name; `mmproj` files
are a separate kind. Repos without GGUF files get `ggufVariants: null` and the UI falls back to
the generic per-directory checkbox tree.

## Download queue

`POST /api/hf/downloads` **enqueues** a job and captures a declarative *library entry* into the
tracked `config/models.json` (`hf/model-library.ts`, `docs/CONFIG_FILES.md`): the repo id, the
pinned revision sha and the requested file list, deduplicated by repo and destination — so a
config tree cloned onto another host carries which models it needs, not just filesystem paths.
The queue (`apps/api/src/hf/download-queue.ts`) runs
**strictly sequentially** — one active job, FIFO with manual reorder, duplicate enqueues for the
same repo allowed (the on-disk skip fast-path dedupes at execution). The scheduler `pump()` is the
only place a job starts, so there is no start-time race; the active job registers in the jobs
kernel (registry domain `hf-download`, `entityId = destDir`) purely so `shutdownActiveJobs` can
abort it. Parallelism lives **inside** a job: the transfer engine
(`apps/api/src/hf/transfer-engine.ts`) tunes worker connections automatically from 4 up to 8 over
a shared task list. It probes one extra connection per 1.5 s measurement window, keeps the probe
only when aggregate throughput improves by at least 5%, retries a plateau later, and backs off on
transport errors or rate limits. Large files split into automatically sized 16–128 MiB ranged
chunks (roughly four chunks per maximum worker); files no larger than one chunk stream whole.
Workers converge on the earliest incomplete file so early files finish first. The active queue
card exposes the current connection target, but connection and chunk tuning are not user settings.

Enqueue phase (synchronous in the request, `apps/api/src/hf/download-plan.ts`): sanitize
repo-relative paths (traversal guard in `apps/api/src/hf/paths.ts`), resolve the destination
(`<selected models dir>/<owner>/<repo>` by default, custom override allowed), pin the revision sha,
fetch authoritative per-file metadata via `paths-info` (`expand: true`), and check free space with a
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
any flushed progress resets the counter. A mid-stream disconnect is classified as a network error
by the body-read wrappers, not just request-time failures, and a retry resumes where the data
stopped: a chunked retry re-requests the bounded range from the last byte flushed via the
positional file handle, a single-stream retry from the flushed `.part` size. Chunked writes batch
roughly 1 MiB before a positional write; a stream failure flushes valid buffered bytes before the
retry. All payload requests go through a dedicated raw `node:https` transport
(`apps/api/src/hf/http.ts`) while metadata requests retain `fetch`: the Node stream keeps the
socket receive window open on high-RTT paths, with 30 s to response headers and a 45 s body-idle
timeout. Redirects are HTTPS-only and capped at five; authorization, cookie and proxy credentials
are stripped when the origin changes. A `416`/`200` on a bounded range falls the file back to a
single stream. All workers share one `429` cooldown, honor `Retry-After`/HF reset timing, otherwise
back off for 15/30/60/120/240 s, and reduce parallelism. Exhausting the five-attempt or 10-minute
budget pauses the resumable job as a network stall instead of failing it. `unauthorized`/`gated`
and `ENOSPC` fail the job immediately (remaining files → `canceled`); other per-file failures are
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

The Downloads page (`apps/web/src/ui/views/`) contains the collapsible repository browser
(`HfRepoBrowserPanel.tsx` — the Download button always enqueues and hints at the queue length;
the destination control explicitly switches between a saved model-directory selection and a
one-off custom path),
the live queue panel (`HfQueuePanel.tsx` + `HfQueueJobCard.tsx`/`HfQueuedJobCard.tsx`/
`HfJobFileRow.tsx`, polling `["hf-queue"]` at 1.5 s while anything is active: overall progress,
client-side EWMA speed + ETA (`ui/utils/byte-rate.ts`), per-file progress bars with per-file
skip, queued cards with reorder/remove, server-side history with dismiss/clear) and the
download-settings + token cards. Saved and downloaded repositories share the Model library page. Queue mutations return the full queue state and
land via `setQueryData` — no refetch; `useHfJobsSync` (`use-hf-queue.ts`) invalidates
`["hf-downloads"]`/`["models"]` when a job settles and throttled on per-file completions,
and `["hf-library"]` when a job settles.

The library card’s **Open repository** action opens `ModelLibraryDialog`, the shared management
surface described below. The browser panel joins its remote files with local manifests when
choosing downloads: an already-downloaded repo shows its local directory and a button to reuse
it as the destination. A destination outside every scan root still downloads but is not listed
(the UI warns).

The repository dialog also provides an offline **Verify files** action. It reads every file tracked
by `.arriero-hf.json` sequentially and compares its size and content hash with the manifest: raw
sha256 against `lfsOid` for LFS files, or Git blob sha1 against `oid` for regular Git files. The
result distinguishes missing files, size mismatches, checksum mismatches and read errors; it never
contacts HuggingFace. Verification is refused while a download is active in that directory.
Results mark failed files with `integrityFailed` in the local manifest, provided the manifest
has not changed during verification. This survives reopening the dialog and bypasses the transfer
engine’s manifest-only skip shortcut: a damaged file is hashed again and downloaded if needed.
Successful transfers replace the file record and clear the flag.

## Model library

The Model library page (`#/model-library`) hosts `ModelLibraryView` and `ModelLibraryDialog`.
Saved entries are joined with downloaded repositories by local directory; downloaded repositories
without a saved entry appear in the same list with a Save to library action. Local management and
freeing disk space are available from those cards. Downloads remains the Hub browser and queue.
A repository can be saved without downloading any files. The saved installation selection, pinned commit and accepted
repository snapshot travel with `config/models.json`; no model bytes or credentials enter config
Git. Standard destinations continue to resolve beneath the local models directory and align with
instance paths using `${ARRIERO_MODELS_DIR}`. Custom absolute paths and preset INI paths retain
their existing portability limitations.

The page searches repositories and filters by saved, on-disk, missing-file or upstream-change
status. It adds watch-only entries from a repo ID/URL and branch, checks repositories, and
downloads missing selected files individually or across the library.
`ModelLibraryDialog` is the only repository management window, used for saved entries and local
repositories without a saved entry. `ModelLibraryTree` displays full filenames in their actual
folders, with compact size, local-state and changes-since-review columns. It joins pinned and latest
checked paths with saved paths, local manifests, queue files and orphan download parts. Deleted
remote files remain at their original paths. An unavailable remote tree is unknown, not empty.
`ModelLibraryFileDetails` shows hashes, per-version metadata and integrity details on demand.

Checkboxes are a temporary action selection, independent of the saved installation (marked with a
bookmark). Folder checkboxes select their descendants; under a search or filter they select only
matching descendants. Search reveals ancestor folders. Select saved, select all matching, clear,
and filters for local, missing, changed, damaged or selected files operate on this same tree.
The library API validates exact repo-relative paths; it never adds sibling GGUF shards,
safetensors weights or support files implicitly. Selecting a folder is the way to select a bundle;
an individual shard may be restored independently. Saved selections still have a 2000-file bound.

The version selector controls remote availability and downloads; local deletion always targets the
existing directory. Saved installation actions add or remove the selected paths without touching
local files. Download selected queues missing, different or damaged selected files at the pinned
commit. Save and download explicitly adds new paths to the installation first. A latest revision
must be pinned explicitly before downloading; the preview lists saved paths removed because they
are absent in the new tree and includes selected remote files. Pinning applies to the entire saved
installation and neither downloads files nor acknowledges upstream changes.

The same window exposes integrity verification, whole-directory deletion, orphan-part selection,
per-file queue progress, pause/resume/cancel and skipping selected queued files. Deletion retains
the existing confirmation and upstream-availability check. Downloads, selection edits and review
acknowledgement keep the management window open. Check timestamps use the shared local formatter.

`library-checks.ts` compares the entire remote tree against the accepted snapshot, independent
of local manifests or download outcomes. Changes include added, updated and deleted files;
commit changes without file changes are still reported as a repository change. Incomplete tree
listings and access/network errors never become deletion reports or accepted snapshots. The
existing Hub tree pagination bound applies. Checks use a 60-second request budget and cache
results in memory (at most 200 entries), scoped to the current entry contents. Explicit selection,
pin and review edits retain the checked tree when the repository and watched revision stay the
same, rebasing its comparison against the updated accepted snapshot. Restarting clears
last-check results, but the accepted snapshot is portable and survives. Legacy entries with no
snapshot use their saved revision as the baseline until a snapshot is accepted explicitly.

Mark changes reviewed accepts the checked tree as the new comparison baseline. Pin this version
and selection changes the installation commit and validates the chosen files against that tree;
it does not download weights or implicitly acknowledge changes. Both actions reject stale or
unavailable check results. Missing files in a newer revision can be explicitly removed through
the selection preview. The API rechecks the configuration entry before publishing asynchronous
edits. A legacy floating entry must save a concrete snapshot selection before restoring files.

Local status is derived only from the expected repository and destination: a copy elsewhere does
not satisfy it. Presence, revision differences and recorded content-hash differences are shown
separately. Presence is not an integrity audit; the installed repository's Verify files action
reads actual bytes. A failed download does not remove its saved selection. The queue receives
pinned paths for restoration and verifies existing content through its normal transfer logic.
Automatic capture records selected hashes supplied by the queue/import, preserves existing pins,
and logs rather than repinning when a subsequent acquisition uses another revision.

Deleting weights leaves the entry and snapshots available for restoration. The pre-delete
availability check checks paths at the recorded manifest revision, rather than current main.
Restoration still requires that revision to remain accessible on the Hub.

## Importing local models

The Models page shows a `Managed` marker for model weight files covered by a discovered HF
manifest and an `Organize` action otherwise (`ModelImportControl.tsx`, `ModelImportDialog.tsx`).
Managed is registration status, not a fresh checksum check; custom download destinations are
valid managed locations too. Import targets the current default download directory, using the
same `<owner>/<repo>` layout.

Opening Organize restores an existing operation for that source or starts automatic discovery.
`POST /api/hf/imports` accepts a local path and scope; `repo` is optional and can narrow the search
with a model name or pin a repository ID/URL. Search terms come from the filename without its
quantization/shard suffix, the directory name for safetensors, and cached model provenance.
Available author/base-model hints refine an initial search; name, base-model and unfiltered
searches broaden it. The Hub search returns `sha` and `siblings`, so candidates containing the
local filenames rank ahead of renamed-file fallbacks. Each query takes at most 30 results and at
most 30 ranked repository candidates are examined (plus an explicit metadata repository hint).
Search results and local-neighbor limits are reported as incomplete search, never proof of absence.
Explicit revisions and URLs are supported; automatic search defaults to current main, not history.

`import-discovery.ts` pins candidate trees and verifies content through `model-import-plan.ts`.
Multiple repositories with identical content are shown as verified copies, not a claim about
which one originally supplied the file. A single candidate is selected automatically. Identical
content at multiple paths within one repo offers a path selector, preferring the local name.
An explicit repo bypasses the model search. Search requests return names, not file hashes; hashes
come from the pinned repo trees. Weight bytes are neither uploaded nor downloaded. Repository
listings are cached for 60 seconds (bounded to 60 entries and scoped to the token), and up to 512
local content hashes are reused only while device/inode/size/mtime/ctime identity is unchanged.
429 responses retry twice according to the Hub reset interval, with cancelable waits.

For individual GGUF import, all standard split shards are mandatory. `groupGgufFiles` is the
shared grouping primitive for discovery, server selection and UI: a single file and a complete
split set are both importable groups. `import-matching.ts` matches the whole group to one complete
remote group, never assembling shards from unrelated remote directories. All matching remote
groups remain available as path alternatives, with incomplete destination selections rejected.

`import-neighbors.ts` first projects the verified repository tree onto local directories. The
selected file's verified remote paths suggest repository roots up to two levels above its local
directory; the current directory is also tried for a flattened archive. Up to 2,000 projected
paths are checked, including deeper paths explicitly present in the remote tree. Every proposed
file still requires a size/content match; matching directory structure alone is insufficient.

A fallback walk finds renamed files in the current directory, its parent and nearby subdirectories.
It stays within the configured scan root when the source is inside one; for external sources it
ascends at most one level. The walk visits at most 64 directories and 2,000 entries, to depth two
below its root. Hidden paths, symlinks, partial downloads and other standalone weight formats are
excluded. Directories already holding the destination are skipped when importing from elsewhere.
Both limits and unexplored deeper directories set the incomplete-search indicator. The combined
result offers at most 200 matching files, without cutting a split group in half.

This works from either a root-level single GGUF or a shard in a quantization subdirectory, finding
root companions, sibling quantizations and nested MTP/projector files. Incomplete local groups are
not offered. Support files require matching basenames as well as content; GGUF groups can be renamed.
Relative source paths distinguish identically named files in different local directories. Matching
mmproj/draft/imatrix files are companions; other matching model quants are optional variants.
Nothing is selected automatically. Companion originals are kept by default: they are copied
independently, retaining existing references for other models. Turning that option off moves
companions and updates references. Selected variants move as complete groups. Import locks and
queue overlap checks cover every selected source directory; file identities and symlink-free
source paths are rechecked before publication.

Whole-directory scope includes configuration, tokenizer and local companions and is the default
for safetensors; GGUF users may explicitly choose it for a dedicated model folder. The optional
repository subdirectory maps that folder beneath the repo root. Indexed and conventionally named
safetensors shards must be complete. Every weight must match upstream, as must directory companions
present upstream; companions absent upstream are retained but not recorded as verified/downloadable
files. Symbolic links, special files and source directories containing an arriero manifest are
refused. Destination collisions are refused, and an existing destination manifest must belong to
the selected repository. Files already at their final paths can be registered in place.

`GET /api/hf/imports` lists up to 20 in-memory operations; `GET /api/hf/imports/:id` exposes progress,
verified candidates, neighboring files, selection and blockers. `POST /api/hf/imports/select`
changes the selected candidate, neighbor groups, copy policy or verified path alternatives and
rechecks availability. Search and verification are allowed while models run: live-process and
destination blockers remain visible on a ready preview. `POST /api/hf/imports/commit` is the explicit
filesystem action; `POST /api/hf/imports/cancel` aborts a search or an uncommitted import. Closing
or navigating away from the dialog leaves the background operation available to reopen. A manager
restart drops previews and requires verification again. Search and import use the shutdown registry.

Commit rechecks source inventory/identity, destination safety and overlapping downloads. It stages
hard links for moves on the same filesystem or copies across filesystems; requested companion
copies always get independent content. Exclusive links publish the staged files before writing the
manifest and updating saved instance/preset paths. Live local instances (including affected managed
presets) block moves; active, queued or paused downloads block overlapping destinations. Import locks
also block download enqueue and library deletion. Originals are removed only after publication,
manifest creation and reference updates succeed, with another source identity check before unlink.
Pre-commit failures roll back publication and reference changes; if reference rollback fails,
both copies remain. Failed source cleanup leaves duplicates and a warning. Hard termination can
leave staging or published duplicates; source content remains until its destination is registered.
External scripts are not rewritten.

Manifests record `importedAt` and `acquisition: imported` (or `mixed` when adding to a manifest);
`downloadedAt` remains the legacy registration timestamp. Verified imported files participate in
update checks, integrity checks and model library; import does not fabricate a download job.

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
token is sent as `Authorization: Bearer`; the download transport explicitly removes it on a
cross-origin CDN redirect.

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /api/hf/token`, `PUT /api/hf/token` | write-only token surface |
| `GET /api/hf/browse?repo=&revision=` | repo info + tree + GGUF variants |
| `GET /api/hf/dest-check?dir=` / `?repo=` | free space + inside-scan-roots for a destination |
| `POST /api/hf/downloads` | enqueue a download job (201; 409 only for insufficient space) |
| `GET /api/hf/downloads` | downloaded repos from manifest discovery (+ `partialBytes`, `orphanParts`) |
| `POST /api/hf/downloads/check` | manual update check for up to 50 dirs |
| `POST /api/hf/downloads/integrity` | offline size and checksum verification against the local manifest |
| `POST /api/hf/downloads/delete` | delete a repo directory, selected files or orphan parts, optional upstream verify |
| `GET /api/hf/queue` | queue state: active job with live progress, queued jobs, history |
| `POST /api/hf/queue/reorder` | reorder queued jobs (`ids` = the complete new order) |
| `POST /api/hf/queue/:id/cancel` | cancel the active job (parts kept for resume) |
| `POST /api/hf/queue/:id/pause` | pause the active or a queued job (parts kept) |
| `POST /api/hf/queue/:id/resume` | re-queue a paused job (`{ignoreSlowEta: true}` disables the ETA policy for it) |
| `DELETE /api/hf/queue/:id` | remove a queued job or dismiss a history entry |
| `POST /api/hf/queue/:id/files/skip` | skip files of the active job / drop files from a queued one |
| `DELETE /api/hf/queue/history` | clear the finished-job history |
| `GET/PUT /api/hf/download-settings` | default model-directory selection + max ETA hours |

Every mutating queue endpoint returns the full queue state so the UI applies it without a
follow-up fetch.

Upstream HF errors map to: 403 (`unauthorized` and `gated`), 404, 429, 502; our own 401 stays
reserved for the admin session (`requireAdmin`). Note HF answers anonymous requests for
nonexistent repos with 401 rather than 404 (it hides repo existence), so the `unauthorized`
message covers both "repo not found" and "token missing/invalid".
