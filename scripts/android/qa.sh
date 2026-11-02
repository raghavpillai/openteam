#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
ANDROID_DIR="$ROOT_DIR/apps/android"
REPORT_PATH="${ANDROID_QA_REPORT_PATH:-$ROOT_DIR/output/android-qa/parity-report.md}"

usage() {
  cat <<'EOF'
Usage: bash scripts/android/qa.sh <check|unit|assemble|instrumentation|live-parity|release-gate|all>

check           Validate the parity matrix and write a Markdown report.
unit            Run Android JVM tests (includes the qa and owner test packages).
assemble        Build the debug APK without signing or publishing it.
instrumentation Run connectedDebugAndroidTest; requires an attached emulator/device.
all             Run check, unit, and assemble; instrumentation runs when
                ANDROID_RUN_INSTRUMENTATION=1.
live-parity     Run the credential-free contract harness; use
                OPENTEAM_PARITY_MODE=live with the required environment values
                for an authenticated disposable-server run.
release-gate    Run credential-free release checks and report external artifact,
                signing, device, and Play evidence as pending when unavailable.
EOF
}

write_report() {
  python3 "$ROOT_DIR/scripts/android/parity-report.py" --check --output "$REPORT_PATH"
  echo "Android parity report: $REPORT_PATH"
}

gradle_command() {
  if [[ -x "$ROOT_DIR/gradlew" ]]; then
    (cd "$ROOT_DIR" && ./gradlew --no-daemon "$@")
  elif [[ -x "$ANDROID_DIR/gradlew" ]]; then
    (cd "$ANDROID_DIR" && ./gradlew --no-daemon "$@")
  elif command -v gradle >/dev/null 2>&1; then
    (cd "$ANDROID_DIR" && gradle --no-daemon "$@")
  else
    echo "Gradle is required. Install Gradle or provide apps/android/gradlew." >&2
    return 127
  fi
}

run_instrumentation() {
  if [[ -z "${ANDROID_SERIAL:-}" ]]; then
    echo "ANDROID_SERIAL must identify an attached emulator/device for instrumentation." >&2
    return 2
  fi
  echo "Running instrumentation on $ANDROID_SERIAL"
  gradle_command :mobile:androidApp:connectedDebugAndroidTest
}

command_name="${1:-}"
case "$command_name" in
  check)
    write_report
    ;;
  unit)
    write_report
    gradle_command :mobile:androidApp:testDebugUnitTest
    ;;
  assemble)
    gradle_command :mobile:androidApp:assembleDebug
    ;;
  instrumentation)
    write_report
    run_instrumentation
    ;;
  live-parity)
    python3 "$ROOT_DIR/scripts/android/live-parity.py"
    ;;
  release-gate)
    bash "$ROOT_DIR/scripts/android/release-gate.sh"
    ;;
  all)
    write_report
    gradle_command :mobile:androidApp:testDebugUnitTest :mobile:androidApp:assembleDebug
    if [[ "${ANDROID_RUN_INSTRUMENTATION:-0}" == "1" ]]; then
      run_instrumentation
    else
      echo "Instrumentation skipped; set ANDROID_RUN_INSTRUMENTATION=1 to run it."
    fi
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
