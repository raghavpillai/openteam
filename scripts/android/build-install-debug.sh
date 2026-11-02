#!/usr/bin/env bash
# Prompt for an adb-over-Wi-Fi device, then build and install the current debug APK.
set -euo pipefail

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)

ADB="${ADB:-}"
if [[ -z "$ADB" ]]; then
  for candidate in \
    "${ANDROID_HOME:-}/platform-tools/adb" \
    "${ANDROID_SDK_ROOT:-}/platform-tools/adb" \
    "$HOME/Library/Android/sdk/platform-tools/adb" \
    "$(command -v adb 2>/dev/null || true)"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      ADB="$candidate"
      break
    fi
  done
fi

if [[ -z "$ADB" || ! -x "$ADB" ]]; then
  echo "adb not found. Set ANDROID_HOME or install Android platform-tools." >&2
  exit 1
fi

read -r -p "ADB IP address (default port 5555): " INPUT
INPUT=${INPUT//[[:space:]]/}

if [[ -z "$INPUT" ]]; then
  echo "An ADB IP address is required." >&2
  exit 2
fi

case "$INPUT" in
  *:*)
    SERIAL="$INPUT"
    ;;
  *)
    SERIAL="${INPUT}:5555"
    ;;
esac

echo "Connecting to $SERIAL"
"$ADB" connect "$SERIAL"

if ! "$ADB" -s "$SERIAL" get-state >/dev/null 2>&1; then
  echo "ADB device '$SERIAL' is not reachable." >&2
  "$ADB" devices -l >&2
  exit 1
fi

echo "Building and installing the current debug APK..."
(
  cd "$ROOT_DIR"
  ADB="$ADB" bash scripts/android/run-xiaomi.sh --device "$SERIAL"
)
