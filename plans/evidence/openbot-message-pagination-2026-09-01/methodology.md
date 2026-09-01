# Deterministic message-window benchmark

## Question and arms

This benchmark isolates the synchronous work whose scale changes when a user traverses a long
conversation. It compares:

- **A — prior unbounded renderer:** the pre-feature older-only merge policy; every traversed page
  remains in the active history array.
- **B — bounded control:** the production count/byte reducer on normal older-only history, but
  without newer context expansion.
- **C — bounded candidate:** the actual candidate policy—bounded normal history, a cached latest
  tail, and a separate bidirectional search/deep-link/gap context.

C is the product decision. B exists only to isolate the value and cost of bidirectional context.
B and C share the same normal-history algorithm, so small differences on that path are timing
noise.

The production ceiling is an aggregate unique-ID union: at most 500 retained channel-window
messages and 2,097,152 retained bytes across primary history, thread ancestry, centered context,
and the cached latest tail. It is not simply “five visible pages.” After a deep mixed traversal, for
example, the candidate retains 400 primary rows plus a 100-row latest tail. Rich messages hit the
byte limit before the count limit.

## Reproduction

From the repository root:

```sh
bun scripts/performance/benchmark-message-pagination.ts \
  --output=plans/evidence/openbot-message-pagination-2026-09-01/summary.json
```

The retained run used Bun 1.3.8 on an Apple M4 Pro, seven complete traversal iterations, and 31
point samples. A fixed epoch, stable IDs, and deterministic content, metadata, attachments,
reactions, and reply shapes make outcomes reproducible. The full result contains observable
checksum `7077200170`; a second full run against the later viewport-pivot worktree reproduced the
same checksum.

## Production code exercised

The bounded arms call the real desktop reducer:

- `applyPrimaryHistoryPage`;
- `enterMessageContext` and `expandMessageContext`;
- `resetToLatestTail`;
- `visibleChannelHistoryMessages`;
- the shared count/byte window helpers and exact retained-byte accounting.

All arms also run the real history normalization, thread derivation, render-key/address indexes,
message projection, and virtual-layout/range helpers. Each page therefore incurs the same
deterministic renderer data-projection proxy after merge.

This harness does **not** have a DOM viewport. It does not measure the candidate's viewport-pivot
selection, anchor restoration, React commit, Markdown/highlighter initialization, DOM measurement,
image decode, paint, Electron IPC, HTTP, or PostgreSQL. Those belong to focused reducer tests and
the packaged Electron A/B. “Retained JSON” is deterministic serialized payload size, and
“production retained bytes” is the reducer's per-message byte accounting; neither is JavaScript
heap.

## Fixtures

| Workload | Messages | Mean serialized row | Pages | Classification |
|---|---:|---:|---:|---|
| Recent mixed | 100 | 608 B | 1 | realistic open |
| Long mixed | 1,000 | 604 B | 10 | realistic long chat |
| Long rich | 1,000 | 8,308 B | 10 | rich-content stress |
| Extreme mixed | 10,000 | 607 B | 100 | depth stress |
| Extreme rich | 10,000 | 8,558 B | 100 | depth + payload stress |

## Normal-history results

All CPU figures below are p50 milliseconds. “Traverse” is cumulative across every page; “final
projection” is one projection after the complete walk. C is the actual candidate.

| Workload | Arm | Retained JSON | Unique rows | Traverse merge | Traverse projection | Final projection | Latest refresh merge |
|---|---|---:|---:|---:|---:|---:|---:|
| 100 mixed | A | 60.8 KB | 100 | 0.054 | 0.168 | 0.131 | 0.050 |
| 100 mixed | C | 60.8 KB | 100 | 0.206 | 0.103 | 0.101 | 0.250 |
| 1,000 mixed | A | 604.5 KB | 1,000 | 1.925 | 4.770 | 0.885 | 0.333 |
| 1,000 mixed | C | 301.9 KB | 500 | 10.297 | 3.110 | 0.336 | 0.929 |
| 1,000 rich | A | 8.31 MB | 1,000 | 1.976 | 5.304 | 0.891 | 0.347 |
| 1,000 rich | C | 2.09 MB | 254 | 6.088 | 1.657 | 0.164 | 0.304 |
| 10,000 mixed | A | 6.07 MB | 10,000 | 181.944 | 461.646 | 9.188 | 3.456 |
| 10,000 mixed | C | 302.6 KB | 500 | 134.640 | 39.687 | 0.350 | 0.934 |
| 10,000 rich | A | 85.58 MB | 10,000 | 197.983 | 498.477 | 10.747 | 3.868 |
| 10,000 rich | C | 2.09 MB | 251 | 62.475 | 16.350 | 0.161 | 0.323 |

The trade is visible rather than hidden:

- At 100 rows, union accounting adds about 0.15–0.20 ms to merge work and produces no memory
  benefit. It remains well below one millisecond in this CPU-only harness.
- At 1,000 mixed rows, the bounded reducer spends more cumulative merge CPU (10.297 versus
  1.925 ms) to enforce the aggregate union, although final projection is 2.6× lower and retained
  payload is halved. This is the crossover region, not a universal speedup.
- At 10,000 mixed rows, retained payload falls 95.0%, cumulative projection falls 11.6×, final
  projection falls 26.3×, and latest refresh merge falls 3.7×. Merge plus projection over the full
  walk falls from 643.590 to 174.327 ms.
- At 10,000 rich rows, the byte ceiling cuts retained payload 97.6%; cumulative projection is
  30.5× lower, final projection 66.8× lower, and latest refresh merge 12.0× lower.

Every bounded fixture stayed at or below both production ceilings. The largest observed traversal
peak was 2,097,141 bytes—11 bytes below 2 MiB. The separate tests cover the only documented soft
excesses: one indivisible oversized row or a mandatory visible protected span.

## Search and navigation

For the 10,000-message fixtures, the target is at 20% transcript depth. The existing context
endpoint opens it with one context request (two total on a cold channel, including latest-tail
initialization); sequential older-only history would need 80 page requests.

The 50-before/target/50-after context initially returns 101 rows. Expanding 300 messages in each
direction takes six additional requests. In the mixed fixture, the production reducer's six-page
merge-plus-projection is 9.437 ms p50 and finishes at the 500-row aggregate cap. In the rich
fixture it is 5.434 ms p50 and finishes with 244 unique rows / 2,096,966 production bytes because
the byte limit wins first. Network payload for those six rich pages is 4.35 MB, which is paid only
when a user actually explores both directions around that old result.

After exhaustive normal history traversal, `resetToLatestTail` restores the cached newest 100 rows
without a request in 0.067 ms p50 for the 10,000 mixed fixture and 0.070 ms for rich. This is why
the candidate caches a small latest tail instead of adding universal downward pagination.

## Interpretation

The data supports a bounded common path with targeted bidirectional contexts:

1. Keep 100-row keyset pages; the live API benchmark shows little local benefit from smaller pages.
2. Keep ordinary chat older-only and spend context state only on search, deep links, and real gaps.
3. Bound by both count and bytes across all retained lanes, not by primary-array length alone.
4. Keep the latest 100-row tail for an immediate, request-free jump to the present.
5. Preserve the actual visible span and fill in the user's scroll direction before trimming the
   opposite edge; validate that UI behavior in Electron rather than inferring it from this harness.

The deterministic benchmark establishes the scaling curve and exposes the small/medium-history
overhead honestly. It is not sufficient rollout evidence without scroll anchoring, frame, heap,
focus, accessibility, reply/thread, and visual-parity checks.
