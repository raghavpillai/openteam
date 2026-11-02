#!/usr/bin/env bash
# Prompt for an adb-over-Wi-Fi device, then build and install the current debug APK.
set -euo pipefail

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)

GIT_DIR=$(git -C "$ROOT_DIR" rev-parse --git-dir 2>/dev/null || true)
if [[ -n "$GIT_DIR" && "$GIT_DIR" != /* ]]; then
  GIT_DIR="$ROOT_DIR/$GIT_DIR"
fi
if [[ -n "$GIT_DIR" ]]; then
  LAST_TARGET_FILE="$GIT_DIR/openteam-last-adb-target"
else
  LAST_TARGET_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/openteam/last-adb-target"
fi

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

LAST_TARGET=""
if [[ -f "$LAST_TARGET_FILE" ]]; then
  IFS= read -r LAST_TARGET < "$LAST_TARGET_FILE" || true
  LAST_TARGET=${LAST_TARGET//[[:space:]]/}
fi

if [[ -n "$LAST_TARGET" ]]; then
  read -r -p "ADB IP address or host[:port] [$LAST_TARGET]: " INPUT
else
  read -r -p "ADB IP address or host[:port] (default port 5555): " INPUT
fi
INPUT=${INPUT//[[:space:]]/}

if [[ -z "$INPUT" ]]; then
  INPUT="$LAST_TARGET"
fi
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

save_last_target() {
  local state_dir temp_file
  state_dir=$(dirname "$LAST_TARGET_FILE")
  temp_file="${LAST_TARGET_FILE}.tmp.$$"
  mkdir -p "$state_dir"
  printf '%s\n' "$1" > "$temp_file"
  mv -f "$temp_file" "$LAST_TARGET_FILE"
}

if ! save_last_target "$SERIAL"; then
  echo "Warning: could not save the last ADB target to $LAST_TARGET_FILE" >&2
fi

echo "Building and installing the current debug APK..."
(
  cd "$ROOT_DIR"
  ADB="$ADB" bash scripts/android/run-xiaomi.sh --device "$SERIAL"
)
