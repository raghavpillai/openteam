#!/bin/sh
set -eu

agent_dir=${OPENTEAM_PI_AGENT_DIR:-/home/box/.pi/agent}
data_root=${OPENTEAM_AGENT_DATA_CANONICAL_ROOT:-/home/box/sand-data}
data_alias=${OPENTEAM_AGENT_DATA_ROOT:-/home/box/agent-data}
agent_uid=${OPENTEAM_AGENT_UID:-1000}
agent_gid=${OPENTEAM_AGENT_GID:-1000}
# Keep ordinary commands non-root; allow administrator commands through sudo.
case "$agent_uid" in
  ''|0|*[!0-9]*) echo "invalid OPENTEAM_AGENT_UID" >&2; exit 1 ;;
esac
printf '#%s ALL=(ALL:ALL) NOPASSWD: ALL\n' "$agent_uid" > /etc/sudoers.d/openteam-runner
chown 0:0 /etc/sudoers.d/openteam-runner
chmod 0440 /etc/sudoers.d/openteam-runner

umask 0022

mkdir -p "$agent_dir"
mkdir -p "$data_root" /workspace
# Deck working folders are made with mktemp under this directory.
mkdir -p /workspace/slides
mkdir -p /home/box/Downloads /home/box/Documents
# Migrate the former runner's files without changing modes or following symlinks.
find /home/box "$data_root" /workspace -uid 1001 -exec chown -h "$agent_uid:$agent_gid" {} +
chown "$agent_uid:$agent_gid" /home/box "$data_root" /workspace /workspace/slides /home/box/Downloads /home/box/Documents
chmod 0700 /home/box "$data_root"
chmod 0755 /workspace /workspace/slides /home/box/Downloads /home/box/Documents

# The supervisor owns credentials; bot processes start as box but can read
# these files through sudo. File ownership is not an isolation boundary.
chown -R 0:"$agent_gid" "$agent_dir"
chmod 0700 "$agent_dir"
find "$agent_dir" -maxdepth 1 -type f \( -name 'auth.json' -o -name 'models.json' \) -exec chmod 0600 {} \;

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
# Preserve the full inheritable capability set when shells/GUI drop to box.
exec setpriv --inh-caps +all "$@"
