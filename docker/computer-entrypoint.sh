#!/bin/sh
set -eu

agent_dir=${OPENBOT_PI_AGENT_DIR:-/home/box/.pi/agent}
data_root=${OPENBOT_AGENT_DATA_CANONICAL_ROOT:-/home/box/sand-data}
data_alias=${OPENBOT_AGENT_DATA_ROOT:-/home/box/agent-data}

mkdir -p "$agent_dir"
mkdir -p "$data_root" /workspace

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
