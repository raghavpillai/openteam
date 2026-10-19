#!/usr/bin/env bash
set -euo pipefail

image=${1:?Usage: bash scripts/test-computer-admin.sh IMAGE}
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
fixtures=$(mktemp -d)
container="openteam-computer-admin-test-$$"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$fixtures"
}
trap cleanup EXIT

# These containers never receive user data, credentials, network access or ports.
# Match the capabilities and mounts of the shipped Compose computer service.
common=(--rm --name "$container" --network none --cap-drop ALL
  --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETGID --cap-add SETUID
  --tmpfs /home/box:rw,exec --tmpfs /workspace:rw,exec
  --tmpfs /tmp:rw,noexec,nosuid,size=512m
  --mount "type=bind,source=$repo_root/apps/computer/src,target=/test/src,readonly"
  --mount "type=bind,source=$repo_root/apps/computer/test/admin-mode.integration.test.ts,target=/test/test/admin-mode.integration.test.ts,readonly")
test_command=(bun test /test/test/admin-mode.integration.test.ts)

echo "Default administrator access: sudo, system writes and package installation"
docker run "${common[@]}" \
  -e OPENTEAM_TEST_COMPUTER_ADMIN=1 "$image" "${test_command[@]}"

echo "Administrator access honors a custom agent UID"
docker run "${common[@]}" -e OPENTEAM_AGENT_UID=1000 \
  -e OPENTEAM_TEST_COMPUTER_ADMIN=1 "$image" "${test_command[@]}"

assert_startup_failure() {
  local expected=$1
  shift
  if docker run "${common[@]}" "$@" "$image" true > "$fixtures/failure.log" 2>&1; then
    echo "Expected startup to fail: $expected" >&2
    exit 1
  fi
  if ! grep -F "$expected" "$fixtures/failure.log" >/dev/null; then
    cat "$fixtures/failure.log" >&2
    exit 1
  fi
}

echo "Reject incompatible container restrictions and invalid agent identities"
assert_startup_failure "requires no-new-privileges:false" --security-opt no-new-privileges:true
assert_startup_failure "requires a writable system filesystem" --read-only
assert_startup_failure "requires a non-root agent UID" -e OPENTEAM_AGENT_UID=0
assert_startup_failure "invalid OPENTEAM_AGENT_UID" -e OPENTEAM_AGENT_UID=invalid
echo "Computer administrator access checks passed"
