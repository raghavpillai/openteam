#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$repo_root"
simulator_id="${1:?Pass the UDID of a booted test iOS simulator}"
result_dir="${2:-output/swift-native-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$result_dir"
fixture_pids=""
cleanup() {
  for fixture_pid in $fixture_pids; do kill "$fixture_pid" 2>/dev/null || true; done
}
trap cleanup EXIT
for fixture_port in 19997 19992 20070 20122; do
  if curl --max-time 2 --silent --fail "http://127.0.0.1:$fixture_port/health" | rg -q 'swift-parity-fixture'; then
    echo "Using the running loopback parity fixture on $fixture_port."
  else
    SWIFT_PARITY_PORT="$fixture_port" bun apps/ios/scripts/parity-server.ts > "$result_dir/fixture-$fixture_port.log" 2>&1 &
    fixture_pid=$!
    fixture_pids="$fixture_pids $fixture_pid"
    for attempt in {1..30}; do
      kill -0 "$fixture_pid" 2>/dev/null || { cat "$result_dir/fixture-$fixture_port.log"; exit 1; }
      if curl --max-time 2 --silent --fail "http://127.0.0.1:$fixture_port/health" | rg -q 'swift-parity-fixture'; then break; fi
      sleep 0.2
    done
    curl --max-time 2 --silent --fail "http://127.0.0.1:$fixture_port/health" | rg -q 'swift-parity-fixture'
  fi
done
if ! curl --max-time 2 --silent --fail http://127.0.0.1:20121/__audit/health | rg -q 'ios-video-reference-fixture'; then
  bun apps/ios/scripts/video-reference-server.ts > "$result_dir/fixture-20121.log" 2>&1 &
  fixture_pid=$!
  fixture_pids="$fixture_pids $fixture_pid"
  for attempt in {1..30}; do
    kill -0 "$fixture_pid" 2>/dev/null || { cat "$result_dir/fixture-20121.log"; exit 1; }
    if curl --max-time 2 --silent --fail http://127.0.0.1:20121/__audit/health | rg -q 'ios-video-reference-fixture'; then break; fi
    sleep 0.2
  done
  curl --max-time 2 --silent --fail http://127.0.0.1:20121/__audit/health | rg -q 'ios-video-reference-fixture'
fi
bun apps/ios/scripts/export-robot-artwork.ts --check > "$result_dir/robot-source-check.log" 2>&1
swift test --package-path apps/ios > "$result_dir/core-tests.log" 2>&1
bun test ./packages/client-core/test > "$result_dir/reference-tests.log" 2>&1
test_status=0
xcodebuild -project apps/ios/OpenTeamNative.xcodeproj -scheme OpenTeamNative \
  -destination "platform=iOS Simulator,id=$simulator_id" \
  -derivedDataPath apps/ios/.build-ios \
  -parallel-testing-enabled NO -resultBundlePath "$result_dir/Native.xcresult" \
  test > "$result_dir/simulator-tests.log" 2>&1 || test_status=$?
xcrun xcresulttool get test-results summary --path "$result_dir/Native.xcresult" > "$result_dir/summary.json"
if (( test_status != 0 )); then
  echo "Simulator tests failed; inspect $result_dir/summary.json and simulator-tests.log."
  exit "$test_status"
fi
python3 - "$result_dir/summary.json" <<'PY'
import json,sys
result=json.load(open(sys.argv[1]))
assert result['totalTestCount'] >= 73 and result['failedTests'] == 0 and result['skippedTests'] == 0, result
print(f"Passed {result['passedTests']} simulator tests")
PY
echo "Results: $result_dir"
