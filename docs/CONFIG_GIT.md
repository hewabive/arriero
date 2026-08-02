# Configuration Git workflow

The portable configuration root is a standalone Git working tree managed from
the **Configuration Git** page. Runtime state, models, logs, build trees, Python
environments, the SQLite database, and proxy request artifacts remain outside
this repository.

## Two entry points

The configuration directory can enter version control from either direction.

**Initialize** (`POST /api/config-git/init`) runs `git init` in place and
commits the files that are already there, without an origin. Nothing in the
working tree is rewritten, so this is the only tree-changing operation that is
allowed while managed processes run. A missing `.gitignore` is written,
`.secrets.json` is excluded, the root is validated before the repository is
created, and a failed initial commit removes the `.git` directory again so the
operation leaves no half-initialized state. Origin can be attached later with
`POST /api/config-git/remote`; the first `push` sets upstream.

**Clone** (`POST /api/config-git/clone`) is a full replacement: the current
configuration — including a repository with its history — is discarded and
another repository is adopted in its place. It requires `replaceExisting`, and
additionally `discardUnpushed` when the current tree is dirty or holds commits
that exist on no upstream (`status.hasUnpushedCommits`).

Bootstrap on a temporary server:

1. Clone and build arriero.
2. Copy `.env.example` to the gitignored `.env`.
3. Set `ARRIERO_ADMIN_PASSWORD_HASH` and
   `ARRIERO_AUTH_SECRET`. Set `ARRIERO_CONFIG_DIR` and runtime path
   overrides when the defaults are unsuitable.
4. Start the supervised production service.
5. Open **Configuration Git** and either initialize the generated bootstrap
   files locally, or enter the SSH/HTTPS origin and replace them by cloning.

Clone happens in a sibling staging directory. The candidate is schema-checked,
cross-file references and pipeline graphs are validated, tracked secret files
and symlinks are rejected, and only then is it moved into place. The replaced
directory is retained as `<configDir>.backup-<timestamp>` so it can be
recovered manually; those backups are listed in `status.backups` and are never
deleted automatically. An existing local `.secrets.json` and the machine-local
files below are copied into the new working tree (machine files only when the
remote does not track them) and excluded through `.git/info/exclude` even when
the remote does not provide a `.gitignore`.

## Machine-local files

`path-catalog.json` and `envs.json` describe state of the current machine, not
portable configuration: catalog entries are rewritten automatically by build
completion and by the environment reconciler at startup, and environment specs
carry ids of local catalog entries. Both files are therefore gitignored
(`config-git/machine-state.ts` owns the list) and keep their
`createdAt`/`updatedAt` fields — unlike tracked files, whose provenance is the
commit history.

The startup normalizer `untrackMachineStateFiles()` appends the missing
`.gitignore` entries and, when a legacy repository still tracks these files,
stages their removal with `git rm --cached`. The staged deletion is visible on
the Configuration Git page and lands in the next commit; branch-changing
operations are blocked by the dirty tree until then. Because the files are
ignored afterwards, routine builds and restarts no longer dirty the tree.

Tree-changing operations (`pull`, `switch`, `branches`, `checkout`) snapshot
the machine-local files before running git and write them back afterwards when
the new HEAD does not track them. Checking out a legacy commit that still
tracks these files materializes the committed (stale) copies instead — the
catalog regenerates at the next build or startup, and instances fall back to
their inline `binaryPath`. Cross-file validation deliberately does not check
`binaryPathRefId`/`pathCatalogEntryId` against the catalog: those ids are
machine-local and dangling references degrade gracefully at runtime.

## Origin

Setting an origin removes and re-adds the remote, which drops the previous
remote-tracking branches and upstream links instead of leaving them pointing at
a repository that is no longer there. A `null` origin removes the remote and
leaves a purely local repository. The new origin is fetched right away when
requested; a failing fetch is reported in the operation output but does not
undo the change.

Attaching an origin that already has unrelated history makes `push` fail as
non-fast-forward. There is no force push in the UI — adopting that history is
the replacement path above.

## Branch model

`main` can hold the common configuration and hardware branches can hold complete
machine profiles. Git branches are snapshots, not overlays: later changes to
`main` reach an existing hardware branch only through an explicit merge or
rebase performed outside the current UI.

The UI lists local and fetched `origin` branches. Selecting a remote-only branch
creates a tracking local branch. Checking out a historical commit produces a
detached HEAD; create a branch before committing or pushing further changes.

Pull is implemented as `fetch origin`, validation of the upstream commit in a
detached temporary worktree, and a fast-forward-only merge. Divergence is never
merged automatically. Configuration-changing operations are refused while a
managed inference process, build, or environment installation is active. On
success all portable-config caches are invalidated together. Existing managed
processes must be stopped before changing trees so an instance cannot disappear
from the active configuration while its process is still running.

## Secrets and credentials

The following values never belong in the configuration repository:

- admin password/hash and cookie signing secret;
- external provider API keys;
- fleet node tokens;
- Git private keys, PATs, PEM files, or credential-bearing remote URLs.

Tracked endpoint records may contain `apiKeyEnvVar`; put its value in the local
process environment, `.env`, a systemd `EnvironmentFile`, cloud-init, or a
secret manager. Keys entered through the endpoint/source UI are stored in the
gitignored `.secrets.json` and must be transferred separately when needed.

Use an SSH agent or a repository-scoped read/write deploy key for private Git
origins. Clone accepts only credential-free HTTPS URLs, `ssh://` URLs, and SCP
style SSH locations. Git runs without terminal prompts or repository hooks, and
credentials are redacted from returned command output: the whole userinfo for
non-SSH URLs, because an HTTPS token is usually carried as the user name, but
only the password for `ssh://`, where the login name authenticates nothing and
hiding it would just misreport the configured origin. A displayed origin that
was redacted is marked `status.originRedacted` so the UI does not offer it back
as an editable value.

## Reset semantics

Discard changes always performs `git reset --hard HEAD` for tracked files. The
separate **also delete untracked files** option additionally performs
`git clean -fd`. Ignored files are not deleted, so `.secrets.json` remains in
place. The target commit is validated before reset and the resulting working
tree is validated again afterward.

## API

- `GET /api/config-git/status`, `/diff`, `/log`, `/validation`
- `GET /api/config-git/commits/:commit`
- `POST /api/config-git/init`, `/remote`, `/clone`
- `POST /api/config-git/fetch`, `/pull`, `/switch`, `/checkout`
- `POST /api/config-git/branches`, `/reset`, `/commit`, `/push`

All routes are administrative `/api/*` routes and support the existing active
node reverse proxy, so the page operates on the node selected in the header.
They carry no extra listener gate beyond `requireAdmin` — like every other
configuration page, exposure is governed solely by whether admin auth is
configured.
