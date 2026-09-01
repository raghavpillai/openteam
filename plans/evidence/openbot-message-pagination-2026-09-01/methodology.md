# OpenBot message-history pagination benchmark

This benchmark compares three client-side history policies without changing production code:

- **A — current/unbounded:** the existing older-only cursor and `mergeLoadedChannelHistoryPage`; every page loaded into the active channel remains retained.
- **B — bounded/older-only:** the same API and merge behavior, with a rolling five-page/500-message primary window. Loading toward older history evicts the newest edge; returning to the newest messages reloads the latest page.
- **C — search-only bidirectional:** the same bounded normal path as B, plus a separate 50-before/target/50-after lane for search and deep links. Only that lane retains and uses the server's existing `beforeSequence`, `afterSequence`, `hasMoreBefore`, and `hasMoreAfter` fields.

The five-page cap is an explicitly modeled policy, not a claim about current production behavior.

## Reproduction

From the repository root:

```sh
bun scripts/performance/benchmark-message-pagination.ts \
  --output=plans/evidence/openbot-message-pagination-2026-09-01/summary.json \
  > /dev/null
```

The committed evidence used Bun 1.3.8 on an Apple M4 Pro, with seven complete traversal iterations and 31 point samples. Fixtures are deterministic, use a fixed timestamp, and contain stable IDs, message content, metadata, attachments, reactions, and reply shapes.

## What is measured

The script exercises the actual OpenBot helpers for history page/context merging, message normalization, render keys, address indexes, thread derivation, message display projection, and virtual layout/range calculation. It measures:

- initial and older-page merge CPU;
- cumulative merge CPU while traversing all older pages;
- cumulative renderer data-projection work after each page;
- steady-state latest-page refresh/append work;
- exact UTF-8 JSON and content-plus-metadata bytes for unique retained messages;
- deterministic request counts and response JSON bytes for history and deep-search journeys.

The renderer proxy covers the synchronous work whose cost changes with retained message count. It does **not** claim to measure React commit, Markdown/highlighter initialization, DOM measurement, image decode, paint, HTTP latency, database latency, or Electron IPC. Serialized bytes are a deterministic payload-size proxy, not JavaScript heap size; real heap retention includes engine/object overhead and can be larger.

## Workloads

| Workload | Messages | Mean serialized message | Pages | Purpose |
|---|---:|---:|---:|---|
| Recent mixed | 100 | 608 B | 1 | Normal open |
| Long mixed | 1,000 | 604 B | 10 | Realistic long conversation |
| Long rich | 1,000 | 8,308 B | 10 | Markdown and attachment-heavy stress |
| Extreme mixed | 10,000 | 607 B | 100 | Exhaustive-scroll stress |
| Extreme rich | 10,000 | 8,558 B | 100 | Combined history-depth and payload-size stress |

## Results

All timings below are p50 values in milliseconds. B and C deliberately share the same normal-history algorithm, so small timing differences between their separate runs are measurement noise rather than an algorithmic difference.

| Workload | Policy | Retained JSON | Traverse merge | Traverse projection | Final projection | Latest refresh merge |
|---|---|---:|---:|---:|---:|---:|
| 100 mixed | A | 60.8 KB | 0.060 | 0.172 | 0.129 | 0.050 |
| 100 mixed | B | 60.8 KB | 0.049 | 0.112 | 0.103 | 0.039 |
| 1,000 mixed | A | 604.5 KB | 1.932 | 4.792 | 0.846 | 0.343 |
| 1,000 mixed | B | 301.7 KB | 1.547 | 3.442 | 0.429 | 0.166 |
| 1,000 rich | A | 8.31 MB | 1.929 | 5.155 | 0.899 | 0.340 |
| 1,000 rich | B | 4.14 MB | 1.678 | 3.923 | 0.467 | 0.175 |
| 10,000 mixed | A | 6.07 MB | 189.757 | 475.666 | 9.056 | 3.491 |
| 10,000 mixed | B | 301.7 KB | 20.276 | 43.718 | 0.428 | 0.174 |
| 10,000 rich | A | 85.58 MB | 194.063 | 481.461 | 10.960 | 3.826 |
| 10,000 rich | B | 4.14 MB | 22.069 | 46.550 | 0.517 | 0.184 |

At 10,000 mixed messages, the 500-message window reduces the deterministic retained payload by **95%**, cumulative merge work by **9.4×**, cumulative renderer projection by **10.9×**, final projection by **21.2×**, and latest-page refresh merge by **20.1×**. The combined 10,000-message/rich-payload case retains 85.58 MB unbounded versus 4.14 MB bounded, a **95.2%** reduction, with similar CPU ratios. At 1,000 messages, the memory and steady-state CPU benefit is approximately 2×. At 100 messages, bounding provides no material benefit because the history already fits in one page.

Rich content changes retained bytes far more than these projection timings because the benchmark deliberately excludes Markdown parsing and only projects the virtualized mounted rows. A 500-message count cap retains 4.14 MB in the rich fixture, which supports combining a count cap with a byte budget rather than relying on count alone.

## Request and UX trade-offs

| Journey | A: current | B: bounded older-only | C: search-only bidirectional |
|---|---:|---:|---:|
| Open newest 100 | 1 request | 1 | 1 |
| Traverse all 10,000 toward older | 100 total | 100 | 100 |
| Return newest after exhaustive older traversal | 0 | 1 | 1 |
| Open a deep search hit in an already-open channel | 1 context request | 1 | 1 |
| Reach the 20%-depth hit without the context endpoint | 80 total history pages | 80 | 80 |
| Continue from the search hit to 300 messages newer | Unsupported past returned context | Unsupported | 3 additional pages |
| Jump directly from search context to newest | 0; recent lane already retained | 0 | 0 |

The policy trade-offs are:

- **A** has the simplest continuity model: every loaded row remains locally scrollable, returning to newest costs no request, and live appends join one array. Its cost is unbounded renderer memory and history-sized merge/projection work.
- **B** bounds normal-history CPU and memory without changing the server API. Its downside is UX, not raw speed: after the rolling window evicts the newer edge, ordinary downward scrolling cannot cross that gap. The app needs an explicit “jump to newest” reset, and live appends while viewing an old window need a separate newest/unread lane rather than being inserted as though the array were continuous.
- **C** has B's bounded common path and adds newer-page state only when navigation began from a search result or deep link. It preserves direct search and instant jump-to-newest behavior while allowing continuous reading around the target. It does require explicit two-lane/gap semantics, overlap deduplication, cursor invalidation, and realtime-insert tests.

The current server context endpoint is already the important optimization: a deep target takes one warm request instead of up to 80 sequential history pages in the 10,000-message fixture. The current desktop client, however, discards the returned newer cursor. Retaining it only for search/deep-link mode enables continuous exploration beyond the 50 newer messages already returned.

Continuing 300 messages newer from a search hit takes three additional 100-message requests. The measured total merge-plus-projection cost is 1.62 ms p50 for the 10,000 mixed fixture and 1.83 ms for the 10,000 rich fixture. The three response-page payloads are 154 KB mixed or 2.15 MB rich. No additional requests occur unless the user actually crosses the newer edge of the search window.

## Decision supported by the data

The best cost/complexity balance is C:

1. Keep ordinary conversation navigation older-only; normal chat does not need a newer cursor.
2. Bound the active primary history, initially testing five pages/500 messages plus a byte ceiling.
3. Preserve the current direct `around` lookup and retain bidirectional cursors only while a search/deep-link context is active.
4. Keep the recent lane available so “jump to newest” remains immediate from search mode.
5. When ordinary older exploration evicts the newest edge, expose an explicit gap/jump affordance and reload the latest page rather than silently pretending the window is continuous.

This avoids bidirectional-state complexity on every conversation, captures the measured bounded-memory and bounded-CPU gains, and spends extra network requests only on the uncommon action that actually needs downward pagination: reading forward from an old searched or linked message.

Before production rollout, validate scroll anchoring, thread context, realtime inserts, gap affordances, search-context clearing, keyboard focus, and exact visual parity in Electron. This microbenchmark establishes the scaling trade-off; it is not a replacement for that CUA A/B pass.
