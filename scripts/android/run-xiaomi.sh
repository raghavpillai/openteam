#!/usr/bin/env bash
# One-command build + install + launch of the OpenTeam Android debug app on the
# Xiaomi phone. This is the terminal equivalent of the "Xiaomi Debug" Android
# Studio run configuration, and is useful for CI shells, agents, and when the
# IDE run widget cannot resolve the device.
set -euo pipefail

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
APP_ID="com.openteam.android"
LAUNCH_COMPONENT="${APP_ID}/.MainActivity"
XIAOMI_MODEL_MARKER="M154FF"

ADB="${ADB:-}"
if [[ -z "$ADB" ]]; then
  for candidate in \
    "${ANDROID_HOME:-}/platform-tools/adb" \
    "${ANDROID_SDK_ROOT:-}/platform-tools/adb" \
    "$HOME/Library/Android/sdk/platform-tools/adb" \
    "$(command -v adb 2>/dev/null || true)"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then ADB="$candidate"; break; fi
  done
fi
if [[ -z "$ADB" || ! -x "$ADB" ]]; then
  echo "adb not found. Set ANDROID_HOME or install platform-tools." >&2
  exit 1
fi

usage() {
  cat <<'EOF'
Usage: bash scripts/android/run-xiaomi.sh [options]

Builds the debug APK, installs it on the Xiaomi phone, and launches MainActivity.

Options:
  --device <serial>   Target a specific adb serial (default: auto-detect M154FF,
                      then ANDROID_SERIAL, then the only connected device).
  --debug             Install, then launch with a waiting debugger
                      (`am set-debug-app -w`). Attach from Android Studio or
                      `jdb`/IDE afterwards.
  --logcat            Stream logcat for the app process after launch.
  --no-build          Skip Gradle and only (re)install the existing APK.
  --apk <path>        Install a specific APK instead of the Gradle debug output.
  -h, --help          Show this help.

Environment:
  ANDROID_SERIAL      Preferred adb serial when --device is not given.
  JAVA_HOME           JDK 17-24 used to run Gradle. Auto-detected when unset.
EOF
}

DEVICE="${ANDROID_SERIAL:-}"
MODE="run"
DO_BUILD=1
APK_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) DEVICE="${2:?--device needs a value}"; shift 2 ;;
    --debug) MODE="debug"; shift ;;
    --logcat) MODE="logcat"; shift ;;
    --no-build) DO_BUILD=0; shift ;;
    --apk) APK_PATH="${2:?--apk needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

java_major() {
  "$1/bin/java" -version 2>&1 | awk -F'"' '/version/ {print $2}' \
    | sed -E 's/^1\.//' | cut -d. -f1
}

pick_java_home() {
  local candidates=() candidate major
  [[ -n "${JAVA_HOME:-}" ]] && candidates+=("$JAVA_HOME")
  candidates+=(
    "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
    "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
    "/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
    "/usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home"
  )
  for candidate in "${candidates[@]}"; do
    [[ -x "$candidate/bin/java" ]] || continue
    major=$(java_major "$candidate" 2>/dev/null || true)
    [[ "$major" =~ ^[0-9]+$ ]] || continue
    # Gradle 8.14.x / Kotlin DSL in this repo supports JDK 17-24; JDK 25 breaks
    # script compilation with "java.lang.IllegalArgumentException: 25.x".
    if (( major >= 17 && major <= 24 )); then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

resolve_device() {
  if [[ -n "$DEVICE" ]]; then
    echo "$DEVICE"
    return 0
  fi
  local serial
  serial=$("$ADB" devices -l | awk -v marker="$XIAOMI_MODEL_MARKER" '$0 ~ marker {print $1; exit}')
  if [[ -n "$serial" ]]; then echo "$serial"; return 0; fi
  local count
  count=$("$ADB" devices | awk 'NR>1 && $2=="device" {c++} END {print c+0}')
  if [[ "$count" == "1" ]]; then
    "$ADB" devices | awk 'NR>1 && $2=="device" {print $1; exit}'
    return 0
  fi
  return 1
}

SERIAL=$(resolve_device) || {
  echo "No Xiaomi device (model $XIAOMI_MODEL_MARKER) found and no unambiguous target." >&2
  echo "Connected devices:" >&2
  "$ADB" devices -l >&2
  echo "Pass --device <serial> or set ANDROID_SERIAL." >&2
  exit 1
}

if ! "$ADB" -s "$SERIAL" get-state >/dev/null 2>&1; then
  echo "Device '$SERIAL' is not reachable by adb." >&2
  "$ADB" devices -l >&2
  exit 1
fi

MODEL=$("$ADB" -s "$SERIAL" shell getprop ro.product.model 2>/dev/null | tr -d '\r')
SDK=$("$ADB" -s "$SERIAL" shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r')
echo "Device: ${MODEL:-unknown} (serial=$SERIAL, API ${SDK:-unknown})"

if (( DO_BUILD )); then
  JAVA_HOME_SELECTED=$(pick_java_home) || {
    echo "No JDK 17-24 found. Install one (e.g. brew install openjdk@21) or set JAVA_HOME." >&2
    exit 1
  }
  echo "Gradle JDK: $JAVA_HOME_SELECTED"
  APK_PATH="$ROOT_DIR/mobile/androidApp/app/build/outputs/apk/debug/androidApp-debug.apk"
  ( cd "$ROOT_DIR" && \
    JAVA_HOME="$JAVA_HOME_SELECTED" ANDROID_SERIAL="$SERIAL" \
    ./gradlew --no-daemon :mobile:androidApp:assembleDebug )
fi

if [[ -z "$APK_PATH" ]]; then
  APK_PATH="$ROOT_DIR/mobile/androidApp/app/build/outputs/apk/debug/androidApp-debug.apk"
fi
if [[ ! -f "$APK_PATH" ]]; then
  echo "APK not found: $APK_PATH" >&2
  exit 1
fi

echo "Installing $APK_PATH"
"$ADB" -s "$SERIAL" install -r -t "$APK_PATH"

"$ADB" -s "$SERIAL" shell am force-stop "$APP_ID" || true

if [[ "$MODE" == "debug" ]]; then
  "$ADB" -s "$SERIAL" shell am set-debug-app -w "$APP_ID"
  echo "Waiting for a debugger to attach to $APP_ID ..."
fi

"$ADB" -s "$SERIAL" shell am start -W -n "$LAUNCH_COMPONENT"
echo "Launched $LAUNCH_COMPONENT on $SERIAL"

if [[ "$MODE" == "logcat" ]]; then
  PID=$("$ADB" -s "$SERIAL" shell pidof "$APP_ID" 2>/dev/null | tr -d '\r' || true)
  if [[ -n "$PID" ]]; then
    echo "Streaming logcat for pid $PID (Ctrl-C to stop)"
    exec "$ADB" -s "$SERIAL" logcat -v time --pid="$PID"
  else
    echo "App process not found; streaming full logcat filtered by package"
    exec "$ADB" -s "$SERIAL" logcat -v time | grep --line-buffered "$APP_ID"
  fi
fi
