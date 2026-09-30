#!/usr/bin/env bash
set -euo pipefail
image=${1:?Usage: bash scripts/test-computer-office-runtime.sh IMAGE}
# Offline isolated container; no host mounts, credentials or published ports.
docker run --rm -i --network none --entrypoint sh "$image" <<'CONTAINER'
set -eu
mkdir -p /home/box/.config/private /workspace/office-qa
chmod 700 /home/box/.config /home/box/.config/private
printf synthetic > /home/box/.config/private/token
printf 'name,amount\nAlpha,12\nBeta,8\n' > /workspace/office-qa/input.csv
chown -R runner:box /workspace/office-qa
/usr/local/bin/openteam-computer-entrypoint true
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

for redirected_path in .config/libreoffice .cache/fontconfig .cache/dconf; do
docker run --rm -i --network none -e "REDIRECTED_PATH=$redirected_path" --entrypoint sh "$image" <<'CONTAINER'
set -eu
mkdir -p /home/box/.config /home/box/.cache /home/box/.pi/agent
chmod 700 /home/box/.pi/agent
ln -s /home/box/.pi/agent "/home/box/$REDIRECTED_PATH"
if /usr/local/bin/openteam-computer-entrypoint true; then
  echo 'Unexpectedly accepted redirected office profile/cache' >&2
  exit 1
fi
test "$(stat -c %a /home/box/.pi/agent)" = 700
printf 'Redirected office profile/cache rejected: %s\n' "$REDIRECTED_PATH"
CONTAINER
done
