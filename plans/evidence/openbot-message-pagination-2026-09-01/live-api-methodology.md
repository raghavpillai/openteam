# Live message-pagination API methodology

## Scope and isolation

Measurements used the disposable Compose project `openbot-message-pagination-ab` at
`http://127.0.0.1:8882`. Authentication was disabled for this isolated server and its disposable
PostgreSQL volume. The installed OpenBot app, its profile, its normal database, and the user's other
running containers were not used.

The fixture contained 1,102 bots, 1,102 channels, and 32,405 messages. Bootstrap exposed 1,001 bots
and all 1,102 channels. `Audit Bot 0001` contained 10,040 messages. `iOS Stress Fixture` supplied a
200,000-byte message, a 125-edge ancestor chain, and a 250-reply wide thread for pathological
payload and ancestry probes.

## Reproduction and measurement

The harness is
[`scripts/performance/benchmark-message-pagination-live-api.ts`](../../../scripts/performance/benchmark-message-pagination-live-api.ts).
It performs three warmups and 20 measured requests at each point:

```sh
OPENBOT_PERF_BASE_URL=http://127.0.0.1:8882 \
OPENBOT_PAGINATION_WARMUPS=3 \
OPENBOT_PAGINATION_SAMPLES=20 \
OPENBOT_AUDIT_OUTPUT=plans/evidence/openbot-message-pagination-2026-09-01/live-api.json \
bun scripts/performance/benchmark-message-pagination-live-api.ts
```

End-to-end time starts immediately before `fetch` and ends after JSON decoding. TTFB ends when
`fetch` resolves with response headers. Response bytes are the raw `ArrayBuffer.byteLength` returned
by Fetch. The full-history walk is one sequential discovery pass; each distribution below comes
from the subsequent three-warmup/20-sample point benchmark.

History depth was reached only by following the returned `beforeSequence`. The benchmark did not
substitute offset pagination or a database cursor. The reconnect probe is a deterministic replay
over existing rows: it feeds the actual history merge helper a 100-row cached page and a newest
100-row page after modeling 150 intervening arrivals, then uses the actual context merge helper to
recover one row inside the gap.

## Results

All durations are milliseconds. Full distributions, exact cursors, fixture IDs, TTFB, decode time,
and response sizes are retained in [`live-api.json`](./live-api.json).

### Keyset depth

| Messages newer than page | Rows | Response bytes | End-to-end p50 | p95 |
|---:|---:|---:|---:|---:|
| 0 | 100 | 40,937 | 1.508 | 2.285 |
| 100 | 100 | 40,916 | 1.559 | 3.478 |
| 1,000 | 100 | 40,916 | 1.653 | 2.570 |
| 5,000 | 100 | 40,916 | 1.580 | 3.156 |
| 9,900 | 100 | 40,737 | 1.591 | 3.098 |
| 10,000, terminal | 40 | 17,226 | 1.280 | 3.979 |

The warm-local results do not show a depth-dependent slowdown: the 9,900-deep page is within
0.083 ms of the latest page at p50. Walking all 10,040 messages required 101 requests, transferred
4,107,789 bytes, and took 180.425 ms end to end. This confirms that server keyset traversal is not
the growth problem; retaining every traversed page in the renderer is.

### Page-size scaling

| Requested rows | Response bytes | Decode p50 | End-to-end p50 | p95 |
|---:|---:|---:|---:|---:|
| 20 | 8,380 | 0.026 | 1.086 | 2.063 |
| 50 | 20,564 | 0.070 | 1.320 | 3.668 |
| 100 | 40,937 | 0.120 | 1.650 | 3.574 |
| 200 | 81,683 | 0.218 | 2.746 | 6.072 |

Fifty rows save about 20 KB but only 0.330 ms p50 on this stack; 200 rows double the response and
add 1.096 ms p50. A 100-row network page is therefore a reasonable middle point. The client should
bound retained pages rather than reduce every request and make users fetch more often.

### Centered contexts and pathological content

| Request | Primary rows | Ancestors | Response bytes | End-to-end p50 | p95 |
|---|---:|---:|---:|---:|---:|
| Plain target, 0/0 | 1 | 0 | 706 | 1.495 | 3.041 |
| Wide-thread leaf, 0/0 | 1 | 1 | 1,089 | 2.282 | 5.714 |
| 125-deep leaf, 0/0 | 1 | 100, truncated | 38,991 | 3.898 | 5.389 |
| 200 KB target, 0/0 | 1 | 0 | 202,567 | 3.068 | 4.898 |
| 200 KB target, 50/50 | 101 | 76 | 273,194 | 5.188 | 6.116 |
| History page containing 200 KB target | 100 | 27 | 250,733 | 4.034 | 6.876 |
| Latest wide-thread history page | 100 | 1 | 45,416 | 2.333 | 4.275 |

The server caps recursive ancestor context at 100 rows and reports truncation. Even the 273 KB
centered response remained 6.116 ms at p95 on localhost. These numbers do not include Chromium's
Markdown parsing, layout, image decode, React commit, or paint, so they support the API shape but
cannot establish scroll smoothness by themselves.

### Reconnect gap

With 150 modeled arrivals between latest-page refreshes, a 100-row cache plus a newest 100-row
response retained 200 unique rows and left 50 arrivals absent. A 50/50 context request recovered a
target in that gap in 1.989 ms p50, returned 41,450 bytes, and truthfully reported both
`hasMoreBefore` and `hasMoreAfter`.

This is why the candidate keeps normal history older-only but preserves a newer cursor for search,
deep-link, and detected-gap contexts. Universal downward pagination would add state to the common
newest-first path without improving the measured server query.

## Limits

- These are warm localhost figures; add real network RTT and production contention when estimating
  remote latency.
- The 200 KB probe is one legal pathological message, not 100 such messages in one response.
- Full traversal is a single sequential pass, not a latency distribution.
- API results do not include renderer heap, React reconciliation, virtual measurement, Markdown,
  layout, paint, input latency, or compositor frames. Those belong to the packaged Electron A/B.
