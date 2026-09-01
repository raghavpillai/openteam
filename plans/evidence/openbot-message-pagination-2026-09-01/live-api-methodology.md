# Live message-pagination API methodology

## Scope and isolation

Measurements used the disposable Compose project `openbot-message-pagination-audit` at
`http://127.0.0.1:8882`. The server ran with authentication disabled against the isolated
`openbot_perf_audit` database. The user's installed app, normal database, SSH tunnel, and desktop
profile were not read or changed.

The seeded database contained 1,102 bots, 1,102 channels, and 32,385 messages; bootstrap projected
1,001 visible bots and all 1,102 channels. `Audit Bot 0001` contained 10,020 representative
messages. The opt-in `iOS Stress Fixture` supplied one exact 200,000-byte Markdown message, a
125-edge ancestor chain, and 250 direct replies to one root.

## Benchmark method

The reproducible harness is
[`scripts/performance/benchmark-message-pagination-live-api.ts`](../../../scripts/performance/benchmark-message-pagination-live-api.ts).
It performs three warmups followed by 20 measured requests per point. End-to-end duration includes
fetching and JSON decoding; TTFB is recorded immediately after `fetch` resolves with response
headers. Response bytes are the decoded JSON-body length observed by Bun's Fetch implementation.

The command used was:

```sh
OPENBOT_PERF_BASE_URL=http://127.0.0.1:8882 \
OPENBOT_PAGINATION_WARMUPS=3 \
OPENBOT_PAGINATION_SAMPLES=20 \
OPENBOT_AUDIT_OUTPUT=plans/evidence/openbot-message-pagination-2026-09-01/live-api.json \
bun scripts/performance/benchmark-message-pagination-live-api.ts
```

History depth was reached only by following each returned `beforeSequence`; no offset query or
direct database cursor was substituted. Repeated timing began only after all target cursors had
been discovered. This keeps the benchmark faithful to the desktop client's actual keyset path.

The reconnect case is a deterministic replay over existing rows, not a database mutation. The
harness treats a 100-row page immediately before the newest 150 messages as the renderer's cached
state, then applies the actual `mergeLoadedChannelHistoryPage(..., "refresh")` helper to today's
newest 100-row response. It separately runs the actual centered message-context merge for a target
inside the resulting gap.

## Results

All durations below are milliseconds. Full distributions and exact cursors are in
[`live-api.json`](./live-api.json).

### Keyset history depth

| Messages newer than page | Rows | Response bytes | p50 | p95 |
|---:|---:|---:|---:|---:|
| 0 | 100 | 40,917 | 1.371 | 2.213 |
| 100 | 100 | 40,916 | 1.559 | 2.359 |
| 1,000 | 100 | 40,916 | 1.800 | 2.541 |
| 5,000 | 100 | 40,916 | 1.445 | 2.234 |
| 9,900 | 100 | 40,708 | 1.648 | 2.501 |
| 10,000, terminal | 20 | 9,085 | 1.097 | 1.921 |

There is no meaningful depth-dependent latency trend. A warm PostgreSQL plan for the latest 101
rows used `ChannelMessage_channelId_sequence_idx` in 0.057 ms with six shared-buffer hits. The
equivalent request 9,900 rows deep used the same index in 0.065 ms with 12 hits:

```sh
docker exec openbot-message-pagination-audit-postgres-1 \
  psql -U openbot -d openbot_perf_audit -X -Atc \
  "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
   SELECT \"id\", \"sequence\", \"channelId\", \"sender\", \"senderBotId\", \"sourceRunId\",
          \"content\", \"metadata\", \"createdAt\"
   FROM \"ChannelMessage\"
   WHERE \"channelId\" = '00afa798-6702-a4d8-ad9b-08737550b907'::uuid
     AND \"sequence\" < 22101
   ORDER BY \"sequence\" DESC LIMIT 101;"
```

Walking the complete 10,020-message transcript required 101 sequential requests, transferred
4,099,579 JSON bytes, and completed in 169.3 ms on the warm local stack. This is fast at the API
boundary but demonstrates why retaining every traversed page is unnecessary renderer growth.

### Page-size scaling on representative messages

| Requested rows | Response bytes | Decode p50 | End-to-end p50 | End-to-end p95 |
|---:|---:|---:|---:|---:|
| 20 | 8,310 | 0.014 | 1.129 | 2.083 |
| 50 | 20,544 | 0.032 | 1.462 | 3.160 |
| 100 | 40,917 | 0.051 | 1.634 | 2.254 |
| 200 | 81,663 | 0.091 | 2.142 | 3.212 |

Moving from 100 to 50 saves about 20 KB per page, but saved only about 0.17 ms p50 on the local
API path. Moving from 100 to 200 doubled bytes and increased p50 by about 0.51 ms. This supports
keeping 100 as the default network page while bounding how many pages React retains.

### Pathological content and thread context

| Request | Primary rows | Ancestors | Response bytes | p50 | p95 |
|---|---:|---:|---:|---:|---:|
| Plain target, 0/0 | 1 | 0 | 655 | 1.234 | 2.280 |
| Wide-thread leaf, 0/0 | 1 | 1 | 1,089 | 1.961 | 2.722 |
| 125-deep leaf, 0/0 | 1 | 100, truncated | 38,991 | 3.747 | 4.825 |
| 200 KB target, 0/0 | 1 | 0 | 202,567 | 3.122 | 4.622 |
| 200 KB target, 50/50 | 101 | 76 | 273,194 | 5.170 | 5.940 |
| History page containing 200 KB target | 100 | 27 | 250,733 | 4.107 | 5.295 |
| Latest wide-thread history page | 100 | 1 | 45,416 | 2.535 | 3.600 |

The server's recursive ancestor query remains bounded at 100 rows and completes in one database
query. Large content dominates payload size, but even the combined 273 KB centered context stayed
below 6.0 ms p95 on this local stack. These figures do not measure Markdown layout or syntax
highlighting in Chromium; those remain renderer costs.

### More than 100 messages arriving between refreshes

The current refresh merge produced this exact result:

- cached before reconnect: 100 rows;
- simulated new messages: 150 rows;
- rows fetched by latest-page refresh: 100;
- rows retained after merging old and latest pages: 200;
- new messages absent from the merged history: **50**.

A centered 50/50 context request recovered a target inside the gap in 1.737 ms p50 and returned
41,450 bytes. It also truthfully returned both `hasMoreBefore: true` and `hasMoreAfter: true`.
Today's renderer stores the context messages but not either edge cursor or flag, so it cannot
continue toward the newer side from that search window.

This is a correctness edge, not a normal-history database bottleneck. Continuous foreground use
usually refreshes often enough to avoid it; a suspended renderer, a very fast burst, or a coalesced
reconnect can expose it.

## Decision implication

Universal automatic downward pagination is unnecessary for the normal newest-first conversation
flow. It would add cache state, anchoring cases, and accidental fetch opportunities without making
ordinary history traversal faster.

The measured compromise is a **targeted newer-page path** for centered/search/gap windows:

- keep the current 100-row newest page and older-only automatic scrolling;
- retain `afterSequence` and `hasMoreAfter` from message context;
- expose “load newer” only while the current view is a centered window or a detected refresh gap;
- return to the canonical newest page once the newer boundary is reached;
- cap retained primary pages independently of the centered search window.

This resolves the measured 50-message gap while keeping the everyday state machine and UI simple.

## Isolated Electron/CDP replay path

The least invasive UI replay uses the existing production renderer proxy and a disposable Chromium
profile:

```sh
bun --filter @openbot/desktop build

OPENBOT_AUDIT_API_URL=http://127.0.0.1:8882 \
OPENBOT_AUDIT_RENDERER_PORT=5182 \
bun scripts/performance/serve-renderer.ts

pagination_profile="$(mktemp -d /tmp/openbot-message-pagination-electron.XXXXXX)"
OPENBOT_RENDERER_URL='http://127.0.0.1:5182/?profile=1' \
OPENBOT_HOST_BRIDGE_PORT=8893 \
apps/desktop/node_modules/.bin/electron \
  --remote-debugging-port=9342 \
  --user-data-dir="$pagination_profile" \
  apps/desktop

OPENBOT_AUDIT_CDP_URL=http://127.0.0.1:9342 \
bun scripts/performance/cdp-snapshot.ts pagination-replay
```

This targets the disposable API fixture and never opens the installed application's profile.

## Limitations

- Latencies are warm, localhost timings; network RTT should be added when reasoning about remote
  deployments.
- The 200 KB fixture represents one legal pathological message, not a page containing 100 such
  messages.
- API timings do not include React reconciliation, virtual measurement, Markdown parsing, or paint.
- PostgreSQL plan times reflect the warm isolated fixture and are used to compare query shape, not
  production hardware capacity.
