# Desktop performance remediation and A/B validation

**Status:** final integrated macOS arm64 audit complete
**Audit date:** 2026-08-29
**Frozen A-arm commit:** `146ddb95de86`
**Source audit:** [`34-desktop-performance-audit.md`](./34-desktop-performance-audit.md)
**Evidence:** [`evidence/openbot-performance-remediation-2026-08-29`](./evidence/openbot-performance-remediation-2026-08-29)
**Test machine:** Mac mini (Mac16,11), Apple M4 Pro, 12 CPU cores, 24 GB RAM, macOS 26.5.2 (25F84), arm64

## Executive verdict

The performance problems were real, concentrated, and largely removable without reducing the tested product surface. The final B arm replaces lifetime-sized startup/state/rendering work with bounded data contracts and virtual windows, moves host work out of Electron main, restores indexed search and event-driven SSE, and removes the duplicate dependency tree from the package.

The largest measured improvements are:

- `app.asar`: 273,352,346 B to 13,256,142 B (**−95.15%**);
- eager entry: 1,777,993 B to 581,263 B (**−67.31%**);
- normal startup assets: 1,929,258 B to 773,876 B (**−59.89%**);
- complete renderer output: 16,429,473 B to 13,103,419 B (**−20.24%**);
- long-fixture elements: 220,077 to 961 (**−99.56%**);
- long-fixture CDP nodes: 234,013 to 1,089 (**−99.53%**);
- long-fixture listeners: 56,037 to 352 (**−99.37%**);
- long-fixture live JavaScript heap: about 883.5 MiB to 15.05 MiB (**−98.3%**); and
- the exact 10 MiB short-line host transform: 343.744 ms to 37.533 ms (**9.16× faster**) with **97.23%** less RSS growth.

All enforced build/package budgets pass. All 11 monorepo typecheck tasks, test tasks, and build tasks pass. The final macOS ZIP contains an ASAR whose SHA-256 exactly matches the unpacked app. No packaged `node_modules`, source maps, native modules, binary WASM, stale preload, or unexpected top-level files remain.

Computer Use exercised the 1,100-chat/10,020-message fixture, deep search, compact keyboard navigation, a 1,000-member editor, emoji search and keyboard selection, rich Markdown/CJK/code/math/Mermaid, routine summary/editor transitions, native host approval deny/allow, and an isolated packaged-app smoke. No usability difference was detected in that tested matrix. The remaining visible performance caveat is first-use rich/Mermaid initialization: the interaction trace still recorded 66 ms and 98 ms browser long tasks before settling. This is not a claim of exhaustive equivalence on untested Windows/Linux builds, background notifications, every native save-dialog path, or every drag geometry.

**Recommendation:** suitable to ship on macOS arm64 with the residuals in this report tracked. Keep Windows process-tree behavior and cross-platform package/UI measurements as release qualifications rather than assuming the macOS result generalizes.

## What the A/B comparison means

This is a controlled engineering before/after comparison, not a user-population experiment.

- **A arm:** production renderer/main/preload built at `146ddb95de86`.
- **B arm:** final production renderer, bundled main/preload/host utility, and final package from the remediation worktree.
- **Fixture:** isolated PostgreSQL database with 1,000 bots, 100 groups, 1,100 total chats, one 10,020-message channel, rich-content cases, and deterministic search targets.
- **Isolation:** Compose project `openbot-performance-audit`, database `openbot_perf_audit`, API `127.0.0.1:8877`, production renderer `127.0.0.1:5174`, disposable Electron profiles, isolated host bridge, and stub computer service. The seed refuses to target another database.
- **Input:** visible UI actions were performed through macOS accessibility/Computer Use. CDP, `window.openbotPerformance`, SQL `EXPLAIN`, HTTP timings, and Electron process metrics only observed results.
- **Build hygiene:** every measurement build cleans `dist` and `dist-electron`; every release cleans `release`. The release gate rejects an ASAR older than or different from the current build.
- **Comparability:** figures are compared only when the fixture and metric match. The old 8.19 s long-channel ready mark is not silently compared with the new paint marker, and closure sizes are not summed because chunks overlap.

The harness and reproduction commands are documented in [`scripts/performance/README.md`](../scripts/performance/README.md).

## Final before/after measurements

### Build and package

| Surface | Frozen A | Final B | Change |
|---|---:|---:|---:|
| Complete renderer | 16,429,473 B / 463 files | 13,103,419 B / 391 files | **−20.24% bytes** |
| Renderer gzip | not frozen | 3,044,885 B | recorded, no A ratio |
| Eager entry JavaScript | 1,777,993 B | 581,263 B | **−67.31%** |
| Normal startup assets | 1,929,258 B | 773,876 B | **−59.89%** |
| Startup gzip | not frozen | 223,772 B | recorded, no A ratio |
| Startup CSS | 150,549 B | 123,762 B | **−17.79%** |
| KaTeX fonts | 1,072,948 B / 59 files | 256,168 B / 19 WOFF2 files | fallback formats removed; math-only |
| `app.asar` | 273,352,346 B | 13,256,142 B | **−95.15%** |
| ASAR header | 4,792,652 B | 104,900 B | **−97.81%** |
| ASAR file count | 18,404 | 395 | **−97.85%** |
| Packaged dependency tree | 252,109,925 B / 17,937 files | 0 B / 0 files | removed |
| macOS arm64 ZIP | 175,199,190 B | 121,618,243 B | **−30.58%** |
| macOS arm64 DMG | not frozen | 121,499,455 B | recorded, no A ratio |

The authoritative output is [`build-final.json`](./evidence/openbot-performance-remediation-2026-08-29/build-final.json). Its ASAR comparison matched all 394 current build inputs with zero missing, changed, or unexpected entries. The ASAR top level is exactly `dist`, `dist-electron`, and the pruned `package.json`. The ZIP's embedded ASAR is 13,256,142 B and has the same SHA-256 as the unpacked ASAR.

### Heavy renderer and data path

| Surface | Frozen A | Final B | Result |
|---|---:|---:|---|
| Long-fixture elements | 220,077 | 961 | **−99.56%** |
| Long-fixture CDP nodes | 234,013 | 1,089 | **−99.53%** |
| Long-fixture listeners | 56,037 | 352 | **−99.37%** |
| Long-fixture live JS heap | about 883.5 MiB | 15.05 MiB | **−98.3%** |
| Sidebar rows | all lifetime rows participated | 17 mounted / 1,100 declared | bounded |
| Timeline rows | 10,020-message lifetime path | 25 mounted / 100 warm rows | bounded |
| Frame sample | multi-second scale stalls; 574 ms one-page scroll | 20.4 ms max, 1/120 over 20 ms, 0 over 50 ms | sampled long-frame gate passes |
| Startup data | 14.72 MB full snapshot | 1,497,690 B decoded bootstrap | **about −89.8%** |
| Selected long history | inseparable from full snapshot | 40,917 B decoded; 11.8 ms | bounded page |
| Bootstrap | about 152 ms average HTTP on same fixture | 75.3 ms local total; 62.71 ms service | smaller and faster |
| First UI paint / FCP | empty: 199 / 244 ms; long ready: 8.19 s | heavy fixture: 95.8 / 120 ms | different ready definitions; no ratio claimed |

The final heavy initial capture is [`05-heavy-final-initial.json`](./evidence/openbot-performance-remediation-2026-08-29/05-heavy-final-initial.json). The old 8.19 s figure was a 10,020-message selected-channel ready time, not an empty-start time. B no longer emits the same lifetime-ready marker, so the report does not manufacture a direct speedup ratio from paint.

### Server, event, search, and host benchmarks

| Surface | A | B | Result |
|---|---:|---:|---|
| Missing-term search | 297–306 ms at 127,600 docs | 0.052 ms execution at 33,107 docs | GIN `Bitmap Index Scan` restored; dataset differs, no ratio |
| Warm search request | not recorded | 2.1–3.3 ms | under 75 ms gate |
| Deep-message context | up to 100 history-page scan in the first B implementation | 101 messages / 41,399 B; 3.58–9.05 ms across five runs | bounded direct endpoint |
| 250,000-event replay floor | at least 15.6 minutes | 8.625 s | empty-batch sleep removed; 100,000 retained |
| Commit-to-SSE observation | 750 ms poll cadence | 3.3–5.7 ms | PostgreSQL wakeup |
| 100 projection schedules | up to 100 full projections | 2 actual jobs | keyed trailing coalescing |
| Durable token-delta events | one per delta | 0 | completed state remains authoritative |
| 10 MiB / 5,242,881-line transform | 343.743917 ms; +909,213,696 B RSS | 37.533166 ms; +25,214,976 B RSS | **9.16× faster; −97.23% RSS** |
| 128 MiB shell producer | ignored backpressure | 100,000 B inline; 67,107,916 B log under 67,108,864 B cap; 29.101 ms; 105,349,120 B peak RSS | intentionally failed at output policy |

Evidence: [`search-explain.txt`](./evidence/openbot-performance-remediation-2026-08-29/search-explain.txt), [`message-context.json`](./evidence/openbot-performance-remediation-2026-08-29/message-context.json), [`host-read.json`](./evidence/openbot-performance-remediation-2026-08-29/host-read.json), and [`host-shell.json`](./evidence/openbot-performance-remediation-2026-08-29/host-shell.json).

## Finding-by-finding disposition

No audit finding is silently dropped. “Fixed” means its identified unbounded or blocking path is removed. “Bounded residual” means the catastrophic path is fixed but a smaller architectural/product issue remains.

| Audit finding | Final disposition | Remediation | Residual / qualification |
|---|---|---|---|
| P0 complete-history snapshot | **Bounded residual** | Bounded bootstrap, 100-row cursor history, per-channel state, direct message/thread context, three-history LRU, refresh serialization, retry, cursor revision checks, and no stringify/parse clone. | Normal events still trigger a coalesced bounded aggregate refresh rather than entity-level patches. Legacy clients can still request the compatibility snapshot. |
| P0 unbounded/O(n²) transcript | **Fixed** | Dynamic-height windowing, O(n) row metadata, binary-search ranges, path-compressed thread roots, bounded dialogs/trays, prepend anchors, and hidden-pane unmount. | Deliberately paging to the beginning can accumulate history in JS, but only a bounded visual window mounts. |
| P0 durable base64 images | **Bounded residual** | Binary asset table/service, streaming 20 MiB bound, magic-byte validation, SHA-256 dedupe, URL references, upload concurrency two, object URLs, legacy promotion, and exact retrieval. | Model/computer delivery still materializes base64 at the final boundary. Authorization, GC, dimensions, and thumbnails remain. |
| P0 search misses GIN | **Fixed** | Nonempty FTS predicate is inline/parameterized; empty search is separated; search UI is lazy. | Keep production-like plan checks; prefix search is a separate schema decision. |
| P1 host work blocks Electron main | **Fixed on tested macOS/POSIX path** | Lazy Electron `utilityProcess`; main retains validation/native UI only; 2 active + 32 queued host jobs; a shared 2 active + 8 queued shell/PDF subprocess capacity; 1 active + 32 queued native approvals; caps, backpressure, abort, timeout, and process-tree cleanup. | Windows descendant termination exists but was not process-tree/CUA verified. PDF still invokes `pdftotext`, with bounded result. |
| P1 unread PATCH storm | **Fixed** | One set reduction, batched renderer/storage update, debounced serialized remote persistence. | Multi-client settings remain last-write-wins. |
| P1 sidebar/DnD scale | **Fixed for render/registration cost** | Expanded, compact, pinned, and custom rows virtualized; layout memoized; mounted rows own DnD registration; stable sorting/callbacks; ARIA size/position and keyboard scrolling retained. | DnD parser remains eager and cross-platform drag geometry was not exhaustively exercised. |
| P1 package dependency copy / entry | **Fixed** | Zero production dependencies; renderer/main/preload/utility bundled; restricted ASAR files; side-effect-free avatar subpath; release integrity gates. | Complete deferred syntax/diagram universe is still broad. |
| P1 coarse/eager feature loading | **Bounded residual** | All 20 renderer source boundaries are real dynamic entries and budget-covered; emoji, optional surfaces, rich capabilities, routine summary/editor, CSS/fonts split by intent. | Basic Markdown is 461 KB; common Mermaid closure is 1.139 MB. First-use rich initialization still produced 66/98 ms long tasks; the post-settle sample was smooth. |
| P1 stale main/preload dev output | **Fixed** | Clean builds, `predev`, three Bun watch bundles, stable-artifact detection, coalesced Electron restart supervisor, and clean package/release gates. | None found in the tested workflow. |
| P1 projection amplification/event polling | **Bounded residual** | Keyed projection coalescing/fingerprints, no durable deltas, `LISTEN/NOTIFY`, immediate batch drain, 15 s keepalive, 100k retention, stale-cursor reset. | Each actual transcript projection is still a full PUT; multi-instance HA wakeups need deployment validation. |
| P2 unstable memo boundaries/hidden work | **Bounded residual** | Stable maps/callbacks, synchronous warm LRU, hidden unmount, shared date clock, active/visible polling, autosave cleanup, imperative resize, bounded choosers. | React still receives a reconciled aggregate snapshot instead of fine-grained external-store selectors. |
| P2 image context menu/notifications | **Partial** | One native `webContents` menu owns image copy/save; bounded HTTP save and blob download path; lazy image decode. | Notification ownership remains renderer-side; background/minimized behavior was not moved to main. |
| P2 telemetry | **Substantially fixed** | Monotonic ring revision, scenario/build metadata, feature/reconcile/API marks, Electron process/main/GPU metrics, unresponsive/gone events, CDP snapshots. | Persisted distributions, one-click bounded tracing, and utility queue telemetry are not release-grade. |
| Electron standard protocol/code cache opportunity | **Attempted, rolled back for parity** | A secure privileged `app://` spike enabled a standard origin and code cache. | It changed the local-storage origin and lost selected-channel/sidebar/inspector preferences. Retained `file`/audit-HTTP loading until an explicit storage migration exists. |

## What changed

### Data plane

Normal startup now uses `/client-bootstrap`, selected-channel `/history?limit=100`, and `/client-state`. Bootstrap includes visible descriptors/latest summaries and active/pending runtime entities rather than lifetime history. Per-channel state prioritizes live work and reports truncation. Direct `/channel-messages/:id/context` returns a target with ±50 neighbors, cursor edges, thread roots, truncation, and revision.

Warm history is capped to three channels. Completion order cannot re-promote an evicted request; stale channel-state responses cannot overwrite a newer bootstrap; overlapping refreshes serialize with one trailing pass; an initial error remains retryable.

Event append notifies PostgreSQL. One listener fans wakeups to SSE streams; nonempty 500-row batches drain immediately, empty streams wait for a keepalive, and a cursor older than the retained 100,000 events receives `snapshot.required`.

The first virtual-pagination implementation regressed: one upward action fetched 101 pages and called prepended history “3000 new messages.” [`03-heavy-history.json`](./evidence/openbot-performance-remediation-2026-08-29/03-heavy-history.json) is deliberately retained as a rejected run. Direction gating, one-per-750-ms automatic loading, anchor cleanup, error handling, and latest-entry identity tracking fixed it. This rejected run is why the usability pass is part of the result rather than an afterthought.

### Renderer

The shared variable-height virtualizer caches layout, binary-searches the first visible row, measures mounted height, applies bounded overscan, and preserves prepend anchors. Caps are 80 timeline/dialog rows, 70 thread rows, 48 sidebar rows, 40 emoji rows, 32 mention options, 28 new-bot options, and 24 group/inspector member options.

Only the selected chat owns transcript observers. Search/inspector/settings/plugins/dialogs/About/New Bot/A2A/async surfaces mount only while open. Routine polling is nonoverlapping, visibility-gated, and mode-gated. Date labels share a next-midnight clock. Inspector width mutates imperatively while dragging and commits state on release. Unread updates are reduced once and persisted once.

Deep search initially mounted the target but `use-stick-to-bottom` forced the view back to newest. The final focus effect runs in layout, stops bottom-following, then scrolls to the virtual index. The target at synthetic message 5,000 was visibly centered; “Scroll to newest” restored bottom distance 0 and hid itself from pointer and keyboard access.

### Images

The client validates up to eight 20 MiB images, keeps object-URL previews, and uploads at concurrency two. The server streams with a hard bound, verifies PNG/JPEG/GIF/WebP signatures and MIME agreement, decodes/sanitizes Unicode names, hashes/deduplicates bytes, and stores a compact asset reference in durable message state. A 5,856-byte controlled PNG survived byte-for-byte with zero durable base64. Legacy inline URLs are promoted on the modern path.

### Electron process architecture

BrowserWindow remains context-isolated, sandboxed, Node-disabled, web-secure, single-window, GPU-accelerated, and renderer-window-denying. Heavy host work now follows:

```text
local caller / renderer
        │ bounded authenticated request
        ▼
Electron main
  validation + FIFO native approval + lifecycle only
        │ request-id IPC
        ▼
lazy Electron utilityProcess
  file/PDF transform + shell process tree
  concurrency / queue / output / time / abort bounds
```

The native approval path was exercised visibly: Deny returned HTTP 403 with the unchanged denial contract; Allow returned the requested five numbered README lines. The screenshots are [`14-host-approval-deny-final.jpg`](./evidence/openbot-performance-remediation-2026-08-29/14-host-approval-deny-final.jpg) and [`14b-host-approval-allow-final.jpg`](./evidence/openbot-performance-remediation-2026-08-29/14b-host-approval-allow-final.jpg).

## Complete dependency and lazy-loading audit

### Direct dependencies

All 30 direct desktop declarations are referenced. None is dead. The original problem was classification and topology: already-bundled packages were copied again as runtime dependencies. Final `dependencies` is empty and all 30 inputs are `devDependencies`.

| Group | Packages | Final treatment |
|---|---|---|
| Renderer core | `react`, `react-dom`, `use-stick-to-bottom` | Core is eager; only the selected transcript stays mounted. |
| Sidebar drag | `@dnd-kit/dom`, `@dnd-kit/react` | Eager parser retained for parity; registrations limited to mounted rows. |
| Shared contracts | `@openbot/contracts` | Type use erases; avatar users take the side-effect-free `bot-avatar` subpath. |
| Rich text | `streamdown`, `@streamdown/cjk`, `@streamdown/math`, `@streamdown/mermaid`, `shiki`, `@shikijs/themes`, `katex` | Basic/advanced/CJK/code/math/Mermaid split; custom bounded Shiki adapter; math-only CSS/fonts. |
| Emoji | `emojibase-data` | Compact build-time projection and lazy virtual panel; six quick reactions remain eager. |
| UI/style | `lucide-react`, `radix-ui`, `class-variance-authority`, `clsx`, `tailwind-merge`, `tw-animate-css` | Tree-shaken/bundled; no package copy. |
| Build/dev | `@tailwindcss/vite`, `@types/react`, `@types/react-dom`, `@vitejs/plugin-react`, `concurrently`, `electron`, `electron-builder`, `tailwindcss`, `vite`, `wait-on` | Build/test/dev only. |

`@streamdown/code` was removed in favor of the bounded Shiki adapter. The final graph retains incompatible `marked@17` (Streamdown) and `marked@16` (Mermaid); deduping across that major-version boundary was not treated as behavior-preserving.

### Every renderer dynamic entry

The budget tool discovers renderer source entries from Vite's manifest, verifies each is truly dynamic, and fails if a current or future dynamic source lacks a named budget. Final coverage is 20/20.

| Boundary | Raw closure | Gzip closure |
|---|---:|---:|
| Basic Markdown | 461,414 B | 140,756 B |
| Advanced rich shell | 461,640 B | 140,877 B |
| CJK | 486,593 B | 149,511 B |
| Code | 649,310 B | 199,208 B |
| Math, CSS, fonts | 1,014,962 B | 485,814 B |
| Common Mermaid | 1,138,729 B | 309,899 B |
| Emoji panel | 240,748 B | 51,119 B |
| A2A sheet | 439 B | 271 B |
| Async tasks | 4,420 B | 2,003 B |
| Desktop dialogs | 3,769 B | 1,741 B |
| Group form | 8,868 B | 3,774 B |
| Inspector | 18,822 B | 6,870 B |
| Avatar picker | 4,652 B | 1,737 B |
| Bot screen | 6,912 B | 2,558 B |
| Routine summary | 11,055 B | 3,910 B |
| Routine editor | 67,665 B | 21,845 B |
| New Bot | 4,346 B | 1,850 B |
| Plugin settings | 21,522 B | 5,639 B |
| Search | 11,090 B | 4,491 B |
| Settings/About | 12,456 B | 3,752 B |

Opening bot details previously pulled a 70,452 B routine/editor closure. The new summary costs 11,055 B, deferring **84.3%** of the old raw payload until “Create/Edit routine.”

Shiki preserves 235 registrations plus 97 aliases (332 accepted keys) over 213 deferred grammar source entries. Its complete emitted grammar universe is 7,425,414 B raw / 1,282,251 B gzip; each highlighter request loads one grammar, with at most three highlighter creations running concurrently. Only one explicit GitHub-dark theme source plus the custom light theme is reachable; the package theme registry contributes zero entries. There are zero binary WASM files.

Mermaid preserves 40 deferred diagram targets. Its complete 60-file recursive universe is 2,433,137 B raw / 697,635 B gzip, while the measured common first-use closure is 1,138,729 B. This remains the largest parity-preserving residual.

## CUA and usability-parity results

| Scenario | Visible result | Instrumented result |
|---|---|---|
| Fresh heavy launch | 1,100 chats and long channel usable | 961 elements / 1,089 nodes, 352 listeners, 15.05 MiB heap; 17/1,100 sidebar and 25/100 timeline rows; 20.4 ms max, 0 frames over 50 ms ([`05`](./evidence/openbot-performance-remediation-2026-08-29/05-heavy-final-initial.json)) |
| 89.215 s idle | UI unchanged | only three 30 s `/client-runtime` polls were added; no bootstrap/history/state/search/feature request; nodes 1,063→976, heap 18.47→14.28 MiB; 20.8 ms max ([`07 before`](./evidence/openbot-performance-remediation-2026-08-29/07-idle-before.json), [`after`](./evidence/openbot-performance-remediation-2026-08-29/07-idle-runtime.json)) |
| Deep result 5,000 | target visibly centered; newest restored bottom | one 41 KB context request; 38/202 timeline rows; 23.3 ms max; bottom distance 0 after newest ([`09`](./evidence/openbot-performance-remediation-2026-08-29/09-deep-search-final.json), [`09b`](./evidence/openbot-performance-remediation-2026-08-29/09b-scroll-newest-final.json)) |
| Full emoji | searched “satellite”, Tab focused the result, Return applied the reaction | 1,327 nodes, 203 buttons, 19.39 MiB heap, 17.7 ms max, no frame over 20 ms ([`08`](./evidence/openbot-performance-remediation-2026-08-29/08-full-emoji.json)) |
| Rich gallery | code, math, flowchart, CJK, and combined sequence content visible | first-use trace recorded 66/98 ms long tasks; the post-settle 120-frame sample was 20.8 ms max / 0 over 50 ms; 1,875 nodes and 41.78 MiB heap after all engines ([`10`](./evidence/openbot-performance-remediation-2026-08-29/10-rich-gallery-final.json)) |
| Compact sidebar | drag 269→88 px; End reached off-window Audit Bot 0003; Home returned to Audit Bot 1000 | later compact capture mounted 20/1,100; no gap over 50 ms ([`11`](./evidence/openbot-performance-remediation-2026-08-29/11-compact-keyboard-final.json), [`06`](./evidence/openbot-performance-remediation-2026-08-29/06-sidebar-switch.json)) |
| 1,000-member editor | search, ArrowDown focus, Space draft toggle, Cancel without save | 11/1,000 unfiltered rows; 1/1 filtered; 1,463 nodes; 20.9 ms max, 0 over 50 ms ([`12`](./evidence/openbot-performance-remediation-2026-08-29/12-member-editor-final.json), [`12b`](./evidence/openbot-performance-remediation-2026-08-29/12b-member-editor-1000-final.json)) |
| Routine details/editor | summary visible; Create Routine exposed all fields; Back exited without save ([`13`](./evidence/openbot-performance-remediation-2026-08-29/13-bot-inspector-summary-final.json), [`13b`](./evidence/openbot-performance-remediation-2026-08-29/13b-routine-editor-final.json)) | final manifest: 11,055 B summary closure; 67,665 B editor deferred ([`build-final`](./evidence/openbot-performance-remediation-2026-08-29/build-final.json)) |
| Native host approval | Deny remained 403; Allow returned five lines | native dialog path and unchanged response contract verified ([`14 deny`](./evidence/openbot-performance-remediation-2026-08-29/14-host-approval-deny-final.jpg), [`allow`](./evidence/openbot-performance-remediation-2026-08-29/14b-host-approval-allow-final.jpg)) |
| Packaged app | searched 1,100 chats and opened off-screen Audit Bot 0002 with rich timeline | full trace recorded 50/65/96 ms startup/first-use long tasks; post-settle sample was 20.9 ms max / 0 over 50 ms; 17/1,100 sidebar and 15/26 timeline rows ([`15`](./evidence/openbot-performance-remediation-2026-08-29/15-packaged-smoke-final.json)) |

Another user-owned OpenBot process was already running, so packaged CUA used a temporary clone whose only intended changes were bundle identity/signature for automation disambiguation. The clone and final release ASAR hashes are identical in [`15-packaged-asar-sha256.txt`](./evidence/openbot-performance-remediation-2026-08-29/15-packaged-asar-sha256.txt). The production renderer was served through the isolated audit proxy to inject the isolated API; main, preload, host utility, and renderer assets were the final packaged ASAR payload. The ZIP-to-ASAR check independently verifies the shipped archive.

An early idle trace was rejected because Bun's audit proxy default idle timeout severed the 15 s SSE keepalive and forced reconnect/bootstrap work. `serve-renderer.ts` now uses `idleTimeout: 255`; the clean before/after pair above has exactly three new runtime polls and no rebootstrap. This was a harness defect, not reported as a product defect.

Correctness issues found and fixed during parity work included the pagination avalanche/false unread count, dropped overlapping refresh, stale state overwrites, warm-LRU completion races, nonretryable startup history, 100-page search navigation, deep-jump bottom-following, missing out-of-page thread roots, stale local reaction results, cross-bot inspector state, Unicode image headers, preview URL leaks, silent upload failures, missing blob Save, and shell capacity released before descendant exit.

## Automated validation and enforced budgets

Final commands and results:

- `bun run check`: 11/11 typecheck tasks, 11/11 test tasks, and 11/11 build tasks passed.
- Focus suites: desktop **123 pass**, server **44**, contracts **22**, client-core **8**, messaging **53**, worker **19**; zero failures.
- `bun desktop:performance`: pass.
- `bun --filter @openbot/desktop package`: pass, including release gate.
- `git diff --check`: pass.

The performance/release gate enforces:

- entry ≤800,000 B; startup ≤1,200,000 B; startup CSS ≤125,000 B; renderer ≤15,500,000 B;
- every renderer dynamic source is a real, explicitly budgeted entry;
- ASAR ≤25 MiB, header ≤256 KiB, files ≤1,000, exact top-level allowlist and pruned package metadata;
- no packaged `node_modules`, maps/source-map directives, binary WASM, native `.node`, stale preload, or Shiki theme registry;
- ZIP ≤130 MiB and DMG ≤135 MiB; and
- macOS ZIP embedded-ASAR SHA-256 equality.

All enforced budgets pass. The aspirational 12 MiB renderer and 1 MiB Mermaid ratchets do not pass; they are not disguised as passed gates.

## Remaining limitations and next ratchets

1. **Shiki/Mermaid breadth and first-use hitch:** both are lazy and decoupled, but the full syntax/diagram universe is still large and the rich trace recorded 66/98 ms first-use long tasks. Curating it would change uncommon-language/diagram behavior unless a compatible fallback is designed; idle preloading would merely move the cost and violate the closed-surface budget.
2. **Marked duplication:** Streamdown and Mermaid require incompatible major versions (`17` and `16`). Keep until upstream compatibility permits a proven-safe dedupe.
3. **DnD eager parse:** mounted registrations are bounded, but the DnD packages remain in the entry.
4. **Entity-level state patches:** bounded aggregate reconciliation remains; a normalized external store could further reduce invalidation.
5. **Assets:** authorization, reference-counted GC, dimensions, thumbnails, cache policy, and final-boundary base64 removal remain.
6. **Projection:** actual transcript projection remains a full PUT after coalescing.
7. **Settings concurrency:** remote preference writes remain last-write-wins across clients.
8. **Notifications:** renderer ownership remains dependent on Chromium background scheduling.
9. **`app://` code cache:** deferred until a local-storage origin migration preserves selection and layout preferences.
10. **Telemetry:** add bounded `contentTracing`, persisted percentile distributions, and utility queue/backpressure counters.
11. **Platforms:** Windows/Linux/x64 packaging, signing, antivirus, updater deltas, and Windows descendant termination need their own A/B runs.
12. **Unexercised parity edges:** native image Save dialogs, background notifications, and every reorder/context-menu/resize geometry were not exhaustively CUA-tested.
13. **DMG internals:** the DMG artifact was size-gated, but not mounted during this run; the ZIP's inner ASAR was streamed and hash-verified exactly.

These are smaller/deferred costs and verification gaps, not the original catastrophic full-history DOM/base64/package/main-thread failures.

## Final release recommendation

The macOS arm64 remediation meets the enforced performance, package-integrity, correctness, and tested-usability gates. It is a material, evidence-backed improvement and is suitable to ship for that target.

The precise claim is: **no usability regression was detected in the automated and CUA matrix above**. It is not: “all behavior on all platforms is mathematically identical.” Windows process-tree behavior and the explicitly unexercised native/background paths should remain release checklist items, and the deferred Shiki/Mermaid/app-protocol changes should require their own compatibility A/B tests.
