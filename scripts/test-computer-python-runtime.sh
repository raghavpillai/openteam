#!/usr/bin/env bash
set -euo pipefail
image=${1:?Usage: bash scripts/test-computer-python-runtime.sh IMAGE}

# Isolated, offline containers: no credentials, host mounts, or published ports.
docker run --rm -i --network none --entrypoint sh "$image" <<'CONTAINER'
set -eu
mkdir -p /home/box/.local/share/private /home/box/.cache /home/box/.pi/agent
chmod 700 /home/box/.local /home/box/.cache /home/box/.local/share/private
printf synthetic > /home/box/.pi/agent/auth.json
printf synthetic > /home/box/.local/share/private/token
cat > /tmp/runner-check.sh <<'RUNNER'
set -eu
test ! -r /home/box/.pi/agent/auth.json
test ! -r /home/box/.local/share/private/token
for path in /home/box/.local/lib /home/box/.local/bin /home/box/.cache/pip /home/box/.cache/uv; do
  touch "$path/probe"
done
python3 -m venv /workspace/qa-venv
/workspace/qa-venv/bin/python -m pip --version
printf 'Runner package paths, venv and credential isolation passed\n'
RUNNER
exec /usr/local/bin/openteam-computer-entrypoint runuser -u runner -- sh /tmp/runner-check.sh
CONTAINER

docker run --rm -i --network none --entrypoint sh "$image" <<'CONTAINER'
set -eu
mkdir -p /home/box/.cache /home/box/.pi/agent
chmod 700 /home/box/.pi/agent
ln -s /home/box/.pi/agent /home/box/.cache/pip
if /usr/local/bin/openteam-computer-entrypoint true; then
  echo 'Unexpectedly accepted a redirected package directory' >&2
  exit 1
fi
test "$(stat -c %a /home/box/.pi/agent)" = 700
printf 'Redirected package directory rejected without exposing target\n'
CONTAINER
