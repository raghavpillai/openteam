#!/usr/bin/env bash
set -euo pipefail

image=${1:?Usage: bash scripts/test-computer-image.sh IMAGE}
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
container="openteam-computer-capabilities-test-$$"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Use an isolated container: no user credentials, persistent volumes or published ports.
docker run -d --name "$container" --network none --cap-drop ALL \
  --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETGID --cap-add SETUID \
  --tmpfs /tmp:rw,noexec,nosuid,size=512m \
  -e OPENTEAM_CONTROL_TOKEN=capabilities-test-only \
  -e OPENTEAM_COMPUTER_TEST_URL=http://127.0.0.1:8790 \
  --mount "type=bind,source=$repo_root/apps/computer/test/task-capabilities.integration.test.ts,target=/tmp/task-capabilities.integration.test.ts,readonly" \
  "$image" >/dev/null

if ! docker exec "$container" bun test /tmp/task-capabilities.integration.test.ts; then
  docker logs --tail 50 "$container"
  exit 1
fi

# Verify the default bot user can install a package, including its root setup script.
docker exec --user 1001:1000 "$container" sh -ec '
  test "$(sudo -n id -u)" = 0
  umask 022
  package=$(mktemp -d)
  mkdir "$package/DEBIAN"
  chmod 755 "$package" "$package/DEBIAN"
  printf "Package: openteam-smoke\nVersion: 1.0\nArchitecture: all\nMaintainer: Test <test@example.invalid>\nDescription: Computer smoke test\n" > "$package/DEBIAN/control"
  printf "#!/bin/sh\nid -u > /etc/openteam-smoke\n" > "$package/DEBIAN/postinst"
  chmod 755 "$package/DEBIAN/postinst"
  dpkg-deb --build "$package" "$package.deb" >/dev/null
  sudo -n apt-get install -y -qq "$package.deb" >/dev/null
  test "$(cat /etc/openteam-smoke)" = 0
'
