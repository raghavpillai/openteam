#!/usr/bin/env bash
# Opt-in real-kernel/headed-desktop checks. Requires Docker cgroup v2 and Bun.
# Set OPENTEAM_MEMORY_TEST_SKIP_BUILD=1 to reuse OPENTEAM_MEMORY_TEST_IMAGE.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
export OPENTEAM_MEMORY_TEST_IMAGE="${OPENTEAM_MEMORY_TEST_IMAGE:-openteam-memory-test:local}"
export OPENTEAM_MEMORY_TEST_OUTPUT="$root/output/desktop-memory-tests-$(date +%Y%m%d%H%M%S)-$$"
mkdir -p "$OPENTEAM_MEMORY_TEST_OUTPUT"/{bundles,artifacts}
project="openteam-memory-test-$$"
compose=(docker compose -p "$project" -f apps/computer/test/fixtures/desktop-memory.compose.yaml)
cleanup() {
  "${compose[@]}" logs --no-color > "$OPENTEAM_MEMORY_TEST_OUTPUT/compose.log" 2>&1 || true
  "${compose[@]}" down --volumes --remove-orphans || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "${OPENTEAM_MEMORY_TEST_SKIP_BUILD:-0}" != 1 ]]; then
  docker build -f docker/computer.Dockerfile -t "$OPENTEAM_MEMORY_TEST_IMAGE" .
fi
bun build \
  apps/computer/test/desktop-memory.integration.test.ts \
  apps/computer/test/desktop-memory-ui.integration.test.ts \
  --target bun --external playwright-core --external 'playwright-core/*' \
  --outdir "$OPENTEAM_MEMORY_TEST_OUTPUT/bundles"

ready() {
  for ((attempt = 0; attempt < 90; attempt++)); do
    if "${compose[@]}" exec -T computer bun -e \
      'try { process.exit((await fetch("http://127.0.0.1:8790/health")).ok ? 0 : 1) } catch { process.exit(1) }' \
      >/dev/null 2>&1; then return; fi
    sleep 1
  done
  echo "Disposable computer gateway did not become ready" >&2
  return 1
}
"${compose[@]}" up -d
ready
"${compose[@]}" exec -T \
  -e OPENTEAM_TEST_DESKTOP_MEMORY=1 -e OPENTEAM_MEMORY_TEST_ARTIFACTS=/artifacts \
  computer bun test \
  /app/apps/computer/test-bundles/desktop-memory.integration.test.js \
  /app/apps/computer/test-bundles/desktop-memory-ui.integration.test.js \
  2>&1 | tee "$OPENTEAM_MEMORY_TEST_OUTPUT/tests.log"

"${compose[@]}" restart computer
ready
"${compose[@]}" exec -T -e OPENTEAM_TEST_DESKTOP_MEMORY=1 computer bun test \
  /app/apps/computer/test-bundles/desktop-memory.integration.test.js \
  2>&1 | tee "$OPENTEAM_MEMORY_TEST_OUTPUT/post-restart.log"
echo "Memory/desktop checks passed. Logs and screenshots: $OPENTEAM_MEMORY_TEST_OUTPUT"
