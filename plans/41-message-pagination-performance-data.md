# Message pagination performance data and rollout decision

**Date:** 2026-09-01

**Status:** evidence complete; production implementation and true Electron A/B still gated

**Deterministic evidence:** [methodology](./evidence/openbot-message-pagination-2026-09-01/methodology.md) · [raw results](./evidence/openbot-message-pagination-2026-09-01/summary.json)

**Live API evidence:** [methodology](./evidence/openbot-message-pagination-2026-09-01/live-api-methodology.md) · [raw results](./evidence/openbot-message-pagination-2026-09-01/live-api.json)
**Current Electron evidence:** [raw observation](./evidence/openbot-message-pagination-2026-09-01/electron-current.json)

## Decision

Use a bounded, older-only window for ordinary chat history and reset to the latest page when the
user jumps back to the present. Add newer/downward pagination only to centered contexts that need
it: search results, message deep links, and a detected reconnect/unread gap.

This captures the measured memory and CPU benefit without putting a bidirectional state machine in
every conversation. A five-page/500-message count cap is the measured starting point. It should be
paired with a separately validated byte ceiling because 500 rich messages can still be large.

This evidence pass did not change desktop or mobile pagination behavior, so it is not an interaction
A/B and makes no claim of renderer improvement or complete UX parity yet. Follow-up groundwork now
provides a shared bounded-window policy helper and optional one-sided context requests, but neither
client consumes them yet. The current UI style is unchanged, and rollout remains behind the
acceptance gate below.

## What the app does today

- Desktop requests 100 messages initially and on every older page, and keeps at most three channel
  histories warm. Each warm channel's message array itself is unbounded
  ([use-openbot.ts](../apps/desktop/src/renderer/state/use-openbot.ts)).
- Loading older history merges, deduplicates, and sorts the growing primary array
  ([history.ts](../packages/product-core/src/history.ts)). The chat pane then derives maps, sets,
  threads, and sorted views over that data before the DOM virtualizer limits mounted rows
  ([chat-pane.tsx](../apps/desktop/src/renderer/components/openbot/chat-pane.tsx)).
- The timeline virtualizer uses a maximum of 80 items with 900 px overscan, so DOM growth is bounded
  even while retained React/application state grows.
- Older pages use a keyset cursor and the database has a `(channelId, sequence)` index. The server
  accepts at most 200 rows and defaults to 100
  ([snapshot-service.ts](../apps/server/src/services/snapshot-service.ts),
  [schema.prisma](../packages/db/prisma/schema.prisma)).
- The message-context API already returns `beforeSequence`, `afterSequence`, `hasMoreBefore`, and
  `hasMoreAfter`. Desktop currently merges the returned messages but discards those context cursors
  and flags, so a searched message can be opened but the 50-message newer edge cannot be extended.

The scaling problem is therefore renderer retention and repeated whole-history projection, not
deep keyset lookup or mounted DOM count.

## Measured results

### Deterministic client benchmark

The benchmark exercised OpenBot's actual history/context merge helpers and representative renderer
projection helpers. It did not measure React commit, Markdown parsing, DOM measurement, image
decode, paint, Electron IPC, HTTP, or database time. Timings are p50 on the recorded Apple M4 Pro
run; retained JSON is a deterministic payload proxy, not JavaScript heap.

| Workload | Policy | Retained JSON | Full traversal merge | Full traversal projection | Final projection | Latest refresh merge |
|---|---|---:|---:|---:|---:|---:|
| 1,000 mixed | Current unbounded | 604.5 KB | 1.932 ms | 4.792 ms | 0.846 ms | 0.343 ms |
| 1,000 mixed | Bounded to 500 | 301.7 KB | 1.547 ms | 3.442 ms | 0.429 ms | 0.166 ms |
| 10,000 mixed | Current unbounded | 6.07 MB | 189.757 ms | 475.666 ms | 9.056 ms | 3.491 ms |
| 10,000 mixed | Bounded to 500 | 301.7 KB | 20.276 ms | 43.718 ms | 0.428 ms | 0.174 ms |
| 10,000 rich | Current unbounded | 85.58 MB | 194.063 ms | 481.461 ms | 10.960 ms | 3.826 ms |
| 10,000 rich | Bounded to 500 | 4.14 MB | 22.069 ms | 46.550 ms | 0.517 ms | 0.184 ms |

At 10,000 mixed messages, the modeled 500-message window reduced retained JSON by **95.0%**,
cumulative merge work by **9.4×**, cumulative renderer projection by **10.9×**, final projection by
**21.2×**, and latest-refresh merge by **20.1×**. At 100 messages, bounding had no material benefit
because one page already fits. The rich fixture shows why a count limit alone is insufficient: its
bounded 500-message window still serialized to 4.14 MB.

The bounded normal path and the search-only bidirectional policy use the same normal-history
algorithm, so their ordinary-chat performance is equivalent. From a centered search hit, reading
300 messages newer added three 100-message requests. Their total merge-plus-projection cost was
1.62 ms p50 for mixed content and 1.83 ms for rich content, with 154 KB and 2.15 MB transferred
respectively. No newer-page requests occur unless the user crosses that context edge.

### Live server and database

The isolated live stack contained 1,102 channels, 32,385 messages, and a 10,020-message transcript.
Warm localhost results were:

| Operation | Result |
|---|---:|
| Newest 100-row keyset page | 1.371 ms p50 / 2.213 ms p95; 40,917 B |
| 100-row page 9,900 messages deep | 1.648 ms p50 / 2.501 ms p95; 40,708 B |
| Matching PostgreSQL index plan, newest / deep | 0.057 / 0.065 ms |
| Complete 10,020-message walk | 101 requests; 4,099,579 B; 169.3 ms local |
| Centered 200 KB message with 50 before/after | 5.170 ms p50 / 5.940 ms p95; 273,194 B |

Depth did not produce a meaningful latency trend. A page-size sweep measured 20/50/100/200 rows at
1.129/1.462/1.634/2.142 ms p50 and 8,310/20,544/40,917/81,663 response bytes. Keeping 100 as the
network page size is reasonable; bounding retained pages creates much more benefit than halving the
page size.

The centered context endpoint is already the critical deep-navigation optimization. A target at
20% transcript depth takes one warm context request; traversing from the newest edge without it
would require 80 history pages in this fixture.

### Current Electron observation

An isolated production renderer was driven through the actual Electron UI against the same
fixture. These are current-build observations only, not before/after results.

| Declared messages | Mounted timeline rows | CDP `Runtime.getHeapUsage().usedSize` | Idle 120-frame maximum |
|---:|---:|---:|---:|
| 100 | 25 | 19,362,780 B | 20.6 ms |
| 600 | 38 | 22,014,156 B | 21.5 ms |
| 1,000 | 38 | 22,545,740 B | 19.3 ms |
| 5,000 | 38 | 27,595,636 B | 17.7 ms |

From 100 to 5,000 declared messages, used heap grew by 8,232,856 B (42.5%) while mounted rows stayed
bounded. That is consistent with the source and deterministic benchmark: virtualization controls
DOM work but does not bound retained message state or whole-array derivations.

The frame samples were taken after each load had settled. The lower maximum at 5,000 is not evidence
of an improvement, and these samples cannot establish interaction latency or compare the proposed
policy. A valid Electron A/B must instrument page-load input-to-paint and scroll anchoring on two
otherwise identical builds.

## Policy trade-offs

“Newer” below means paginating downward toward the present after starting from an old/centered
window.

| Policy | Memory/CPU | Requests | UX and correctness | Complexity | Verdict |
|---|---|---|---|---|---|
| Current older-only, unbounded | Grows with every traversed page | No request to return latest | One continuous retained array, but reconnect can contain a silent hole | Low initially; poor scale | Reject at long-history scale |
| Bounded older-only everywhere | Bounded common path | Same older requests; normally one latest reset after the newest edge is evicted | Simple normal scrolling, but cannot continue newer across an old/search window | Moderate | Good normal-chat foundation, incomplete for targeted navigation |
| Bounded normal history + newer pagination only in context mode | Same bounded common path; bounded context lane | Extra requests only when reading forward from a search/link/gap | Continuous reading around a target and explicit jump to latest | Moderate, isolated to context state | **Recommended** |
| Bidirectional pagination in every conversation | Can be bounded | May refetch both edges | Maximum local continuity | Highest anchor, cursor, race, realtime, and gap surface | Cost is not justified by measured normal use |

The recommended policy deliberately accepts one latest-page reset after deep ordinary-history
exploration. It avoids paying bidirectional-state complexity on the common newest-first route while
preserving the one route where users actually need downward continuation.

## Reconnect correctness issue

The live harness replayed the current merge behavior with 100 cached rows followed by 150 messages
arriving while the renderer was suspended. Refresh fetched only the newest 100 and merged them with
the old 100. The result retained 200 rows but silently omitted **50 messages** between the two sets.

This is a correctness gap, not a database-performance problem. The first implementation must detect
whether a latest refresh overlaps the cached newest edge by message ID. If it does not overlap,
desktop must not present the arrays as contiguous: reset to the canonical latest tail, preserve an
unread/gap marker, and use centered context only when the user opens a target in that gap. Sequence
`+1` is not a safe channel-contiguity test because sequences are globally allocated across channels.

A 50/50 centered request recovered a target in the measured gap in 1.737 ms p50 and 41,450 B, and
returned truthful cursors in both directions. Retaining those cursors only in context mode is enough
to make recovery navigable.

## Recommended state model

Keep the modes explicit rather than treating disjoint arrays as one continuous transcript:

1. **Latest tail:** canonical newest page/window, older-only under normal use.
2. **History excursion:** bounded older window with a visible newer gap after eviction; “Jump to
   latest” resets to the canonical tail instead of paging down through the entire excursion.
3. **Centered context:** search result, message deep link, or reconnect/unread target with before and
   after cursors; either edge may load, and loading one edge evicts the far edge when the cap is hit.

Start with five 100-message pages and test a candidate 2 MiB retained-content ceiling separately.
Never evict the active scroll anchor, pending local sends, the centered target, required thread
roots/ancestors, or the latest-tail metadata needed for unread state. Realtime messages received
while an old or centered window is active should update the latest/unread lane rather than be
inserted into a disjoint visible array.

No new visual language is required. Reuse the existing conversation surfaces and tokens for a
small gap/loading affordance and the existing jump-to-latest control. Message cards, spacing,
Markdown, reactions, threads, composer behavior, selection, keyboard navigation, and accessibility
semantics should remain unchanged.

## Implementation and acceptance gate

No production rollout should be called complete until all of the following pass:

### 1. Policy implementation behind a reversible flag

- Add explicit `latest`, `history`, and `context` state rather than overloading one array.
- Bound normal retained history by page count and a tested byte budget.
- Preserve and consume context `beforeSequence`/`afterSequence` and both `hasMore` flags.
- Detect no-overlap refreshes, represent a gap, and reset safely to latest.
- Deduplicate overlapping pages by ID; cancel or ignore stale channel/context requests.

### 2. Deterministic and API gates

- Re-run the committed benchmark on current and candidate builds with identical fixtures. At 10,000
  mixed messages the candidate must retain no more than the configured cap and preserve the measured
  order-of-magnitude reduction in traversal/projection work without worsening the 100-message case.
- Re-run live keyset, page-size, centered-context, rich-message, deep-thread, and 150-arrival gap
  cases. Assert no missing or duplicate IDs in every lane and after every reset.
- Keep the 100-row server default unless remote-network data, not localhost latency alone, supports a
  change.

### 3. Functional and visual parity

- Verify prepend anchoring, repeated older loads, latest reset, search before/after continuation,
  message links, unread/gap navigation, thread roots/replies, pending sends, reactions, attachments,
  retry/offline recovery, channel switching/LRU eviction, keyboard focus, and screen-reader order.
- Use CUA screenshots and geometry checks at 100, 500, and 5,000 messages on matched current and
  candidate builds. There must be no unintended difference in card styling, density, composer,
  header/sidebar, scroll position, focus, or controls.

### 4. Real Electron A/B

- Use the same production bundle settings, isolated profile, database fixture, viewport, route,
  message payloads, warmups, and sample count for both builds.
- Measure input-to-next-paint for older-page loads, sustained scroll frame intervals, long tasks,
  React commit/reconcile timings, heap after controlled GC, mounted DOM/listeners, API bytes, and
  latest-reset/search-context latency.
- Require bounded heap at steady state, no new long-task/frame regression, no scroll jump, and no
  regression in search/deep-link completion or usability. Record failures and retries rather than
  discarding slow samples.

## Validation performed in this pass

- A second full deterministic run completed in 16.72 seconds and reproduced the committed
  observable checksum `1448303310`, every fixture ID, byte/count field, and request field.
- A second live-API run reproduced the 10,020-message transcript, 101-request/4,099,579-byte walk,
  depth-stable page shape, and exact 50-message reconnect gap. Its complete local walk was
  177.8 ms versus the recorded 169.3 ms; latency distributions are expected to vary between runs.
- The 41 focused server pagination, client contract, shared-history, and virtual-window tests
  passed with 149 assertions and no failures.
- Both benchmark entry points passed Biome and Bun bundling. All evidence JSON parses, every local
  report link resolves, and `git diff --check` passes.

Until that gate produces candidate-build measurements and a full CUA replay, the data supports the
design decision but not a claim that the proposed implementation is already faster or behaviorally
identical.
