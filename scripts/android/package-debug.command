#!/usr/bin/env bash
# Finder double-click entry point for debug APK packaging on macOS.
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
status=0
bash "$SCRIPT_DIR/package-debug.sh" || status=$?

echo
if (( status == 0 )); then
  echo "Debug APK packaging completed."
else
  echo "Debug APK packaging failed with status $status."
fi
read -r -p "Press Return to close this window..." _
exit "$status"
