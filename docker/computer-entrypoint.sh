#!/bin/sh
set -eu

agent_dir=${OPENBOT_PI_AGENT_DIR:-/home/box/.pi/agent}
data_root=${OPENBOT_AGENT_DATA_CANONICAL_ROOT:-/home/box/sand-data}
data_alias=${OPENBOT_AGENT_DATA_ROOT:-/home/box/agent-data}
agent_uid=${OPENBOT_AGENT_UID:-1001}
agent_gid=${OPENBOT_AGENT_GID:-1000}

umask 0007

mkdir -p "$agent_dir"
mkdir -p "$data_root" /workspace

# The inference supervisor owns Pi credentials. Agent-launched shells and GUI
# processes run as the unprivileged runner identity and share only workspace,
# agent-data, and browser state through the box group.
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

exec "$@"
