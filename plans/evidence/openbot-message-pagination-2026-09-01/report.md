# Desktop message-history performance and UX report

Status: deterministic reducer, live API, and focused correctness evidence are complete. Packaged
candidate Electron values and final multi-resolution parity are marked `PENDING_CANDIDATE`.

## Executive conclusion

The correct design is a bounded data window behind the existing virtualized transcript—not
smaller network pages and not universal pagination in both directions.

The prior renderer already keeps mounted DOM rows flat, so it can look smooth while retaining an
ever-growing JavaScript history. In the matched packaged baseline, forced-GC heap grew from
16.71 MB at the newest 100 rows to 25.30 MB after traversing roughly 5,000 rows (+8.58 MB / 51.4%),
while DOM nodes stayed essentially flat (1,246 to 1,229). The deterministic 10,000-row fixture
shows the downstream cost: the prior projection proxy reaches 9.19–10.75 ms for one pass and grows
with history depth.

The candidate caps the channel-window union at 500 unique messages and 2 MiB, preserves the actual
visible rows when either edge is trimmed, and keeps a cached newest tail for an immediate return to
the present. Search/deep-link/gap contexts alone can page in both directions. This gives the common
chat path less state while preserving the one workflow that genuinely needs downward pagination.

The reducer and API evidence support rollout. Final approval still depends on the packaged
candidate proving all three together:

- retained heap plateaus;
- rAF/anchor behavior is no worse than the already-smooth baseline;
- styling, focus, replies, threads, search, and accessibility remain equivalent.

## What the code audit found

| Finding | User-visible risk | Resolution |
|---|---|---|
| Virtualization bounded DOM, but every fetched message remained in renderer state | Heap, merge, indexes, and projection grow during long sessions | Bound the retained unique-ID union, not just mounted rows |
| A 500-row count limit still retained 4+ MB in the original rich model | Markdown/metadata-heavy histories defeat count-only policies | Add an exact 2 MiB production byte ceiling |
| Independently capped primary, context, ancestry, and latest lanes could exceed the total | Hidden duplicate caches silently recreate unbounded retention | Reconcile one deduplicated union across all lanes |
| Naive edge retention could keep an entire rich edge-to-anchor range or evict the visible row | Jumping or blanking while a page arrives | Pivot around the reported visible span; fill scroll direction first |
| A live arrival at the 500-row boundary could evict an off-bottom reader | Reading position moves when somebody sends | Apply the same viewport pivot to refresh and patch paths |
| Raw `scrollTop` is not meaningful after eviction or channel-window regeneration | A → B → A restores the wrong content | Persist message identity + within-row offset + generation, with explicit latest fallback |
| Search returned newer cursors but the old client discarded them | A deep result could not continue beyond its first 50 newer rows | Retain before/after cursors only in context mode |
| Jumping to latest by refetching would add latency and network failure to a basic action | “Back to now” feels slow or fails offline | Cache the newest 100-row tail and swap it into view |
| Eviction could remove an active reply target or open thread data | Reply silently targets the root, or thread tray collapses | Pin the active reply; give the open tray a 100-message / 512 KiB bounded snapshot and latest-reply ID |
| Prepending history could look like new incoming messages | Incorrect unread/new-message notice | Count authoritative tail growth by latest message identity, independent of the thinking row |
| A disappearing jump button could retain focus nowhere | Keyboard regression | Move focus to the stable transcript viewport before the control unmounts |
| Transcript rows lacked explicit list semantics; thread centering ignored reduced motion | Screen-reader order and motion-setting regression | Add list/listitem semantics and reduced-motion-aware thread navigation |

## Resulting architecture

| Layer | Policy |
|---|---|
| Server | 100-row keyset pages using `beforeSequence`; centered context returns 50/target/50 plus both cursors |
| Normal chat | Newest-first, automatic older loading only |
| Search/deep link/gap | Separate centered lane with automatic older and newer continuation |
| Aggregate channel window | ≤500 unique messages and ≤2,097,152 production retained bytes across primary, ancestry, context, and latest tail |
| Latest return | Cached newest 100-row tail; no request after deep traversal |
| Mounted transcript | Existing virtual list, maximum 80 mounted timeline entries |
| Warm channels | Three history windows in the renderer LRU |
| Open thread | Separate ≤100-message / ≤512 KiB tray pin, authoritative updates by ID |
| Scroll retention | Visible message IDs + recent direction; identity/offset restoration across channel changes |
| Observability | Retained rows/bytes, viewport protection, page intent-to-paint, anchor error/survival, and search target-to-paint |

One indivisible oversized row or a mandatory visible protected span may create a reported soft byte
excess. Other lanes are evicted first; an ordinary disjoint union is a hard cap.

## Deterministic A/B

The full JSON is [`summary.json`](./summary.json); exact method and limitations are in
[`methodology.md`](./methodology.md). The most important p50 results are:

| 10,000-row workload | Prior unbounded | Bounded candidate | Change |
|---|---:|---:|---:|
| Mixed retained JSON | 6.07 MB | 302.6 KB | −95.0% |
| Mixed full-walk merge + projection | 643.590 ms | 174.327 ms | 3.69× lower |
| Mixed final projection | 9.188 ms | 0.350 ms | 26.3× lower |
| Mixed latest refresh merge | 3.456 ms | 0.934 ms | 3.7× lower |
| Rich retained JSON | 85.58 MB | 2.09 MB | −97.6% |
| Rich full-walk merge + projection | 696.460 ms | 78.825 ms | 8.84× lower |
| Rich final projection | 10.747 ms | 0.161 ms | 66.8× lower |
| Rich latest refresh merge | 3.868 ms | 0.323 ms | 12.0× lower |

This is not a free optimization. At 1,000 mixed rows, cumulative reducer merge time rises from
1.925 to 10.297 ms because exact union reconciliation has a cost; final projection falls from
0.885 to 0.336 ms and retained payload halves. At 100 rows the extra merge work remains about
0.2 ms. The benefit is bounded steady state and avoidance of long-session growth, not a claim that
every individual merge becomes faster.

All deterministic bounded workloads stayed within both limits. The maximum traversal peak was
2,097,141 bytes, 11 bytes below 2 MiB. A second full run reproduced the same observable checksum.

## Live API and page-size decision

The isolated API evidence is [`live-api.json`](./live-api.json), with method in
[`live-api-methodology.md`](./live-api-methodology.md).

- A complete 10,040-message walk took 101 requests, 4,107,789 response bytes, and 180.425 ms on the
  warm local stack.
- A 100-row page was 40,937 bytes and 1.650 ms p50. Fifty rows saved about 20 KB but only 0.330 ms;
  200 rows doubled bytes and reached 2.746 ms p50.
- A 9,900-deep 100-row page was 1.591 ms p50 versus 1.508 ms at the newest edge. Keyset depth is not
  the bottleneck in this fixture.
- The heaviest centered probe—101 primary rows, 76 ancestors, and a 200 KB target—was 273,194 bytes,
  5.188 ms p50, and 6.116 ms p95.

Therefore the network page remains 100. Smaller pages would increase loading frequency and make
upward scrolling more dependent on network timing, while failing to solve retained renderer state.

## Search performance

Opening a known result uses the centered context endpoint instead of walking history. In the
10,000-row deterministic fixture, a 20%-depth result takes one context request (two cold requests
including latest-tail initialization) instead of 80 sequential older pages.

The local centered endpoint ranges from 1.495 ms p50 for one plain target to 5.188 ms for the
pathological 273 KB 50/50 context. Expanding 300 messages on both sides takes six opt-in pages;
merge plus projection is 9.437 ms p50 for mixed content and remains under the aggregate cap.

These results cover navigation from a search hit, not the full-text query itself. Packaged
candidate target-to-paint and highlight confirmation remain
`PENDING_CANDIDATE_SEARCH_TARGET_TO_PAINT`.

## Dependencies, bundles, and lazy loading

The pagination implementation adds no package or runtime dependency; package manifests and lockfile
are unchanged from the feature parent.

The existing split points remain appropriate:

- the Search dialog is lazy and preloaded during idle time;
- Markdown and rich rendering are lazy with an immediate plain-text fallback;
- advanced CJK, code, math, and Mermaid plug-ins load only when message capabilities require them;
- attachments, document parsers, settings, inspector, routines, plug-ins, and secondary dialogs
  remain lazy.

The window reducer, visible-range reporting, and anchor code stay eager on purpose. Moving the first
older-page path behind a dynamic import would exchange a small bundle saving for a one-time hitch at
the exact moment the user reaches the top. Final production renderer size and ratcheted budget are
`PENDING_CANDIDATE_BUNDLE_BYTES`.

## Focused correctness evidence

The current focused suite passes **53 tests, 0 failures, 271 assertions** across:

- aggregate count/byte limits, exact boundaries, soft excesses, deduplication, and ancestry;
- rich viewport pivots, direction-first runway, off-bottom live refresh, and oversized patches;
- cached-tail reset, reconnect gaps, centered older/newer continuation, and context close;
- identity-based scroll restoration and latest fallback;
- open-thread pin bounds and latest-reply semantics;
- new-message notices, stable transcript focus, motion, and message geometry.

Command:

```sh
bun test \
  packages/product-core/test/message-window.test.ts \
  apps/desktop/test/message-history-window.test.ts \
  apps/desktop/test/conversation-scroll.test.ts \
  apps/desktop/test/conversation-scroll-state.test.ts \
  apps/desktop/test/thread-pin.test.ts \
  apps/desktop/test/message-motion.test.ts
```

Full repository typecheck/test/build status is `PENDING_CANDIDATE_FULL_GATES`.

## Packaged Electron A/B

The exact replay protocol is [`electron-ab-methodology.md`](./electron-ab-methodology.md).

| Measure | Prior packaged renderer | Bounded packaged candidate |
|---|---:|---:|
| Forced-GC heap: initial | 16.71 MB | `PENDING_CANDIDATE_INITIAL_HEAP` |
| Forced-GC heap: deep | 25.30 MB | `PENDING_CANDIDATE_DEEP_HEAP` |
| Deep heap change | +8.58 MB / +51.4% | `PENDING_CANDIDATE_HEAP_CHANGE` |
| 60 s stress rAF p95 / max | 17.5 / 17.8 ms | `PENDING_CANDIDATE_STRESS_FRAMES` |
| 15 s reversal rAF p95 / max | 17.3 / 66.3 ms | `PENDING_CANDIDATE_REVERSAL_FRAMES` |
| Reversal gaps >20 / >50 ms | 1 / 1 | `PENDING_CANDIDATE_REVERSAL_GAPS` |
| Retained unique rows / bytes | unbounded / unavailable | `PENDING_CANDIDATE_RETAINED` |
| Anchor error / 1 s survival | unavailable | `PENDING_CANDIDATE_ANCHOR` |
| Search target painted | yes by CUA | `PENDING_CANDIDATE_SEARCH_PAINT` |
| Visual, focus, motion, and AX parity | baseline reference captured | `PENDING_CANDIDATE_PARITY` |

The baseline's frame results are already good. The candidate does not need to manufacture a frame
rate win; it needs to preserve that smoothness while stopping retained-state growth and keeping the
same scroll identity through page and refresh boundaries.

## UX contract and deliberate trade-offs

- Ordinary scrolling down within the retained window remains continuous. Once a newer edge has
  been deliberately evicted, the UI shows an explicit gap/latest affordance rather than pretending
  two disjoint ranges are continuous.
- Search, deep-link, and reconnect-gap views can page both upward and downward because those flows
  have a real pivot and two truthful server cursors.
- Jump latest is immediate from the cached tail. It is not an animated traversal through thousands
  of omitted rows.
- Visible rows outrank edge recency during eviction. The user should keep the same content under
  their eyes even when rich row heights settle.
- Styling and density are not redesigned by pagination. The feature changes state, semantics,
  focus handling, and loading affordances; final screenshot/geometry confirmation is
  `PENDING_CANDIDATE_MULTI_RESOLUTION_PARITY`.

## Residual risks and recommendation

The remaining risks are UI-runtime risks, not unresolved data-policy questions:

- late Markdown/image layout can move measured row heights after an anchor settles;
- cold search still pays channel initialization plus its one context request;
- switching beyond the three-channel warm LRU intentionally reloads an evicted window;
- one indivisible row larger than 2 MiB must remain displayable and is explicitly reported;
- remote latency can make each opt-in context expansion slower than this local fixture.

Recommendation: ship the bounded policy only if the packaged candidate fills every pending
Electron/parity field without a frame, anchor, focus, reply/thread, or visual regression. If it
does, the data favors this design over both the unbounded renderer and universal downward
pagination.
