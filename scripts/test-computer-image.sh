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

# Match the observed Grok root capability mask and verify VPN device access.
docker exec -i --user 1001:1000 "$container" sudo -n python3 - <<'PY'
import fcntl, pathlib, struct, subprocess, tempfile
status = dict(line.split(':', 1) for line in pathlib.Path('/proc/self/status').read_text().splitlines())
full = (1 << (int(pathlib.Path('/proc/sys/kernel/cap_last_cap').read_text()) + 1)) - 1
assert int(status['CapEff'], 16) == int(status['CapBnd'], 16) == full
assert int(status['NoNewPrivs']) == int(status['Seccomp']) == 0
gateway = pathlib.Path('/proc/1/task/1/children').read_text().split()[0]
assert f'CapInh:\t{full:016x}' in pathlib.Path(f'/proc/{gateway}/status').read_text()
for target in ['/proc/sys', '/sys', '/sys/fs/cgroup']:
    options = subprocess.check_output(['findmnt', '-T', target, '-no', 'OPTIONS'], text=True).strip().split(',')
    assert 'rw' in options and 'ro' not in options, (target, options)
with open('/dev/net/tun', 'r+b', buffering=0) as tun:
    fcntl.ioctl(tun, 0x400454ca, struct.pack('16sH', b'parity%d', 0x1001))
with tempfile.TemporaryDirectory() as directory:
    script = pathlib.Path(directory) / 'executable'
    script.write_text('#!/bin/sh\nexit 0\n')
    script.chmod(0o755)
    subprocess.run([str(script)], check=True)
PY
