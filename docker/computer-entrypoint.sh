#!/bin/sh
set -eu

agent_dir=${OPENTEAM_PI_AGENT_DIR:-/home/box/.pi/agent}
data_root=${OPENTEAM_AGENT_DATA_CANONICAL_ROOT:-/home/box/sand-data}
data_alias=${OPENTEAM_AGENT_DATA_ROOT:-/home/box/agent-data}
agent_uid=${OPENTEAM_AGENT_UID:-1001}
agent_gid=${OPENTEAM_AGENT_GID:-1000}
# Keep ordinary commands non-root; allow administrator commands through sudo.
case "$agent_uid" in
  ''|0|*[!0-9]*) echo "invalid OPENTEAM_AGENT_UID" >&2; exit 1 ;;
esac
printf '#%s ALL=(ALL:ALL) NOPASSWD: ALL\n' "$agent_uid" > /etc/sudoers.d/openteam-runner
chown 0:0 /etc/sudoers.d/openteam-runner
chmod 0440 /etc/sudoers.d/openteam-runner
visudo -cf /etc/sudoers.d/openteam-runner >/dev/null

umask 0007

mkdir -p "$agent_dir"
mkdir -p "$data_root" /workspace
# Deck working folders are made with mktemp under this directory.
mkdir -p /workspace/slides
mkdir -p /home/box/Downloads /home/box/Documents
chown "$agent_uid:$agent_gid" /home/box/Downloads /home/box/Documents
chmod 2770 /home/box/Downloads /home/box/Documents

# The runner needs ordinary package caches and LibreOffice profile storage.
# Older volumes may have these parents owned by the desktop UID with mode 0700.
# Grant traversal only on the parents; do not recursively expose .local/share
# or the supervisor-owned credential directories.
for runner_dir in /home/box/.local /home/box/.cache /home/box/.local/lib /home/box/.local/bin /home/box/.cache/pip /home/box/.cache/uv /home/box/.cache/fontconfig /home/box/.cache/dconf /home/box/.config /home/box/.config/libreoffice; do
  if [ -L "$runner_dir" ]; then
    echo "refusing redirected runner package directory: $runner_dir" >&2
    exit 1
  fi
done
mkdir -p /home/box/.local /home/box/.cache /home/box/.config
chgrp "$agent_gid" /home/box/.local /home/box/.cache /home/box/.config
chmod g+x /home/box/.local /home/box/.cache /home/box/.config
for runner_dir in /home/box/.local/lib /home/box/.local/bin /home/box/.cache/pip /home/box/.cache/uv /home/box/.cache/fontconfig /home/box/.cache/dconf /home/box/.config/libreoffice; do
  mkdir -p "$runner_dir"
  chown -R "$agent_uid:$agent_gid" "$runner_dir"
  chmod 2770 "$runner_dir"
done

# The inference supervisor owns Pi credentials. Agent-launched shells and GUI
# processes start as runner and share workspace, agent-data, and browser state
# through the box group. Runner can access these credentials through sudo;
# these permissions prevent accidental access but do not isolate them from bots.
chown -R 0:"$agent_gid" "$agent_dir"
chmod 0700 "$agent_dir"
find "$agent_dir" -maxdepth 1 -type f \( -name 'auth.json' -o -name 'models.json' \) -exec chmod 0600 {} \;
chgrp -R "$agent_gid" /home/box "$data_root" /workspace
chmod 0770 /home/box "$data_root" /workspace
chmod -R g+rwX "$data_root" /workspace

if [ -L "$data_alias" ]; then
  current_target=$(readlink "$data_alias")
  if [ "$current_target" != "$data_root" ]; then
    rm "$data_alias"
  fi
elif [ -d "$data_alias" ]; then
  if [ -n "$(ls -A "$data_alias")" ]; then
    echo "refusing to replace non-empty agent-data directory: $data_alias" >&2
    exit 1
  fi
  rmdir "$data_alias"
elif [ -e "$data_alias" ]; then
  echo "refusing to replace non-directory agent-data path: $data_alias" >&2
  exit 1
fi

if [ ! -L "$data_alias" ]; then
  ln -s "$data_root" "$data_alias"
fi

cd /workspace

# Match the writable kernel filesystems inside the bot computer's namespaces.
mount -o remount,rw /sys
mount -o remount,rw /sys/fs/cgroup
# Preserve the full inheritable capability set when shells/GUI drop to runner.
exec setpriv --inh-caps +all "$@"
