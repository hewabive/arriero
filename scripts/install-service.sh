#!/usr/bin/env bash
set -euo pipefail

# Installs arriero as a systemd --user service so the UI "Update" button can
# self-restart the process after a build. See docs/SELF_UPDATE.md.
#
# Run as the user that owns the checkout (NOT root):
#   ./scripts/install-service.sh

UNIT_NAME="arriero.service"
LEGACY_UNIT_NAME="llama-manager.service"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$REPO_DIR/deploy/$UNIT_NAME"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/$UNIT_NAME"
LEGACY_UNIT_PATH="$UNIT_DIR/$LEGACY_UNIT_NAME"

if [[ $EUID -eq 0 ]]; then
  echo "Refusing to run as root: install as a --user unit owned by your account." >&2
  exit 1
fi

# systemctl --user needs the user bus; su-style logins lack the session env vars.
RUNTIME_DIR="/run/user/$(id -u)"
if [[ -z "${XDG_RUNTIME_DIR:-}" && -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]]; then
  if [[ -d "$RUNTIME_DIR" ]]; then
    export XDG_RUNTIME_DIR="$RUNTIME_DIR"
  else
    echo "error: no user runtime dir at $RUNTIME_DIR — systemctl --user cannot reach the user bus." >&2
    echo "  the systemd user manager is not running for this account; start it once:" >&2
    echo "    sudo systemctl start user@$(id -u).service" >&2
    echo "  or log in directly as $USER (not via su) and re-run this script." >&2
    exit 1
  fi
fi

NODE_BIN="$(command -v node || true)"
PNPM_BIN="$(command -v pnpm || true)"
GIT_BIN="$(command -v git || true)"

for name in node pnpm git; do
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "Required command not found on PATH: $name" >&2
    exit 1
  fi
done

if [[ ! -f "$REPO_DIR/apps/api/dist/index.js" ]]; then
  echo "Build output missing; running 'pnpm build' first ..."
  (cd "$REPO_DIR" && pnpm build)
fi

# The unit's PATH must let the update job find node/pnpm/git when it shells out.
SERVICE_PATH="$(dirname "$NODE_BIN"):$(dirname "$PNPM_BIN"):$(dirname "$GIT_BIN"):/usr/local/bin:/usr/bin:/bin"

mkdir -p "$UNIT_DIR"
sed \
  -e "s#@REPO_DIR@#${REPO_DIR}#g" \
  -e "s#@NODE_BIN@#${NODE_BIN}#g" \
  -e "s#@PATH@#${SERVICE_PATH}#g" \
  "$TEMPLATE" >"$UNIT_PATH"

echo "Wrote $UNIT_PATH"

# Keep the user manager (and the service) running without an active login session.
# Linger writes to a root-owned dir, so on a headless host this is the one step
# that may need privilege; everything else here is sudo-free.
if [[ "$(loginctl show-user "$USER" --property=Linger --value 2>/dev/null)" == "yes" ]]; then
  echo "Linger already enabled for $USER"
elif loginctl enable-linger "$USER" 2>/dev/null; then
  echo "Enabled linger for $USER"
else
  echo "warning: could not enable linger (needs privilege on this host)." >&2
  echo "  run once:  sudo loginctl enable-linger $USER" >&2
  echo "  without it the service stops when you log out." >&2
fi

# Managed children survive the stop (KillMode=process + survive-by-default) and
# are re-adopted when the renamed unit starts.
if [[ -f "$LEGACY_UNIT_PATH" ]]; then
  echo "Migrating from $LEGACY_UNIT_NAME ..."
  systemctl --user disable --now "$LEGACY_UNIT_NAME" 2>/dev/null || true
  rm -f "$LEGACY_UNIT_PATH"
  systemctl --user reset-failed "$LEGACY_UNIT_NAME" 2>/dev/null || true
fi

systemctl --user daemon-reload
systemctl --user enable --now "$UNIT_NAME"

echo
echo "arriero is now supervised by systemd --user."
echo "  status:  systemctl --user status $UNIT_NAME"
echo "  logs:    journalctl --user -u $UNIT_NAME -f"
echo "The UI Update button can now self-restart this node after a build."
