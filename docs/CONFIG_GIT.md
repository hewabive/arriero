# Configuration Git workflow

The portable configuration root is a standalone Git working tree managed from
the **Configuration Git** page. Runtime state, models, logs, build trees, Python
environments, the SQLite database, and proxy request artifacts remain outside
this repository.

## Bootstrap on a temporary server

1. Clone and build arriero.
2. Copy `.env.example` to the gitignored `.env`.
3. Set `ARRIERO_ADMIN_PASSWORD_HASH` and
   `ARRIERO_AUTH_SECRET`. Set `ARRIERO_CONFIG_DIR` and runtime path
   overrides when the defaults are unsuitable.
4. Start the supervised production service.
5. Open **Configuration Git**, enter the SSH or HTTPS origin, confirm replacing
   the generated bootstrap files, and clone.

Clone happens in a sibling staging directory. The candidate is schema-checked,
cross-file references and pipeline graphs are validated, tracked secret files
and symlinks are rejected, and only then is it moved into place. The generated
bootstrap directory is retained as `<configDir>.backup-<timestamp>` so it can
be recovered manually. An existing local `.secrets.json` is copied into the
new working tree and excluded through `.git/info/exclude` even when the remote
does not provide a `.gitignore`.

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
credentials are redacted from returned command output.

## Reset semantics

Discard changes always performs `git reset --hard HEAD` for tracked files. The
separate **also delete untracked files** option additionally performs
`git clean -fd`. Ignored files are not deleted, so `.secrets.json` remains in
place. The target commit is validated before reset and the resulting working
tree is validated again afterward.

## API

- `GET /api/config-git/status`, `/diff`, `/log`, `/validation`
- `GET /api/config-git/commits/:commit`
- `POST /api/config-git/clone`, `/fetch`, `/pull`, `/switch`, `/checkout`
- `POST /api/config-git/branches`, `/reset`, `/commit`, `/push`

All routes are administrative `/api/*` routes and support the existing active
node reverse proxy, so the page operates on the node selected in the header.
When the API listens on a non-loopback address, the config Git routes refuse
all requests until an admin password or password hash is configured.
