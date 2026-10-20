#!/usr/bin/env bash
set -euo pipefail

image=${1:?Usage: bash scripts/test-computer-image.sh IMAGE}
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
container="openteam-computer-capabilities-test-$$"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Use an isolated container: no user credentials, persistent volumes or published ports.
docker run -d --name "$container" --network none --cap-add ALL \
  --security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt label=disable \
  --security-opt systempaths=unconfined --device /dev/net/tun:/dev/net/tun \
  -e OPENTEAM_CONTROL_TOKEN=capabilities-test-only \
  -e OPENTEAM_COMPUTER_TEST_URL=http://127.0.0.1:8790 \
  --mount "type=bind,source=$repo_root/apps/computer/test/task-capabilities.integration.test.ts,target=/tmp/task-capabilities.integration.test.ts,readonly" \
  "$image" >/dev/null

if ! docker exec "$container" bun test /tmp/task-capabilities.integration.test.ts; then
  docker logs --tail 50 "$container"
  exit 1
fi

# Bot shells can elevate and the VPN device is available.
docker exec --user 1000:1000 "$container" sudo -n sh -ec 'test "$(id -u)" = 0; test -c /dev/net/tun'
