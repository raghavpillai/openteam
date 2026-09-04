# Desktop and iOS performance audit — 2026-09-03

## Result

Four measured optimizations are implemented. Existing rendering, animation timing, easing,
haptics, text, pagination budgets, and UI geometry are preserved. The largest gains are in
notification previews, outgoing-message projection, and repeated history work. Desktop traces
improved in the search and history scenarios without degrading frame cadence. Native frame
cadence stayed the same; rare first-open outliers overlapped baseline variance, so this report
**does not claim a native smoothness, startup, or battery speedup**.

## Isolation and workload

- Separate Compose project `openbot-client-perf-20260903`, database `openbot_perf_audit`, API on
  loopback `8879`, and frozen production renderers on `5175` / `5176`.
- 1,102 chats; 32,385 messages; a 10,020-message conversation; 1,350 routines and 36,940 search
  documents. Edge fixtures include 200 KB Markdown, 250 replies, a 125-edge thread, and 250
  disabled group routines. No real account data or inference work was used.
- Fresh/disposable Electron profiles and a dedicated iOS simulator. The two native arms use
  the same freshly built Release native binary (UUID `208B130A-F31A-3E17-A8A7-C00FF859ABA8`),
  with different frozen production Hermes bundles. No Metro/debug-JS measurements are used.
- Host: Mac16,11, 12 logical CPUs, 24 GiB RAM, macOS 26.5.2; Electron 43.4.1; iOS Simulator 26.5.
- Baseline is the **working tree at audit start**, including the preceding shared-code refactor,
  not bare Git HEAD. Source fingerprints and manifests are retained with the raw evidence.

## Changes retained

1. **Cache chronological sort keys.** Repeated history sorting no longer reparses the same dates
   and bigint sequences for every comparison. Weak keys follow message lifetimes; source-value
   checks preserve correctness if a caller mutates an object.
2. **Index outgoing echo lookup for batches.** Large queues no longer scan the entire transcript
   once per pending send. Small queues retain the cheap scan path. Nonce lineage, first-match
   precedence, accepted IDs, and digest checks are unchanged.
3. **Cache history projections per state.** Visible/retained views and ID sets are reused until a
   transition invalidates them. Eviction clears the cache. The mobile publisher no longer merges
   and sorts the same snapshot twice, and avoids redundant history-status updates.
4. **Bound notification preview work.** Reuse the grapheme segmenter and stop after the required
   preview boundary; ordinary ASCII takes a fast path. Long messages are no longer fully split
   into grapheme arrays just to display 140 characters. Unicode/emoji and edge-limit tests prove
   identical output.

## CPU algorithm measurements

These are **Bun/JavaScriptCore model timings, not end-to-end app latency**. Each case has 100
samples after 10 warmups, with baseline/candidate/candidate/baseline ordering. Values below are
medians of the two run medians. Frozen modules prevent worktree switching from contaminating arms.

| Work | Baseline p50 | Optimized p50 | Change |
|---|---:|---:|---:|
| `notification.preview/200kb-ascii` | 10.864 ms | 0.443 ms | 24.5× |
| `notification.preview/short-ascii` | 0.018 ms | <0.001 ms | cached read |
| `history.refresh/500-retained` | 2.409 ms | 1.048 ms | 2.3× |
| `history.read-projections/500-retained` | 0.206 ms | <0.001 ms | cached read |
| `outgoing.project/1-queued-1499-authoritative` | 0.364 ms | 0.104 ms | 3.5× |
| `outgoing.project/500-queued-1499-authoritative` | 3.433 ms | 0.349 ms | 9.8× |
| `outgoing.project/1000-queued-1499-authoritative` | 6.552 ms | 0.569 ms | 11.5× |

Unchanged control cases stayed approximately flat: 1,000-chat roster projection was about
0.293 ms in both arms; decode/reconciliation remained about 3.7–3.8 ms. Full p50/p95 values are
in [summary.json](./summary.json). The initial CPU profile attributed substantial work to
transcript scans and repeated date parsing; the Electron profile also identified repeated
`Intl.Segmenter` construction/full-message segmentation in notification previews.

## Production Electron traces

All UI inputs were performed through CUA. Instrumentation only observed the renderer. CPU
profiles, Chromium timelines, Event Timing, frame callbacks, resources, and post-GC heap were
captured. GC occurs outside the frame interval; the first/last 250 ms are excluded from frame
summaries. The numbers below use the **recorded** event counts, not the total actions attempted
across a longer computer-use session.

| Scenario / metric | Baseline | Optimized |
|---|---:|---:|
| Warm switching, recorded selections | 12 | 12 |
| Warm switching, select-to-next-paint p95 | 21.8 ms | 19.6 ms |
| Warm switching, frame interval p95 | 17.60 ms | 17.50 ms |
| Warm switching, frames >25 ms / long tasks | 0 / 0 | 0 / 0 |
| Search + navigation, Event Timing p95 (17 events) | 136 ms | 64 ms |
| Search, long tasks | 1 × 57 ms | 0 |
| Search, frames >25 ms | 4 | 0 |
| Search, retained JS heap after GC | 25.71 MiB | 24.33 MiB |
| Deep-history merge p95 (7 merges) | 6.3 ms | 5.0 ms |
| Deep-history frame interval p95 | 17.50 ms | 17.50 ms |
| Deep-history frames >25 ms / long tasks | 5 / 0 | 3 / 0 |
| Deep-history retained JS heap after GC | 27.60 MiB | 26.23 MiB |

Both deep-history arms ended with 1,392 DOM elements and 38 mounted message rows. Both retained
at most **500 messages / 203,231 payload bytes** in the measured history window. The existing
2 MiB ceiling, viewport protection, latest-tail recovery, and animation code were not weakened.

A further candidate-only retention exercise paged from the 9,400-range into the 8,300-range.
After-GC heap readings were **26.04 → 26.09 → 25.04 MiB**, with listeners **643 → 643 → 587**.
There was no continuing heap-growth trend in this bounded exercise. Full heap snapshots are
available, but their totals are not compared directly because they were taken at different UI
states; detached-node counts alone are not treated as proof of a leak.

### Startup and server work

Six fresh-process/fresh-Chromium-profile startup runs were collected with warm OS/server caches.
First-contentful-paint values were 168–284 ms for baseline and 172–188 ms for candidate. The
app can hydrate its fallback selection before restoring the server's active agent, so the
poll-based chat-DOM readiness metric is **exploratory** and is not used to claim a startup win.
This duplicate initial hydration is a concrete follow-up opportunity, but changing selection
or freshness behavior was deliberately kept out of this optimization pass.

The frozen backend's 30-sample API measurements included:

- Bootstrap: 1,577,616 bytes, approximately 52.4 ms p50 / 89.4 ms p95 end-to-end.
- 100-message history: 40,917 bytes, approximately 2.63 ms p50 / 4.24 ms p95.
- Runtime status: 110 bytes, approximately 0.37 ms p50 / 0.69 ms p95.

Search API categories and no-result behavior were also benchmarked separately. No polling
intervals, API freshness guarantees, or visible content were sacrificed to lower timings.

## Release iOS Simulator

Instruments' simulator transport failed during attachment (`fileDescriptorHandshake... failed`).
Those incomplete `.trace` directories are **not results**. Native evidence instead uses OS
`sample` stacks, VM summaries, and a separately injected, non-shipping CADisplayLink/rusage probe.
Its small observer workload is identical between arms. It measures main-run-loop callback
cadence, not GPU-presented frames or physical-iPhone performance.

For the matched comparison, the same cached snapshot files were restored before each launch.
The workload opened Audit Bot 1000 and performed six verified native scroll-to-top /
“Jump to latest” cycles. All six cycles fall inside each included 60-second capture.

| Native metric | Baseline, two valid runs | Optimized, valid matched run |
|---|---:|---:|
| Frame interval p95 / p99 | 16.67 / 16.67 ms | 16.67 / 16.67 ms |
| Frames >25 ms | 9–17 | 13 |
| Frames >50 ms | 1–3 | 3 |
| Worst frame callback gap | 69.2–105.5 ms | 105.4 ms |
| Process CPU during capture | 7.86–8.68 s | 8.28 s |
| Physical footprint | 164.9–173.8 MiB | 172.6 MiB |

The optimized result falls within observed baseline variance. Rare first-chat-open stalls remain
on this simulator; **there is no defensible native frame-time or memory speedup claim here**.
An additional baseline home-idle capture had no frames over 25 ms and about 129 MiB physical
footprint. Five native older-page loads advanced the long transcript from 9,901 to 9,401, and the
existing jump action returned to message 10,000. Those checks verified behavior and bounded
navigation rather than proving a physical-device latency number.

Another running task repeatedly restarted or switched Simulator. Interrupted captures and a
repeat whose final action fell outside its recording window are excluded. Initial free-form
drag attempts did not produce a verified scroll and are excluded as well; the valid native
scroll tests use the OS scroll-to-top action and the app's existing animated jump button.

## UX and regression gates

- **103 TSX/CSS files** compared with the frozen baseline: no presentation-structure, visible
  text, visual-attribute, or native-style differences. The shared state provider is the only
  changed production TSX file; its rendered structure is unchanged.
- Animation/easing, keyboard behavior, haptics, media presentation, and history/virtualization
  limits are unchanged. Existing motion/parity tests remain green.
- **1,164 tests**, all 18 workspace test tasks, and all 12 typecheck tasks passed.
- Both production builds, architecture/duplication checks, native configuration, and desktop /
  iOS bundle gates passed. **No performance budget was raised in this pass.**
- Desktop entry: 711,990 B; startup: 1,008,843 B; full renderer: 15,574,468 B.
- Canonical iOS export: 4,651,214 B Hermes, 2,201 modules,
  26 assets. The existing 4,660,000 B ceiling still passes.

## Remaining validation / next opportunities

1. Repeat the native traces on a physical iPhone, including 120 Hz, thermal/energy behavior,
   real finger flings, keyboard transitions, and a longer background/foreground soak.
2. Investigate occasional native first-chat-open stalls under an uncontended profiler session.
   The current evidence does not isolate a single cause, so no animation or timing shortcut was
   applied to hide them.
3. Consider including active-agent selection and a smaller/delta roster in bootstrap. At this
   scale the 1.58 MB bootstrap and duplicate initial hydration remain larger architectural work.
4. Large document-preview and multi-hour retention matrices remain separate work; this was not
   an exhaustive PDF/XLSX/video or physical Android/Windows/Linux certification.

## Reproduce and inspect

See [the profiling harness instructions](../../../scripts/performance/README.md).
Machine-readable data: [summary.json](./summary.json), [UI invariants](./ui-invariants.json),
[heap analysis](./heap-analysis.json), and native [baseline](./baseline-native-manifest.json) /
[candidate](./candidate-native-manifest.json) manifests.

Raw frozen sources/builds, `.cpuprofile` files, Chromium timelines, heap snapshots, native CPU
samples, native frame JSON, API measurements, and logs remain at:

```text
/var/folders/qz/z9zw1vg957n39ddb4x5qqjqm0000gp/T/openbot-client-perf-20260903-lfn0e3wc
```

The disposable services are stopped after capture; their synthetic volume and frozen artifacts
are retained for reproducibility. The normal OpenBot stack and profiles were not used.
