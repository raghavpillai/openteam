# Packaged Electron pagination A/B methodology

Status: **complete — rollout criteria passed**
Captured: 2026-09-01

## Build arms and variant boundary

| Arm | Source/package | Bundle/profile |
|---|---|---|
| A — prior renderer | feature parent `1e66ee8`; `app.asar` SHA-256 `aef611981917128201e728f1084dc816b8ced5bf86bae025189f4f6e2eca010e` | `dev.openbot.pagination.baseline`; fresh temporary profile |
| B1 — full-depth fixed candidate | behavior-equivalent source immediately before a semantics-preserving local-constant size refactor; `app.asar` `8762645b0b52bbfa1f275e9f09721a2eb5afe67223bbb5a5fbafd4c4d65ce444` | uniquely named temporary package/profile |
| B2 — exact final optimized candidate | `f9787a2` plus two-file progression patch; product-diff SHA-256 `1a09c6634bb75607f959e7712453a9f6aa94e06dae63e749ffeb72c323c0ad5a`; `app.asar` `c33f47b384078fc7b3964ee1560230e08daee2d54470c2c5a14f8a1186ca58f2` | `dev.openbot.pagination.candidate.final`; fresh temporary profile |

A and B1 supply the matched long-duration A/B. B2 is the exact final package and repeats the cap
crossing/progression behavior, bundle gates, and signing/test gates. The B1→B2 source change only
stores a computed byte total in a local constant; it does not alter cursor, eviction, retained
message, or rendering semantics. This split is intentional: full-depth heap evidence is labeled
behavior-equivalent rather than represented as an exact-final trace.

All packages are arm64 production Electron 43.4.1 apps on an Apple M4 Pro running macOS 26.5.2
(build 25F84). They load packaged `file://` renderers, point at the same disposable
`http://127.0.0.1:8882` fixture, and use isolated application IDs/profiles. The primary viewport is
1,228 × 768. Only temporary packaged output was adjusted to admit the fixture's HTTP origin.

The installed OpenBot app, its profile, and unrelated development Electron processes were not
opened or controlled.

## Action and observation boundary

Computer Use performed visible actions against one uniquely identified app at a time: selecting the
channel, focusing and scrolling the transcript, reversing direction, searching, opening a result,
loading either context direction, and jumping to latest. Chrome DevTools Protocol was
observation-only:

- forced-GC heap/runtime counters;
- mounted DOM/listener and virtual-list counts;
- retention, eviction, cursor, page-paint, and anchor performance entries;
- renderer `requestAnimationFrame` callback intervals;
- one 15-second renderer CPU sampling profile during reversal.

The frame sampler measures main-thread callback spacing, not compositor presentation.

## Fixture and workloads

The disposable corpus contained 1,102 chats, 1,001 bots, 32,405 database messages, and 10,040 API
messages in the `Audit Bot 0001` long transcript. History pages are 100 rows.

1. **Initial/realistic:** open newest history, force GC, capture state, then sample ordinary
   scrolling for 12 seconds.
2. **Deep/stress:** repeatedly reach the older boundary, allow the 750 ms load guard to settle, and
   continue through loaded content. Baseline stops around 5,000 for its deep capture; candidate
   continues through all 10,020. Sample 60 seconds during traversal.
3. **Reversal:** alternate directions for 15 seconds while recording rAF and CPU samples.
4. **Anchor:** load one older page under a controlled stationary viewport; separately inspect
   terminal traversal and newer context expansion.
5. **Search:** query `Long transcript fixture 2000`, open the hit, verify paint/highlight and both
   cursors, then expand both directions.
6. **Latest:** activate the newest control from deep context and verify source, paint, bottom
   distance, visible row, and focus destination.
7. **Parity:** compare default, deep, search, compact-sidebar, and supported small-window states for
   styling, geometry, controls, continuity, keyboard focus, motion, and list semantics.

Candidate retention telemetry does not exist in the baseline and is reported only for B.

## Artifact mapping

| Prefix/file | Variant |
|---|---|
| `baseline-*` | A |
| `candidate-exact-*` | B1 full-depth candidate |
| `candidate-final-*` | B1 post-fix targeted anchor/search/frame captures |
| `candidate-optimized-*` | B2 exact final package |
| `bundle-ab-pre-progression.json` | pre-progression aggregate build comparison; not the final totals |
| `final-metrics.json` | curated final values and variant provenance |

The large ownership snapshots remain outside the repository:
`/private/tmp/openbot-pagination-baseline-depth5000.heapsnapshot`,
`/private/tmp/openbot-pagination-candidate-depth10020.heapsnapshot`,
`/private/tmp/openbot-pagination-candidate-exact-current-depth5000.heapsnapshot`, and
`/private/tmp/openbot-pagination-candidate-exact-current-depth10020.heapsnapshot`.

## Results

| Workload | A p50 / p95 / p99 / max | B1 p50 / p95 / p99 / max | A >20 / >50 | B1 >20 / >50 |
|---|---:|---:|---:|---:|
| Realistic, 12 s | 16.7 / 17.1 / 17.6 / 17.7 ms | 16.7 / 17.4 / 17.6 / 33.9 ms | 0 / 0 | 1 / 0 |
| Exact traversal, 60 s | 16.7 / 17.5 / 17.7 / 17.8 ms | 16.7 / 17.6 / 17.7 / 33.8 ms | 0 / 0 | 1 / 0 |
| Reversal, 15 s | 16.7 / 17.3 / 17.6 / 66.3 ms | 16.7 / 17.4 / 17.7 / 50.9 ms | 1 / 1 | 2 / 1 |

B1 reversal CPU attributed 14,896.420 ms of 15,065.482 ms to idle and 5.809 ms to GC.

| Heap capture | Forced-GC JS heap | Declared / mounted timeline |
|---|---:|---:|
| A newest 100 | 16,714,564 B | 101 / 25 |
| A around 5,000 | 25,299,160 B | 5,001 / 24 |
| B1 around 5,000 | 21,645,344 B | 401 / 38 |
| B1 after all 10,020 | 22,246,488 B | 401 / 38 |
| B2 exact-final cap smoke | 22,191,772 B | 401 / 38 |

A grew +8,584,596 B / 51.4% from newest to 5k. B1 grew +601,144 B / 2.78% from 5k to
10,020 while production retention remained exactly 500 messages / 203,630 B. B2 retained exactly
500 / 203,339 B at its cap smoke.

### Leak diagnosis

The first capped candidate still reached 29,292,320 B at 10k. Ownership inspection found 106/105
history snapshot owners/arrays, 105 index maps, and 9,715 content strings reachable through 95
handler hops. `historyByChannel` was captured by changing page handlers. Reading current state
through a ref and keeping handlers stable reduced fixed 5k and 10,020 snapshots to constant 7/6
owners/arrays, 6 indexes, six handler maps, and zero handler-map hops. Snapshot backing and index
tables stayed 22,040 B and 114,844 B. Unique fixture transcript IDs decreased 600→565.

The B1 5k→10,020 heap delta came from lazy rich/file source loading and JIT state, not paging
ownership: `BackingStorage` +200,685 B, external strings +405,621 B, with 404,995 B attributable to
three new source entries.

### Cursor progress and final equivalence

An intermediate candidate exposed a genuine cap stall: at 500 retained messages it repeated
`before=53907`, reported `evictedOlder=100`, and made zero progress. The corrected candidate
requested `54307 → 54207 → 54107 → 54007 → 53907 → 53807` and continued to the oldest row, where
no Load older affordance remained. The last full-depth page evicted 65 newer messages.

B2 repeated the cap transition with declared timelines
`301 → 401 → 501 → 401 → 401` and first fixtures
`9722 → 9622 → 9522 → 9422 → 9408`. Its cap crossings evicted 200 then 100 newer rows, zero older
rows. This is the exact-final semantic check corresponding to B1's full-depth trace.

### Anchor, search, latest, and parity

- Controlled one-page prepend: first error 0 px, one-second maximum 0 px, anchor survived, and
  intent-to-paint 11.7 ms.
- Terminal traversal: maximum anchor error 0.5 px.
- Newer context expansion: maximum 0.28125 px, anchor survived.
- Search target: painted true in 168.1 ms; initial declared/mounted 102/38, both direction controls
  present; after bidirectional loads declared 401, target stayed visible, retention exactly 500.
- Jump latest: A 6,557.2 ms and focus stayed on its transient button; B1 1,137 ms from cache, latest
  visible, bottom distance 0, focus on stable content. Candidate was 5.77× faster.
- Default, compact, and supported small-window styling and geometry remained consistent.

The one-second maximum anchor error is judged only when no intentional user scroll intervenes in
that sampling window.

## Acceptance outcome

| Rule | Outcome |
|---|---|
| ≤500 messages and ≤2 MiB except reported protected/indivisible soft excess | Pass |
| Deep heap plateaus; mounted rows remain virtualized | Pass |
| Cursors progress; no hidden duplicate/missing continuous-window IDs | Pass |
| First anchor ≤1 px and row survives; context remains stable | Pass |
| Search opens target and continues both directions | Pass |
| Cached latest return remains usable and restores stable focus | Pass |
| rAF p95 and long-gap counts do not materially regress | Pass |
| Default/compact/small-window visual and functional contract | Pass |
| Tests, typechecks, style/diff check, build, budget, signing | Pass |

Final gates were desktop 355, product-core 69, contracts 36, client 34, server 127, all five
typechecks, focused 48, scoped Biome, changed-file diff check, build, budgets, and direct
`codesign --deep --strict`. The notification helper alone rejected the temporary product name
because it hard-codes `OpenBot.app`; direct signing verification of the measured package passed.

## Limitations

- Frame distributions are one deterministic local run per workload, not population estimates.
- Forced GC differs from ordinary GC cadence.
- The fixture is synthetic/local; remote RTT, image decode, and thermal variance add costs.
- rAF spacing cannot independently prove GPU compositor smoothness.
- Full-depth heap is from B1; B2 has exact-final cap progression, tests, budget, and signing rather
  than a duplicate 10,020 heap snapshot.
