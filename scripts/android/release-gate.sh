#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
STRICT="${ANDROID_RELEASE_GATE_STRICT:-0}"
APP_LINKS="$ROOT_DIR/docs/android/assetlinks.json.template"
PACKAGE_NAME="${ANDROID_APPLICATION_ID:-com.openteam.android}"
APP_LINK_HOST="${OPENTEAM_APP_LINK_HOST:-openteam.example.com}"
APK_PATH="${ANDROID_APK:-}"
AAB_PATH="${ANDROID_AAB:-}"
MANIFEST_PATH="$ROOT_DIR/apps/android/app/src/main/AndroidManifest.xml"
BUILD_FILE="$ROOT_DIR/apps/android/app/build.gradle.kts"
PERFORMANCE_BASELINE="${ANDROID_PERFORMANCE_BASELINE:-}"
PLAY_SERVICE_ACCOUNT="${PLAY_SERVICE_ACCOUNT_JSON:-}"

pass() { printf 'PASS %s\n' "$1"; }
pending() {
  printf 'PENDING %s\n' "$1"
  if [[ "$STRICT" == "1" ]]; then
    return 1
  fi
}
fail() {
  printf 'FAIL %s\n' "$1" >&2
  return 1
}

sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

check_static() {
  python3 "$ROOT_DIR/scripts/android/parity-report.py" --check --output /tmp/openteam-release-parity.md
  python3 "$ROOT_DIR/scripts/android/check-assetlinks.py" "$APP_LINKS" --template --package "$PACKAGE_NAME" --host "$APP_LINK_HOST"
  python3 "$ROOT_DIR/scripts/android/live-parity.py" --contract
  bash "$ROOT_DIR/scripts/android/fcm-verify.sh" payload
  pass "parity, assetlinks, live-parity contract, and FCM payload checks"
  check_manifest
  check_dependencies
}

check_manifest() {
  python3 - "$MANIFEST_PATH" <<'PY'
import sys
from pathlib import Path

manifest = Path(sys.argv[1]).read_text(encoding="utf-8")
if '<uses-permission android:name="android.permission.INTERNET" />' not in manifest:
    raise SystemExit("manifest scan failed: INTERNET permission is missing")
if 'android:exported="true"' not in manifest:
    raise SystemExit("manifest scan failed: launcher activity must declare exported=true")
if 'android:usesCleartextTraffic="true"' in manifest:
    print("PENDING manifest release hardening: cleartext traffic is enabled for development")
else:
    print("PASS manifest security baseline: cleartext traffic disabled")
if 'android:autoVerify="true"' in manifest:
    print("PASS manifest App Links autoVerify declaration")
else:
    print("PENDING manifest App Links autoVerify declaration is absent")
PY
}

check_dependencies() {
  python3 - "$BUILD_FILE" <<'PY'
import re
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text(encoding="utf-8")
dynamic = sorted(set(re.findall(r'"[^"\n:]+:[^"\n:]+:([^"\n]+)"', text)))
dynamic = [version for version in dynamic if version == "+" or version.endswith("+") or "SNAPSHOT" in version.upper()]
if dynamic:
    raise SystemExit("dependency declaration scan failed: dynamic versions " + ", ".join(dynamic))
print("PASS dependency declaration scan: no dynamic or SNAPSHOT versions")
PY
}

check_artifact() {
  local label="$1"
  local path="$2"
  if [[ -z "$path" ]]; then
    pending "$label artifact path not provided"
    return
  fi
  [[ -f "$path" ]] || fail "$label artifact does not exist"
  printf 'PASS %s SHA-256 %s\n' "$label" "$(sha256 "$path")"
}

check_signing() {
  if [[ -n "$APK_PATH" ]]; then
    if ! command -v apksigner >/dev/null 2>&1; then
      pending "apksigner is unavailable"
    else
      apksigner verify --verbose "$APK_PATH" >/tmp/openteam-apksigner.txt
      pass "apksigner verification"
    fi
  else
    pending "signed APK verification requires ANDROID_APK"
  fi
  if [[ -n "$AAB_PATH" ]]; then
    if ! command -v jarsigner >/dev/null 2>&1; then
      pending "jarsigner is unavailable for AAB verification"
    else
      jarsigner -verify "$AAB_PATH" >/tmp/openteam-jarsigner.txt
      pass "AAB jarsigner verification"
    fi
  else
    pending "signed AAB verification requires ANDROID_AAB"
  fi
}

check_device() {
  if ! command -v adb >/dev/null 2>&1; then
    pending "performance/device evidence requires adb"
    return
  fi
  if [[ -z "${ANDROID_SERIAL:-}" ]]; then
    pending "performance/device evidence requires ANDROID_SERIAL"
    return
  fi
  adb -s "$ANDROID_SERIAL" get-state >/dev/null
  pass "attached Android device $ANDROID_SERIAL"
}

check_performance() {
  if [[ -z "$PERFORMANCE_BASELINE" ]]; then
    pending "macrobenchmark/performance evidence requires ANDROID_PERFORMANCE_BASELINE"
    return
  fi
  [[ -f "$PERFORMANCE_BASELINE" ]] || fail "performance baseline does not exist"
  python3 - "$PERFORMANCE_BASELINE" <<'PY'
import json
import sys
from pathlib import Path

value = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
required = {"device", "api", "coldStartMs", "warmStartMs", "frameJankPercent", "memoryMb"}
missing = sorted(required - set(value))
if missing:
    raise SystemExit("performance baseline missing: " + ", ".join(missing))
print("PASS performance baseline schema")
PY
}

check_play() {
  if [[ -z "$PLAY_SERVICE_ACCOUNT" ]]; then
    pending "Play internal-track evidence requires PLAY_SERVICE_ACCOUNT_JSON"
    return
  fi
  [[ -f "$PLAY_SERVICE_ACCOUNT" ]] || fail "Play service-account file does not exist"
  if ! command -v bundletool >/dev/null 2>&1; then
    pending "bundletool/Play validation tool is unavailable"
    return
  fi
  pending "Play upload verification requires explicit package/version and must run in the release environment"
}

usage() {
  cat <<'EOF'
Usage: bash scripts/android/release-gate.sh [check|artifacts|all]

check      Run credential-free parity, assetlinks, FCM, and live-parity checks.
artifacts  Check supplied ANDROID_APK/ANDROID_AAB digests and signing tools.
all        Run every available check; missing external evidence is PENDING.

Set ANDROID_RELEASE_GATE_STRICT=1 to fail when external evidence is unavailable.
Never put credentials in arguments or repository files.
EOF
}

case "${1:-all}" in
  check)
    check_static
    ;;
  artifacts)
    check_artifact "APK" "$APK_PATH"
    check_artifact "AAB" "$AAB_PATH"
    check_signing
    check_device
    check_performance
    check_play
    ;;
  all)
    check_static
    check_artifact "APK" "$APK_PATH"
    check_artifact "AAB" "$AAB_PATH"
    check_signing
    check_device
    check_performance
    check_play
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
