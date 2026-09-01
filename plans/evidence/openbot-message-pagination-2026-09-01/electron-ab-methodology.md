# Packaged Electron pagination A/B methodology

Status: baseline complete; candidate values marked `PENDING_CANDIDATE` until the matched replay
finishes.

## Matched builds

| Arm | Source | Bundle identifier | Debug port | Profile |
|---|---|---|---:|---|
| A — prior renderer | `1e66ee8586a0…`, the pagination feature parent | `dev.openbot.pagination.baseline` | 9344 | fresh temporary directory |
| B — bounded candidate | `PENDING_CANDIDATE_COMMIT` | `dev.openbot.pagination.candidate` | 9345 | fresh temporary directory |

Both arms are arm64 production-packaged Electron 43.4.1 apps on an Apple M4 Pro running macOS
26.5.2 (build 25F84). Each opens its packaged `file://` renderer, points at the same disposable
`http://127.0.0.1:8882` fixture, uses its own application ID and empty profile, and runs at
1,228 × 768 for the primary comparison. The build's Content Security Policy was changed only in
the temporary packaged output to admit that isolated HTTP origin.

Each measurement workload targets only one uniquely identified app at a time. The installed OpenBot
app, its profile, and the user's existing development Electron process were not opened or
controlled.

## Control and observation boundary

All user-visible actions—selecting a channel, focusing the transcript, scrolling, reversing
direction, searching, opening a result, and jumping to latest—were performed through Computer Use
against the uniquely identified packaged app. Chrome DevTools Protocol was observation-only:

- forced-GC heap and V8/runtime counters;
- mounted DOM nodes and JavaScript listener counts;
- virtual-list declared and mounted row counts;
- application performance entries, including retained-window and anchor telemetry;
- renderer `requestAnimationFrame` callback intervals;
- one 15-second renderer CPU profile during repeated direction reversal.

The frame sampler measures main-thread animation-callback spacing, not display-present timestamps.
It is useful for same-machine A/B comparison but cannot prove GPU compositor smoothness alone.

## Fixture and workloads

Both arms use the same 10,040-message `Audit Bot 0001` channel in the 1,102-channel fixture.
Network history pages are 100 rows.

1. **Initial/realistic:** open the newest 100 messages, take a forced-GC snapshot, and run a
   12-second ordinary-scroll frame sample.
2. **Deep history/stress:** repeatedly move to the top, allow the 750 ms history-load guard to
   settle, then move through the loaded region until at least 5,000 messages have been traversed.
   Run a 60-second frame sample during this workload and take another forced-GC snapshot.
3. **Direction reversal:** alternate upward and downward scrolling for 15 seconds while collecting
   frame intervals and a sampling CPU profile.
4. **Search context:** search for `Long transcript fixture 2000`, open that result, confirm that
   the target is visible, and inspect context/retention telemetry.
5. **Jump latest:** activate the visible newest-message control from the old context and confirm
   that the newest tail is visible and transcript focus remains usable.
6. **Parity:** compare the initial, depth, context, and latest states for message styling, density,
   composer/header/sidebar geometry, controls, scroll continuity, focus, and accessibility roles.

The candidate additionally exposes direct telemetry for unique retained rows/bytes, viewport
protection, first-settled and maximum anchor error, anchor-row survival after one second, and
search-target paint. Those counters do not exist in the baseline and are reported only for B.

## Baseline measurements already captured

| Measure | A — prior renderer | B — bounded candidate |
|---|---:|---:|
| Initial forced-GC JS heap | 16,714,564 B | `PENDING_CANDIDATE_INITIAL_HEAP` |
| Deep forced-GC JS heap | 25,299,160 B | `PENDING_CANDIDATE_DEEP_HEAP` |
| Heap change | +8,584,596 B (+51.4%) | `PENDING_CANDIDATE_HEAP_CHANGE` |
| Initial DOM nodes / listeners | 1,246 / 367 | `PENDING_CANDIDATE_INITIAL_DOM` |
| Deep DOM nodes / listeners | 1,229 / 408 | `PENDING_CANDIDATE_DEEP_DOM` |
| 12 s realistic frame p95 / max | 17.1 / 17.7 ms | `PENDING_CANDIDATE_REALISTIC_FRAMES` |
| 60 s stress frame p95 / max | 17.5 / 17.8 ms | `PENDING_CANDIDATE_STRESS_FRAMES` |
| 15 s reversal frame p95 / max | 17.3 / 66.3 ms | `PENDING_CANDIDATE_REVERSAL_FRAMES` |
| Reversal gaps >20 / >50 ms | 1 / 1 | `PENDING_CANDIDATE_REVERSAL_GAPS` |
| Retained unique messages / bytes | unbounded / unavailable | `PENDING_CANDIDATE_RETAINED` |
| First-settled / maximum anchor error | unavailable | `PENDING_CANDIDATE_ANCHOR_ERROR` |
| Anchor row alive after 1 s | unavailable | `PENDING_CANDIDATE_ANCHOR_SURVIVAL` |
| Search target painted | visible by CUA | `PENDING_CANDIDATE_SEARCH_PAINT` |

The prior renderer already virtualizes mounted DOM rows, which explains why its deep DOM count is
flat even while retained JavaScript state grows by 8.58 MB. The candidate is successful only if it
keeps that visual/DOM smoothness while bounding retained data; a lower heap with worse scroll
frames or lost anchors is a failed trade.

## Acceptance rules

- At no point may the candidate retain more than 500 unique channel-window messages or 2 MiB by the
  production retained-byte counter, except one indivisible oversized row or a mandatory visible
  protected span explicitly reported as soft excess.
- Deep heap must plateau rather than scale with pages traversed; mounted rows remain virtualized.
- No duplicate/missing IDs within a continuous window; gaps must be explicit.
- An older-page load, context expansion, live refresh, or direction reversal must retain the
  reported visible rows. First-settled anchor error should be at most 1 px, with the row still
  present after one second.
- Search opens the requested target, can expand in both directions, and can return immediately to
  the cached latest tail.
- No unintended visual, motion, keyboard-focus, screen-reader-order, reply, thread, composer,
  attachment, or new-message-notice regression.
- Candidate rAF p95 and >20/>50 ms gap counts must not materially regress the matched baseline.

## Limitations

- The rAF samples are one deterministic local run per workload, not a population estimate.
- Forced GC makes heap comparisons repeatable but differs from normal garbage-collection cadence.
- The fixture is synthetic and local; remote RTT and image decode will add costs.
- A 1,228 × 768 replay does not substitute for the separately recorded compact/minimum-window
  parity check.
