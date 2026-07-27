#!/usr/bin/env bash
set -euo pipefail

TARGET_USER="${1:-${SUDO_USER:-}}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo $0 <user-that-runs-arriero>" >&2
  exit 1
fi

if [[ -z "$TARGET_USER" ]]; then
  echo "Usage: sudo $0 <user-that-runs-arriero>" >&2
  exit 1
fi

if ! id "$TARGET_USER" >/dev/null 2>&1; then
  echo "Unknown user: $TARGET_USER" >&2
  exit 1
fi

if [[ "$(stat -fc %T /sys/fs/cgroup 2>/dev/null || true)" != "cgroup2fs" ]]; then
  echo "cgroup v2 unified is not mounted at /sys/fs/cgroup." >&2
  echo "On RHEL/Rocky 8 boot with systemd.unified_cgroup_hierarchy=1, then re-run." >&2
  exit 1
fi

if ! grep -qw cpuset /sys/fs/cgroup/cgroup.controllers; then
  echo "The cpuset controller is not available at the root cgroup (kernel too old?)." >&2
  exit 1
fi

UID_N="$(id -u "$TARGET_USER")"
DROPIN_DIR=/etc/systemd/system/user@.service.d
DROPIN_FILE="$DROPIN_DIR/delegate-cpuset.conf"

install -d -m 0755 "$DROPIN_DIR"
cat >"$DROPIN_FILE" <<'CONF'
[Service]
Delegate=cpu cpuset memory pids
CONF
echo "Wrote $DROPIN_FILE"

systemctl daemon-reload
echo "Reloaded systemd unit files."

loginctl enable-linger "$TARGET_USER"
echo "Enabled linger for $TARGET_USER (uid $UID_N)."

ROOT=/sys/fs/cgroup
USER_SLICE="$ROOT/user.slice/user-$UID_N.slice"
USER_AT="$USER_SLICE/user@$UID_N.service"
SUBTREE="$USER_AT/cgroup.subtree_control"

for dir in "$ROOT" "$ROOT/user.slice" "$USER_SLICE" "$USER_AT"; do
  if [[ -e "$dir/cgroup.subtree_control" ]] &&
    ! grep -qw cpuset "$dir/cgroup.subtree_control"; then
    echo +cpuset >"$dir/cgroup.subtree_control" 2>/dev/null || true
  fi
done

echo
if [[ -r "$SUBTREE" ]] && grep -qw cpuset "$SUBTREE"; then
  echo "OK: cpuset is delegated and enabled for $TARGET_USER's child cgroups."
  echo "arriero will report numaEnforcement = cgroup-v2 (no re-login needed)."
else
  echo "Delegation is written, but cpuset could not be enabled live on the"
  echo "running user manager (cgroup.subtree_control still lacks it)."
  echo "A Delegate= change only applies when user@$UID_N.service (re)starts, and"
  echo "with linger enabled a logout/login does NOT restart it. Activate with:"
  echo "  systemctl restart user@$UID_N.service   # kills $TARGET_USER's session processes"
  echo "or reboot. (A plain re-login is not enough here.)"
  echo
  echo "Verify afterwards:"
  echo "  grep -w cpuset $SUBTREE   # cpuset should be listed"
fi

echo
echo "This assumes arriero runs as user $TARGET_USER (user session)."
echo "If it runs as a system service, add Delegate=cpu cpuset memory pids to"
echo "that unit instead. See docs/NUMA_PINNING.md."
