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
  -e OPENTEAM_TEST_TIME_ZONE=Asia/Kolkata \
  --mount "type=bind,source=$repo_root/apps/computer/test/task-capabilities.integration.test.ts,target=/tmp/task-capabilities.integration.test.ts,readonly" \
  --mount "type=bind,source=$repo_root/apps/computer/test/box-clock.integration.test.ts,target=/tmp/box-clock.integration.test.ts,readonly" \
  "$image" >/dev/null

if ! docker exec "$container" bun test /tmp/task-capabilities.integration.test.ts /tmp/box-clock.integration.test.ts; then
  docker logs --tail 50 "$container"
  exit 1
fi

# Bot shells can elevate and the VPN device is available.
docker exec --user 1000:1000 "$container" sudo -n sh -ec 'test "$(id -u)" = 0; test -c /dev/net/tun'

# Runtime isolation in offline containers (no credentials, host mounts, or published ports):
# the runner user can't read private config or agent credentials, package and office caches are
# writable, and a cache or profile path redirected into private storage is refused at startup.
docker run --rm -i --network none --entrypoint sh "$image" <<'CONTAINER'
set -eu
mkdir -p /home/box/.local/share/private /home/box/.cache /home/box/.pi/agent
chmod 700 /home/box/.local/share/private
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
exec /usr/lib/openteam/bin/openteam-computer-entrypoint runuser -u runner -- sh /tmp/runner-check.sh
CONTAINER

docker run --rm -i --network none --entrypoint sh "$image" <<'CONTAINER'
set -eu
# /usr/local is kept and shared by every bot, so one bot's copy of a system tool there
# mustn't replace it in login shells either.
printf '#!/bin/sh\necho bot copy\n' > /usr/local/bin/python3
chmod 0755 /usr/local/bin/python3
for shell in "bash -lc" "sudo -i sh -c" "su - -c" "su - box -c" "runuser -u box -- bash -lc"; do
  found=$($shell 'command -v python3')
  test "$found" = /usr/bin/python3 || { echo "$shell finds $found" >&2; exit 1; }
done
printf 'Login shells find the system tools before /usr/local\n'
CONTAINER

docker run --rm -i --network none --entrypoint sh "$image" <<'CONTAINER'
set -eu
mkdir -p /home/box/.config/private /workspace/office-qa
chmod 700 /home/box/.config/private
printf synthetic > /home/box/.config/private/token
printf 'name,amount\nAlpha,12\nBeta,8\n' > /workspace/office-qa/input.csv
chown -R runner:box /workspace/office-qa
/usr/lib/openteam/bin/openteam-computer-entrypoint true
runuser -u runner -- test ! -r /home/box/.config/private/token
runuser -u runner -- test -w /home/box/.cache/fontconfig
runuser -u runner -- test -w /home/box/.cache/dconf
runuser -u runner -- timeout -k 2s 20s libreoffice --headless --convert-to xlsx --outdir /workspace/office-qa /workspace/office-qa/input.csv > /tmp/office-output 2>&1
cat /tmp/office-output
if grep -E 'No writable cache|dconf-CRITICAL|Permission denied' /tmp/office-output; then
  echo 'Office runtime still has inaccessible cache directories' >&2
  exit 1
fi
python3 - <<'PY'
import zipfile
from xml.etree import ElementTree as ET
p='/workspace/office-qa/input.xlsx'
with zipfile.ZipFile(p) as z:
    root=ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
    ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    cells={c.attrib['r']:c.findtext('m:v',namespaces=ns) for c in root.findall('.//m:c',ns)}
    assert cells['B2']=='12' and cells['B3']=='8',cells
print('LibreOffice conversion and private configuration isolation passed')
PY
CONTAINER

for redirected_path in .cache/pip .config/libreoffice .cache/fontconfig .cache/dconf; do
docker run --rm -i --network none -e "REDIRECTED_PATH=$redirected_path" --entrypoint sh "$image" <<'CONTAINER'
set -eu
mkdir -p /home/box/.config /home/box/.cache /home/box/.pi/agent
chmod 700 /home/box/.pi/agent
ln -s /home/box/.pi/agent "/home/box/$REDIRECTED_PATH"
if /usr/lib/openteam/bin/openteam-computer-entrypoint true; then
  echo "Unexpectedly accepted redirected $REDIRECTED_PATH" >&2
  exit 1
fi
test "$(stat -c %a /home/box/.pi/agent)" = 700
printf 'Redirected cache/profile rejected without exposing target: %s\n' "$REDIRECTED_PATH"
CONTAINER
done
