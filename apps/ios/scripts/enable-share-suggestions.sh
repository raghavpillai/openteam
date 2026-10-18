#!/usr/bin/env bash
# Simulator QA only. iOS simulators ship coreduetd but never start it, so the share sheet
# never shows conversation suggestions. Start it, then restart searchd, which permanently
# disables a Spotlight receiver that was missing when it launched.
# Not persistent: rerun after the simulator reboots. Only messages sent afterwards count.
set -euo pipefail
udid=${1:?usage: enable-share-suggestions.sh <simulator-udid>}
if ! xcrun simctl spawn "$udid" launchctl list | grep -q 'com.apple.coreduetd$'; then
  plist="$(mktemp -d)/com.apple.coreduetd.plist"
  python3 - "$plist" <<'PY'
import plistlib, sys
services = ['com.apple.coreduetd.knowledge', 'com.apple.coreduetd.people', 'com.apple.corespotlight.receiver.coreduet']
plistlib.dump({'Label': 'com.apple.coreduetd', 'ProgramArguments': ['/usr/libexec/coreduetd'],
               'MachServices': {name: True for name in services}, 'EnableTransactions': True,
               'RunAtLoad': True, 'UserName': 'mobile'}, open(sys.argv[1], 'wb'))
PY
  xcrun simctl spawn "$udid" launchctl load "$plist"
  sleep 2
fi
xcrun simctl spawn "$udid" launchctl kickstart -k system/com.apple.searchd 2>/dev/null
sleep 2
xcrun simctl spawn "$udid" launchctl list | grep -E 'com.apple.(coreduetd|searchd)$'
