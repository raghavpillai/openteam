# Desktop performance-audit harness

This directory starts a disposable OpenTeam stack for renderer and Electron stress testing. It does not use the normal OpenTeam database or agent-data volume.

## Build and release gates

`bun desktop:performance` performs a clean renderer/main/preload/utility build, reads the generated Vite manifest, and enforces startup, CSS, complete-renderer, and lazy-feature closure budgets.

`bun desktop:performance:release` additionally removes electron-builder's generated `release` tree, rebuilds and packages the app, and requires current ASAR/ZIP/DMG artifacts. The gate compares every `dist` and `dist-electron` file byte-for-byte with `app.asar`, so a missing, mixed-generation, or stale package cannot pass.

Safety properties:

- Compose project name: `openteam-performance-audit`
- Database name: `openteam_perf_audit`
- Server bind: `127.0.0.1:8877`
- Renderer bind: `127.0.0.1:5174`
- `seed.sql` refuses to run unless the connected database is exactly `openteam_perf_audit`
- The computer service is a local stub, so no real graphical-computer sessions are created

## iOS export gate

`bun --filter @openteam/mobile performance` creates both release-shaped and source-mapped iOS
exports under a disposable system temporary directory. It checks Hermes bytecode and Metro
module budgets, exported asset count and bytes, application route parity, and the production
bundle's retained packages. The gate rejects runtime retention of `effect`, `fast-check`, or
external `@react-navigation/*` packages.

The gate clears the two supported `EXPO_PUBLIC_*` build-time values so local configuration does
not alter its hash or measurements. It always removes its temporary exports, including after a
failure, and does not touch `apps/mobile/dist`.

For machine-readable evidence, run the script directly:

```sh
bun scripts/performance/check-mobile-budgets.ts --json
```

## Start and seed

Build the production renderer and start the isolated backend:

```sh
bun --filter @openteam/desktop build
docker-compose -f scripts/performance/docker-compose.yml up --build -d server
```

Seed a scale point. The script is incremental and deterministic, so increasing the values adds only missing rows:

```sh
docker-compose -f scripts/performance/docker-compose.yml exec -T postgres \
  psql -U openteam -d openteam_perf_audit \
  -v bot_count=1000 \
  -v messages_per_bot=20 \
  -v group_count=100 \
  -v long_transcript_count=10000 \
  < scripts/performance/seed.sql
```

Useful scale points:

| Scenario | Bots | Groups | Messages per bot | Long transcript |
|---|---:|---:|---:|---:|
| Baseline | 10 | 2 | 20 | 0 |
| Medium | 250 | 25 | 20 | 0 |
| Heavy sidebar | 1,000 | 100 | 20 | 0 |
| Heavy transcript | 1,000 | 100 | 20 | 10,000 |

### Native iOS edge fixtures

The historical scale points above do not include the expensive native edge
cases by default. Add `ios_stress_fixture=true` to seed a dedicated, disabled
fixture set for final simulator CUA without changing the normal desktop
baseline:

```sh
docker-compose -f scripts/performance/docker-compose.yml exec -T postgres \
  psql -U openteam -d openteam_perf_audit \
  -v bot_count=1000 \
  -v messages_per_bot=20 \
  -v group_count=100 \
  -v long_transcript_count=10000 \
  -v ios_stress_fixture=true \
  < scripts/performance/seed.sql
```

The opt-in rows are deterministic and safe to reseed. The SQL aborts if the
Markdown byte count, thread shapes, routine count, or activity overflow counts
are incomplete. The 250 group routines are disabled and intentionally bypass
the product's per-owner creation limit because this is a read-scale fixture.
The 101 completed subagents use dedicated hidden child bots, so none of the
existing visible audit bots become subagent identities.

| Fixture | Stable name | Stable ID |
|---|---|---|
| Bot | `iOS Stress Fixture` | `d182fd73-eead-4a5b-e84b-4b8b66e6eec7` |
| Chat/activity channel | `iOS Stress Fixture` | `649d7f94-5e07-7e68-c39c-29a0517588f7` |
| Routine group | `iOS Routine Scale (250)` | `7963ee95-35e0-7820-845e-bf4fe649bacf` |
| 200,000-byte Markdown message | `iOS 200 KB Markdown Stress` | `41405e10-038d-d015-dee7-e78c0edc44f0` |
| 250-reply thread root | `iOS Wide Thread Stress - 250 direct replies` | `5ba122f6-5eea-9773-911d-6ba5b4a2a9a0` |
| 125-edge thread root | `iOS Deep Thread Stress - 125-message ancestor chain` | `ab1fca0b-b093-4ff5-b24b-0fc5d13f8d01` |
| 125-edge thread leaf | `iOS deep-chain reply 125 of 125.` | `167e7433-da36-c7c4-45bb-6d9e49e0eb7b` |
| Activity marker | `iOS Activity Projection Stress` | `0c4a23ca-db4e-8705-a486-c008d6beb7be` |

With the server on the standard isolated port, these read-only checks prove the
API boundaries used by the mobile client. They should report 100/1,000/100
rows with all three truncation flags set, 100 retained ancestors with deep
context truncation, and 250 routines:

```sh
curl -sS \
  http://127.0.0.1:8877/api/v0/channels/649d7f94-5e07-7e68-c39c-29a0517588f7/client-state \
  | jq '{runs: (.runs | length), runItems: (.runItems | length), subagents: (.subagents | length), truncated}'

curl -sS \
  'http://127.0.0.1:8877/api/v0/channel-messages/167e7433-da36-c7c4-45bb-6d9e49e0eb7b/context?before=0&after=0' \
  | jq '{threadContext: (.threadContext | length), threadContextTruncated}'

curl -sS \
  http://127.0.0.1:8877/api/v0/channels/7963ee95-35e0-7820-845e-bf4fe649bacf/routines \
  | jq 'length'
```

Serve the production renderer with API proxying in a second terminal:

```sh
bun scripts/performance/serve-renderer.ts
```

Launch Electron with a disposable Chromium profile in a third terminal:

```sh
audit_user_data="$(mktemp -d /tmp/openteam-perf-electron.XXXXXX)"
OPENTEAM_RENDERER_URL='http://127.0.0.1:5174/?profile=1' \
OPENTEAM_HOST_BRIDGE_PORT=8891 \
apps/desktop/node_modules/.bin/electron \
  --remote-debugging-port=9333 \
  --user-data-dir="$audit_user_data" \
  apps/desktop
```

`?profile=1` exposes the existing `window.openteamPerformance` diagnostics. Read `window.openteamPerformance.snapshot()` directly during long sessions; the DOM-published summary becomes stale after the 200-entry ring is full.

## Direct snapshot timing

```sh
for run in {1..10}; do
  curl -sS -o /dev/null \
    -w '%{time_total} %{time_starttransfer} %{size_download}\n' \
    http://127.0.0.1:8877/api/v0/client-snapshot
done
```

## Search timing

After seeding the isolated database, exercise all search categories plus a
zero-result query. The benchmark validates category correctness and reports
end-to-end and `Server-Timing` min/p50/p95/max/mean values:

```sh
OPENTEAM_AUDIT_OUTPUT=audit/search-current.json \
  bun scripts/performance/benchmark-search.ts
```

Override `OPENTEAM_PERF_BASE_URL`, `OPENTEAM_SEARCH_WARMUPS`, or
`OPENTEAM_SEARCH_SAMPLES` when measuring a different isolated arm.

## API scale timing

Measure the bounded bootstrap/runtime/history paths and the compatibility
snapshot against the same heavy fixture:

```sh
OPENTEAM_AUDIT_OUTPUT=audit/api-current.json \
  bun scripts/performance/benchmark-api.ts
```

Override `OPENTEAM_API_WARMUPS` or `OPENTEAM_API_SAMPLES` to change the sample
count. The harness records response sizes and both end-to-end and Server-Timing
durations where the endpoint exposes them.

## Authentication overhead

With the isolated stack available in both `disabled` and `required` modes,
measure the per-request Better Auth session-check cost against the same protected
runtime response. The benchmark alternates arms and requires byte-for-byte
response parity:

```sh
OPENTEAM_AUTH_USERNAME=audit_owner \
OPENTEAM_AUTH_PASSWORD='local-audit-password' \
OPENTEAM_AUDIT_OUTPUT=audit/auth-overhead.json \
  bun scripts/performance/benchmark-auth.ts
```

The disabled arm defaults to `127.0.0.1:8877` and the required arm to
`127.0.0.1:8878`. Override `OPENTEAM_AUTH_DISABLED_BASE_URL`,
`OPENTEAM_AUTH_REQUIRED_BASE_URL`, `OPENTEAM_AUTH_WARMUPS`, or
`OPENTEAM_AUTH_SAMPLES` as needed.

## Cleanup

Stop Electron and the renderer with `Ctrl-C`, then delete only the isolated Compose containers and volumes:

```sh
docker-compose -f scripts/performance/docker-compose.yml down -v
```

The synthetic rows and isolated PostgreSQL volume are intentionally unrecoverable after `down -v`; rerun the seed command to regenerate them.
