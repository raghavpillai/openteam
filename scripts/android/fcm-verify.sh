#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)

usage() {
  cat <<'EOF'
Usage: bash scripts/android/fcm-verify.sh <config|payload|all>

config  Validate Firebase service-account environment variables without printing secrets.
payload Run credential-free FCM payload and transport tests.
all     Run payload tests, then validate configuration when credentials are present.

Required for real sends:
  OPENTEAM_FCM_PROJECT_ID
  OPENTEAM_FCM_CLIENT_EMAIL
  OPENTEAM_FCM_PRIVATE_KEY
EOF
}

config_check() {
  local missing=0
  for name in OPENTEAM_FCM_PROJECT_ID OPENTEAM_FCM_CLIENT_EMAIL OPENTEAM_FCM_PRIVATE_KEY; do
    if [[ -z "${!name:-}" ]]; then
      echo "missing: $name"
      missing=1
    else
      echo "present: $name"
    fi
  done
  if [[ "$missing" == "1" ]]; then
    echo "FCM is not configured; real delivery remains externally blocked." >&2
    return 2
  fi
  (cd "$ROOT_DIR" && bun -e 'import { fcmConfigurationStatus } from "./apps/worker/src/fcm.ts"; const result = fcmConfigurationStatus(); if (!result.configured) { for (const issue of result.issues) console.error(`invalid: ${issue}`); process.exit(2); } console.log("FCM service-account configuration is valid; no network send was attempted.");')
}

payload_tests() {
  (cd "$ROOT_DIR" && bun test apps/worker/test/fcm.test.ts)
}

case "${1:-}" in
  config) config_check ;;
  payload) payload_tests ;;
  all) payload_tests; config_check ;;
  *) usage >&2; exit 2 ;;
esac
