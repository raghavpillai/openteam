# Desktop message-history performance and UX report

Status: **PASS — packaged rollout gate complete**
Last audited: 2026-09-01

## Conclusion

The bounded implementation is ready to ship. Normal chats stay newest-first and load older history
upward; search/deep-link contexts can page in both directions. The aggregate channel window is
capped at 500 unique messages and 2 MiB without changing the established virtualized UI, density,
or supported layouts.

The prior packaged renderer's forced-GC heap grew from 16,714,564 B at 100 messages to 25,299,160 B
around 5,000 (+8,584,596 B / 51.4%). After a retained-closure leak found during this audit was fixed,
the candidate moved only from 21,645,344 B around 5,000 traversed messages to 22,246,488 B after all
10,020 (+601,144 B / 2.78%), while retaining exactly 500 messages.

Matched p95 frame intervals remained near one 60 Hz frame. Candidate reversal p95 changed from 17.3
to 17.4 ms and its maximum improved from 66.3 to 50.9 ms. Controlled anchors stayed within
0.28125 px, search painted its target in 168.1 ms, and cached jump-latest was 5.77× faster than
baseline.

## Provenance

| Artifact | Identity | Evidence scope |
|---|---|---|
| Prior renderer | source `1e66ee8`; `app.asar` SHA-256 `aef611981917128201e728f1084dc816b8ced5bf86bae025189f4f6e2eca010e` | Baseline heap, frames, screenshots, context, jump-latest |
| Full-depth fixed candidate | behavior immediately before a semantics-preserving local-constant size refactor; `app.asar` `8762645b0b52bbfa1f275e9f09721a2eb5afe67223bbb5a5fbafd4c4d65ce444` | 10,020 traversal, heap ownership, frames, search, anchors, parity |
| Exact final optimized candidate | `f9787a2` plus two-file progression patch; product-diff SHA-256 `1a09c6634bb75607f959e7712453a9f6aa94e06dae63e749ffeb72c323c0ad5a`; `app.asar` `c33f47b384078fc7b3964ee1560230e08daee2d54470c2c5a14f8a1186ca58f2`; ID `dev.openbot.pagination.candidate.final` | Exact-final cap/progression smoke, budgets, signing, final gates |

The exact final package repeated declared timelines `301 → 401 → 501 → 401 → 401` and first
fixtures `9722 → 9622 → 9522 → 9422 → 9408`. It stayed at 500 messages / 203,339 B after the cap,
evicting 200 then 100 newer rows and zero older rows. Full-depth heap numbers are therefore labeled
as behavior-equivalent trace evidence; final behavior is separately proven by this optimized smoke
and all final gates.

See [structured final metrics](./final-metrics.json) and
[Electron methodology](./electron-ab-methodology.md). Large heap snapshots were not checked in.

## What the audit found and fixed

| Finding | Risk | Resolution |
|---|---|---|
| DOM virtualization did not bound retained history | Heap, indexes, projection grew with depth | Bound the deduplicated data union |
| Count-only retention allowed 4+ MB rich windows | Rich rows defeated the limit | Add an exact 2 MiB production ceiling |
| Separately capped lanes could exceed the total | Hidden caches recreated growth | Reconcile primary, context, ancestry, and latest tail together |
| Early candidate chose the wrong cap edge | Repeated `before=53907`, evicted 100 older rows, progress 0 | Preserve requested page, advance cursor, evict newer rows |
| Page handlers captured old `historyByChannel` snapshots | Intermediate candidate reached 29,292,320 B at 10k | Read through a ref and keep a stable handler |
| Eviction could move a visible row | Scroll jump/blanking | Pivot around visible IDs and direction |
| Raw `scrollTop` crossed regenerated windows | Wrong A → B → A restoration | Persist identity, row offset, generation |
| Search discarded newer cursors | Deep result could not continue forward | Keep both cursors in context mode |
| Jump-latest refetched | Latency/failure on a basic action | Cache the newest 100-row tail |
| Reply/thread data could be evicted | Wrong target or collapsed tray | Pin reply; bound thread state to 100 messages / 512 KiB |
| Transient button retained focus | Keyboard focus loss | Focus stable transcript viewport |
| List/motion semantics were incomplete | Accessibility regression | Add list/listitem and reduced-motion navigation |

The selected policy is 100-row keyset transport, older-only normal loading, bidirectional centered
context, an aggregate 500-message / 2 MiB channel union, three warm channel windows, and the
existing virtual list (policy maximum 80 mounted entries). One indivisible oversized row or a
mandatory visible protected span can create an explicitly reported soft byte excess.

## Deterministic and API evidence

The production-reducer [results](./summary.json) and
[methodology](./methodology.md) cover 10,000-row mixed and rich workloads. Two runs reproduced
checksum `7077200170`. Every candidate stayed within both caps; maximum peak was 2,097,141 B, 11 B
below 2 MiB.

| 10,000-row workload, p50 | Prior | Candidate | Change |
|---|---:|---:|---:|
| Mixed retained JSON | 6.07 MB | 302.6 KB | −95.0% |
| Mixed full walk | 643.590 ms | 174.327 ms | 3.69× lower |
| Mixed final projection | 9.188 ms | 0.350 ms | 26.3× lower |
| Rich retained JSON | 85.58 MB | 2.09 MB | −97.6% |
| Rich full walk | 696.460 ms | 78.825 ms | 8.84× lower |
| Rich final projection | 10.747 ms | 0.161 ms | 66.8× lower |

At 1,000 mixed rows, cumulative reducer merge time rises from 1.925 to 10.297 ms because exact union
reconciliation has a cost, while final projection falls from 0.885 to 0.336 ms. This is a
steady-state optimization, not a claim that every merge is cheaper.

The isolated API [results](./live-api.json) and
[methodology](./live-api-methodology.md) show the 10,040-message walk used 101 requests,
4,107,789 B, and 180.425 ms locally. A 100-row page was 40,937 B and 1.650 ms p50. Fifty rows saved
about 20 KB but only 0.330 ms; 200 rows doubled bytes and reached 2.746 ms. A page 9,900 messages
deep remained 1.591 ms. Keeping 100-row pages reduces loading interruptions without conflating
transport size with renderer retention.

## Packaged Electron A/B

| Workload | Baseline p50 / p95 / p99 / max | Candidate p50 / p95 / p99 / max | Baseline >20 / >50 | Candidate >20 / >50 |
|---|---:|---:|---:|---:|
| Realistic, 12 s | 16.7 / 17.1 / 17.6 / 17.7 ms | 16.7 / 17.4 / 17.6 / 33.9 ms | 0 / 0 | 1 / 0 |
| Exact traversal, 60 s | 16.7 / 17.5 / 17.7 / 17.8 ms | 16.7 / 17.6 / 17.7 / 33.8 ms | 0 / 0 | 1 / 0 |
| Reversal, 15 s | 16.7 / 17.3 / 17.6 / 66.3 ms | 16.7 / 17.4 / 17.7 / 50.9 ms | 1 / 1 | 2 / 1 |

Candidate reversal CPU sampled 14,896.420 ms idle of 15,065.482 ms and 5.809 ms GC. These one-run
rAF callback intervals are not compositor-present timestamps, but p95 and long-gap counts show no
material smoothness regression.

| Heap capture | Forced-GC JS heap | Declared / mounted |
|---|---:|---:|
| Baseline newest 100 | 16,714,564 B | 101 / 25 |
| Baseline around 5,000 | 25,299,160 B | 5,001 / 24 |
| Fixed candidate around 5,000 | 21,645,344 B | 401 / 38 |
| Fixed candidate after 10,020 | 22,246,488 B | 401 / 38 |
| Exact-final cap smoke | 22,191,772 B | 401 / 38 |

Full-depth telemetry retained 500 / 203,630 B; exact-final smoke retained 500 / 203,339 B. The
leaking candidate had 106/105 snapshot owners/arrays, 105 index maps, and 9,715 content strings via
95 handler hops. Fixed 5k and 10,020 snapshots both had 7/6 owners/arrays, 6 indexes, six handler
maps, and zero hops; backing/index tables stayed 22,040 / 114,844 B. Unique fixture IDs across
React current/alternate plus tail slack decreased 600→565.

The remaining +601 KB was not paging retention: `BackingStorage` rose 200,685 B, external strings
405,621 B, and 404,995 B belonged to three newly loaded rich/file sources and JIT state. Temporary
diagnostics remain at `/private/tmp/openbot-pagination-candidate-depth10020.heapsnapshot`,
`/private/tmp/openbot-pagination-candidate-exact-current-depth5000.heapsnapshot`, and
`/private/tmp/openbot-pagination-candidate-exact-current-depth10020.heapsnapshot`.

## UX and parity

The disposable workload had 1,102 chats, 1,001 bots, 10,040 long-transcript API messages, and
32,405 database messages.

- Traversal advanced `54307 → 54207 → 54107 → 54007 → 53907 → 53807` and continued to the
  oldest row; no Load older remained. The last page evicted 65 newer rows.
- Manual prepend had 0 px first/max error, surviving row `1`, and 11.7 ms intent-to-paint. Terminal
  error stayed within 0.5 px; newer-context maximum was 0.28125 px with the row preserved.
- Search for `Long transcript fixture 2000` painted in 168.1 ms. Initial context declared
  102/mounted 38 with both directions present. After bidirectional pages it declared 401, kept the
  target visible, and retained exactly 500.
- Baseline jump-latest took 6,557.2 ms and focus stayed on its transient button. Candidate used
  cache, painted in 1,137 ms, reached bottom distance 0, showed latest, and focused stable content.
- Default, compact-sidebar, and supported small-window captures preserve styling, density,
  sidebar/header/composer geometry, and controls.
- Reply, thread, notice, attachment/composer, focus, list-semantic, and motion contracts passed
  final automated gates and targeted CUA.

Representative screenshots:
[baseline initial](./baseline-initial.png),
[baseline depth](./baseline-depth-5000.png),
[baseline search](./baseline-context-2000.png),
[candidate initial](./candidate-exact-initial.png),
[candidate depth](./candidate-exact-depth-10020.png),
[candidate search](./candidate-final-search-context.png),
[candidate compact](./candidate-exact-compact.png),
[candidate small window](./candidate-exact-small-window.png), and
[exact-final cap](./candidate-optimized-cap.png).

## Dependencies, lazy loading, and bundle

No package manifest or lockfile changed; pagination adds no dependency. All 30 dynamic sources are
covered, zero uncovered. Shiki and Mermaid remain lazy with no startup entry. Search, rich
rendering, CJK, code/math, attachments/documents, settings, inspector, routines, plugins, and
secondary dialogs retain split points. Reducer and anchor paths stay eager to avoid a cold hitch at
the first boundary.

The checked-in [bundle comparison](./bundle-ab-pre-progression.json) is explicitly pre-progression.
Final optimized totals are:

| Output | Baseline | Final | Delta / budget |
|---|---:|---:|---:|
| Renderer | 15,526,913 / 3,768,753 gzip | 15,569,943 / 3,781,003 gzip | +43,030 (+0.277%); 57 / 18,997 headroom |
| Entry | 641,436 | 680,762 / 204,228 gzip | +39,326 (+6.13%); 238 headroom |
| Startup | 950,578 | 990,662 / 284,144 gzip | +40,084 (+4.22%); 338 headroom |
| CSS | — | 191,400 / 32,860 gzip | pass |
| Electron | — | 2,182,280 / 540,392 gzip | pass |

Deltas are aggregate final-worktree versus feature-parent, not pagination-only attribution.

## Final gates and limits

Passed: desktop 355 tests, product-core 69, contracts 36, client 34, server 127, all five
typechecks, final focused 48, scoped Biome, changed-file diff check, build, budgets, and direct
`codesign --deep --strict`. That is 621 full-suite tests plus the focused replay.

The notification verifier only failed because it hard-codes `OpenBot.app` while the isolated
product intentionally used another temporary name. Direct strict/deep verification passed; this
was not a signature failure.

The design follows cursor transport + bounded cache + DOM virtualization guidance from
[Slack](https://slack.engineering/making-slack-faster-by-being-lazy/),
[Discord](https://docs.discord.com/developers/resources/message),
[TanStack Query](https://tanstack.com/query/latest/docs/framework/react/guides/infinite-queries),
[TanStack Virtual](https://tanstack.com/virtual/latest/docs/chat), and
[Electron](https://www.electronjs.org/docs/latest/tutorial/performance).

Residual risks are explicit: remote RTT and image decode are absent from the local fixture; late
rich-content height changes can still need virtual-list correction; a fourth inactive channel
reloads after the three-window LRU evicts it; and an indivisible >2 MiB row remains displayable.
None changes the rollout decision.
