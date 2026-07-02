#!/usr/bin/env bash
set -euo pipefail

# Reverses scripts/install-service.sh: stops and disables the systemd --user
# unit and deletes the generated unit file. See docs/SELF_UPDATE.md.
#
# Run as the user that installed the service (NOT root):
#   ./scripts/uninstall-service.sh [--disable-linger]
#
# Linger is left enabled by default because other --user services may rely on
# it; pass --disable-linger to turn it off too.

UNIT_NAME="llama-manager.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/$UNIT_NAME"
DISABLE_LINGER=false

for arg in "$@"; do
  case "$arg" in
    --disable-linger) DISABLE_LINGER=true ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--disable-linger]" >&2
      exit 1
      ;;
  esac
done

if [[ $EUID -eq 0 ]]; then
  echo "Refusing to run as root: the unit was installed as a --user unit." >&2
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

if systemctl --user list-unit-files "$UNIT_NAME" --no-legend 2>/dev/null | grep -q .; then
  systemctl --user disable --now "$UNIT_NAME"
  echo "Stopped and disabled $UNIT_NAME"
else
  echo "$UNIT_NAME is not installed for this user; nothing to stop."
fi

if [[ -f "$UNIT_PATH" ]]; then
  rm "$UNIT_PATH"
  echo "Removed $UNIT_PATH"
else
  echo "No unit file at $UNIT_PATH"
fi

systemctl --user daemon-reload
systemctl --user reset-failed "$UNIT_NAME" 2>/dev/null || true

if [[ "$DISABLE_LINGER" == true ]]; then
  if loginctl disable-linger "$USER" 2>/dev/null; then
    echo "Disabled linger for $USER"
  else
    echo "warning: could not disable linger (needs privilege on this host)." >&2
    echo "  run once:  sudo loginctl disable-linger $USER" >&2
  fi
else
  echo "Linger left as-is (pass --disable-linger to turn it off)."
fi

echo
echo "llama-manager is no longer supervised by systemd --user."
echo "Managed llama-server children survive the manager by default; check with:"
echo "  pgrep -a llama-server"
echo "They will be re-adopted if you start the manager again (pnpm serve)."
