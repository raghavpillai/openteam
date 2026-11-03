#!/usr/bin/env bash
# Build the current Android debug APK and print its reproducible artifact details.
set -euo pipefail

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
APK_PATH="$ROOT_DIR/apps/android/app/build/outputs/apk/debug/androidApp-debug.apk"

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
    if (( major >= 17 && major <= 24 )); then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

JAVA_HOME_SELECTED=$(pick_java_home) || {
  echo "No compatible JDK 17-24 found. Set JAVA_HOME or install a supported JDK." >&2
  exit 1
}

export JAVA_HOME="$JAVA_HOME_SELECTED"
export PATH="$JAVA_HOME/bin:$PATH"

echo "Repository: $ROOT_DIR"
echo "Gradle JDK: $JAVA_HOME"
echo "Building :mobile:androidApp:assembleDebug"

(
  cd "$ROOT_DIR"
  ./gradlew --no-daemon :mobile:androidApp:assembleDebug
)

[[ -f "$APK_PATH" ]] || {
  echo "Gradle completed but the APK was not found: $APK_PATH" >&2
  exit 1
}

echo
echo "APK_PATH=$APK_PATH"
echo "APK_SHA256=$(sha256 "$APK_PATH")"
ls -lh "$APK_PATH"
