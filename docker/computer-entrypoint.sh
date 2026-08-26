#!/bin/sh
set -eu

agent_dir=${OPENBOT_PI_AGENT_DIR:-/home/openbot/.pi/agent}
mkdir -p "$agent_dir"

exec "$@"
