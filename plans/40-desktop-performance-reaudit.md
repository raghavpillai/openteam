# Desktop performance re-audit: realistic and stress workloads

**Status:** complete
**Audit date:** 2026-09-01
**Prior desktop baseline:** [37-post-pull-performance-and-parity-remediation.md](./37-post-pull-performance-and-parity-remediation.md)
**Evidence:** [evidence/openbot-desktop-reaudit-2026-09-01](./evidence/openbot-desktop-reaudit-2026-09-01)

## Executive verdict

The desktop app is responsive under both an ordinary workspace and the 1,100-chat stress fixture.
The final production replay kept navigation, bounded rendering, search, and scrolling within the
interaction budgets used for this audit. A realistic cold launch reached the first app UI in 82.8 ms;
warm channel changes painted in 58.2 ms p50 including two animation frames; a 15,220 px sidebar
traversal had an 18.5 ms worst frame; and 60 rapid heavy-fixture channel switches produced no long
task. Search over 35,967 documents stayed below 18 ms p50 in every result category.

This pass nevertheless found and fixed real slow paths:

- Search's first lazy open took 317.9 ms even though subsequent opens were fast. The lazy boundary is
  now warmed after the initial app paint and on pointer/focus intent; the final CUA
  interaction-to-input measurement was 22 ms.
- Channel selection retained old, 997-agent native-notification projections. Sixty switches grew a
  production/headless heap cohort from 25.70 MB to 40.75 MB with a flat DOM and listener count. Heap
  snapshots tied 78,763 retained agent records and 6.59 MB of preview strings to old App render
  contexts. The projection now exists only inside the notification effect; the post-fix source heap
  contained zero matching retained projection arrays or preview strings.
- Pending rich-message widgets installed one document keydown listener per card. Seventy-two such
  handlers were observed in a long conversation. One per-document delegate now preserves the
  existing “latest pending card wins” behavior. The duplicate rich-widget handler class was absent in
  the final replay.
- Image right-click could still be intercepted by the message reaction menu. Image elements now stop
  context-menu bubbling and Electron main owns the native image menu without a large renderer string
  IPC. CUA confirmed `Copy image`, `Save image…`, and `Copy image address`, with no reaction menu.
- Repeated full notification synchronization, the updater's unbounded quadratic stdout parser, eager
  `electron-updater`, a 10,000-bot mention scan, virtual-row registration, and unchanged routine-poll
  commits all had measurable avoidable costs. The exact isolated before/after results are below.
- A packaged empty-profile launch exposed a macOS Keychain startup hang. The token store now checks
  whether an encrypted session file exists before probing `safeStorage`; a fresh packaged profile
  reached the username/password auth gate normally.

The visible UI style and interaction model were preserved. CUA covered search and result navigation,
image preview/menu, mentions, the attachment drawer, compact-sidebar restoration, and all three lazy
settings sections. The composer ended empty, no message was sent, and no installed user profile was
used.

This does not mean every future scale risk is eliminated. Aggregate server refreshes, unbounded warm
history retention, rich-renderer first-use work, routine-poll bandwidth, and several host lifecycle
bounds remain worthwhile follow-ups. The exact package is also very close to its raw-renderer and CSS
ceilings, so bundle growth must stay gated.

## Scope and comparison discipline

The audit covered renderer and Electron-main source, React identity and retention, IPC payloads,
native Electron facilities, dependencies and transitive closures, dynamic imports, production build
shape, package contents, HTTP completion time, heap snapshots, event listeners, frame cadence, and
visible desktop behavior.

Two data shapes were used:

| Workload | Bots / groups | Channels | Messages | Routines | Search documents | Purpose |
|---|---:|---:|---:|---:|---:|---|
| Realistic fresh workspace | 250 / 25 | 275 | 5,506 | 275 | 6,557 | cold start, ordinary switching, search, scrolling, memory |
| Heavy stress workspace | 1,104 bots | 1,105 | 32,409 | 1,354 | 35,967 | nonlinear behavior, rapid switching, long transcript, search/API scale |

The heavy fixture included a 10,020-message conversation. Both datasets were disposable; the
realistic database was about 21 MB. Production renderer runs used isolated profiles and frozen build
artifacts. CUA drove the actual Electron UI through macOS accessibility; CDP observed timing, DOM,
listeners, heap, resources, and performance entries. HTTP scripts consumed and parsed the full body
before recording end-to-end completion. Isolated microbenchmarks were used only for paths that are
unsafe or impractical to induce through the UI, such as a 32 MiB updater line with no newline.

Measurements are not mixed across unlike cohorts. Header/TTFB time is not reported as complete API
time; source-level A/B results are not presented as frame times; and the 10,020-message rich view is
not compared directly with the smaller comparable rich view. A temporary blank page caused by
rebuilding `dist` under a live static server was discarded because old HTML requested chunk hashes
the clean build had removed. A later apparent blank state was a stale CUA element identifier, also a
harness artifact rather than a product failure.

## Realistic-workload results

### Cold launch and steady state

| Metric | Result |
|---|---:|
| Navigation complete | 71.3 ms |
| First app UI | 82.8 ms |
| First Contentful Paint | 124 ms |
| Bootstrap body | 393,971 B |
| Bootstrap resource / TTFB / server | 87.4 / 86.8 / 81.85 ms |
| Loaded resources | 48 |
| Decoded resource bytes | 2,194,238 B |
| 120-frame sample, worst frame | 17.8 ms |
| Frames over 20 / 50 ms | 0 / 0 |
| Sidebar rows mounted | 17 of 275 |
| Timeline rows mounted | 18 of 20 |
| Heap after forced GC | 15.37 MB |

The launch recorded one 52 ms long task while the deliberately lazy TypeScript grammar/highlighter
initialized for the selected rich content. It did not produce sustained frame pressure, but it is the
clearest remaining first-use renderer spike and supports the worker recommendation below.

The sampled Chromium process working sets were about 156,336 KiB for the browser process, 90,608 KiB
for GPU, 52,624 KiB for network service, and 184,192 KiB for the renderer: roughly 472 MiB when those
process readings are summed. Electron main private memory was another 43,073 KiB. These per-process
figures can include shared pages and should be treated as a reproducible diagnostic footprint, not a
unique physical-memory total.

### Channel navigation

Ten cold first-opens measured:

| Stage | p50 | p95 |
|---|---:|---:|
| Selection state | 14.0 ms | 17.1 ms |
| Target view | 13.9 ms | 16.8 ms |
| History response | 8.6 ms | 32.2 ms |
| Reconciled state | 9.9 ms | 57.0 ms |
| Read acknowledgement | 17.6 ms | 59.8 ms |
| Network-ready | 29.6 ms | 84.6 ms |
| Two-frame visible completion | 49.6 ms | 111.0 ms |

There were no long tasks. Thirty warm switches cycled four conversations, deliberately exceeding the
three-channel warm cache:

| Stage | p50 | p95 |
|---|---:|---:|
| Selection state | 8.6 ms | 9.3 ms |
| Target view | 8.9 ms | 10.3 ms |
| History response | 12.5 ms | 18.8 ms |
| Reconciled state | 16.5 ms | 28.6 ms |
| Network-ready | 35.3 ms | 48.2 ms |
| Two-frame visible completion | 58.2 ms | 60.3 ms |

The warm worst case was 74.8 ms, with no read request and no long task. A 15,220 px sidebar traversal
over 120 frames measured 16.7 / 17.6 / 18.5 ms p50/p95/max, with no frame above 20 ms or 50 ms. The
document contained 992 elements during that traversal while the sidebar itself remained virtualized.

### Search UX

The original lazy boundary made the first Search click visibly expensive:

| Search interaction | Before | Final |
|---|---:|---:|
| First interaction to focused input | 317.9 ms | 22 ms |
| Subsequent warm reopen before the preload change | 11.3 ms | — |

The fix does not make Search part of the startup bundle. It reuses the existing dynamic import after
the shell has committed, schedules it with `requestIdleCallback` (2 s timeout), and also starts it on
pointer-enter/focus intent. The final 22 ms measurement armed a read-only observer, used CUA for the
actual click, and read the input-appearance timestamp afterward.

With the intentional 50 ms query debounce included, a representative realistic query produced its
result in 70.1 ms, painted two frames by 98 ms, and spent 13.6 ms in the API. Across nine warm queries,
result p50/p95 was 77.6/81.7 ms, two-frame paint was 101.9/103.2 ms, and API p50/p95 was
18.4/21.1 ms.

## Stress-workload results

Sixty heavy-fixture switches measured selection at 8.7/10.3 ms p50/p95 and network-ready at
28.4/41.1 ms. The worst complete switch was 64.9 ms, with no long task. Stress scrolling peaked at
19.7 ms per frame.

The earlier comparable rich-view A/B remains useful because the view shape was held constant:

| Metric | Before | Optimized | Change |
|---|---:|---:|---:|
| Warm channel paint | 42.3 ms | 18.8 ms median | 55.6% lower |
| Browser click interaction | 88 ms | 64 ms median | 27.3% lower |
| Renderer working set | about 177 MB | about 142 MB | about 19.8% lower |
| JS heap | 22.97 MB | 20.8 MB | about 9.4% lower |
| Event listeners | 494 | 344 | 30.4% lower |
| Rapid-switch CPU idle | 97.6% | 98.0% | no sustained saturation |

That optimized CPU profile covered about ten seconds of repeated navigation: the hottest application
function accumulated 12.36 ms, GC accumulated 8.42 ms, and the renderer was idle for 9,862 ms.

The final, broader CUA replay intentionally opened more lazy surfaces and a 20-message view. After
GC it had a 41,199,324 B heap, 1,016 elements, 17 of 1,105 sidebar rows, and 18 of 20 timeline rows.
Its 120-frame sample had a 23.2 ms maximum, one frame over 20 ms, and none over 50 ms. This richer
state is reported as a final bound, not compared with the smaller A/B view.

## Exact isolated A/B results

The final isolated run was captured at `2026-09-01T18:28:18.990Z`:

| Hot path | Baseline | Optimized | Result |
|---|---:|---:|---|
| Notification selection, 1,000 bots | 7.950334 ms p50 | 0.000334 ms p50 | constant-size selected-channel IPC |
| Notification selection, 10,000 bots | 86.465416 ms p50 | 0.000375 ms p50 | removes roster-size selection work |
| Updater stdout, 32 MiB line without newline | 2,944.908084 ms | 0.703958 ms | bounded incremental parser; 0 B left buffered |
| Mention search, 10,000 options | 18.840792 ms p50 | 0.152000 ms p50 | precomputed lowercase keys and one filter |
| Register 80 virtual rows | 0.057959 ms p50 | 0.006875 ms p50 | O(1) key-to-node lookup |
| Unchanged 2,500-routine projection | 0.118834 ms p50 | 0.005875 ms p50 | identity retained; React list commit skipped |

The notification baseline includes the old renderer projection and structured clone, while the new
measurement covers the small manager update. It omits native transport from both sides. Because the
old payload was roughly 256 KB at 1,000 bots and 2.6 MB at 10,000 bots while the new payload is a
channel identifier, omitted transport cost favors the baseline rather than exaggerating the fix.

The updater parser now keeps at most 128 KiB, discards the remainder of an oversized line until the
next newline, and then resumes normal progress parsing. Concurrent identical status probes are also
coalesced without a TTL that could make manual Refresh stale.

## Notification retention proof

The notification slowdown was not merely a synthetic projection cost. In the pre-fix
production/headless cohort, 60 selection changes grew heap from 25.70 MB to 40.75 MB even though DOM
and listener counts stayed flat. A heap-snapshot path retained 79 old notification projections. Each
held 997 agents, for 78,763 retained agent records. Preview strings grew by 58,823 instances and
6.59 MB.

The retaining chain was a live React callback to an old App render context and its render-scoped
`useMemo` notification projection. The fix keeps selection/focus delivery small and builds the full,
identical notification roster only inside the synchronization effect after confirming that a native
target and snapshot exist. The dependencies and native payload semantics are unchanged. The post-fix
source heap contained zero arrays matching the old projection shape and zero matching preview-string
cohorts.

No flat total-heap claim is made from that post-fix source run because hot-module replacement polluted
the total development heap. The structural disappearance of the exact retained cohort is the valid
evidence; final production heap numbers are reported separately above.

## Listener audit

Before delegation, synchronous enumeration found 367 listeners and 72 document-level keydown
handlers attributable to pending rich widgets. The new per-`Document` registry installs one capture
listener when its first pending widget mounts, routes a key to the latest visible pending card, and
removes the delegate when the registry empties. It preserves all existing modifier, editable-target,
dialog, and default-prevented guards.

In the final replay the duplicated rich-widget handler class was absent. After initial rich/settings
surfaces, CDP reported 341 listeners while synchronous enumeration found 339 total and 42 document
keydowns. After opening more lazy surfaces and a 20-message view, the corresponding readings were 489
and 484 total, with 58 document keydowns. All 42/58 remaining document keydowns were identifiable
Radix menu keyboard-modality handlers, which install one-shot pointer listeners. The audit therefore
does not claim “one document listener total”: the app-level rich-widget duplication is fixed, while
mounted Radix menus remain the main listener cost. They did not cause a measured long task, but
consolidating or reducing mounted menu roots is a valid P3 follow-up.

## Search and API performance

Search remains a debounced, cancellable client of bounded PostgreSQL full-text search. It does not
scan the 1,105-channel roster or document corpus in React. Results are capped at 24.

### Realistic fixture: true end-to-end search

| Category | p50 | p95 |
|---|---:|---:|
| All | 13.331 ms | 21.839 ms |
| Messages | 9.380 ms | 11.041 ms |
| Bots | 8.125 ms | 9.756 ms |
| Channels | 3.716 ms | 4.677 ms |
| Files | 8.137 ms | 11.942 ms |
| Links | 5.151 ms | 5.993 ms |
| Routines | 7.296 ms | 8.253 ms |
| Missing term | 1.951 ms | 2.725 ms |

### Heavy fixture: true end-to-end search

| Category / representative query | p50 | p95 |
|---|---:|---:|
| All / `performance` | 17.72 ms | 20.19 ms |
| Messages / `synthetic` | 8.81 ms | 10.52 ms |
| Bots / `Audit Bot` | 14.05 ms | 15.72 ms |
| Channels / `Audit Group` | 5.50 ms | 6.85 ms |
| Files / `audit-report` | 14.07 ms | 16.82 ms |
| Links / `openbot` | 9.03 ms | 10.65 ms |
| Routines / `Audit Routine` | 5.61 ms | 6.56 ms |
| Missing term | 2.22 ms | 3.45 ms |

Bounded search transfer and JSON decode were about 0.02--0.06 ms, so the database/query stage is the
meaningful component and still has comfortable headroom. Renderer cancellation prevents stale UI;
depending on when the connection is aborted, the backend may still finish a superseded query.

### API completion time

| Fixture / endpoint | Body | p50 | p95 |
|---|---:|---:|---:|
| Realistic bootstrap | 393,971 B | 16.311 ms | 27.117 ms |
| Realistic runtime | 100 B | 0.539 ms | 0.855 ms |
| Realistic history (100) | 9,072 B | 1.780 ms | 3.113 ms |
| Realistic legacy compatibility | 2,704,285 B | 36.539 ms | 48.626 ms |
| Heavy bootstrap | 1,582,172 B | 45.09 ms | 57.93 ms |
| Heavy runtime | 100 B | 0.424 ms | 0.616 ms |
| Heavy history (100) | 40,920 B | 2.09 ms | 2.87 ms |
| Heavy legacy compatibility | 15,826,809 B | 167.91 ms | 177.80 ms |

The compatibility snapshot is not used by the normal bounded desktop startup. The renderer metric was
renamed from the misleading `api.request` to `api.ttfb`; the scripts report headers, transfer, JSON
parse, and full completion independently.

## Changes made in this pass

### Electron main, preload, and native facilities

- Split `electron-updater` into an on-demand main-process chunk, loaded only by the delayed automatic
  check or an explicit update action. Main startup no longer evaluates the updater graph.
- Replaced synchronous preload version IPC with a value supplied in Electron
  `additionalArguments`.
- Warmed the OS-backed token store in parallel with window creation, then fixed the packaged
  empty-profile case so a missing session file never probes macOS Keychain. Existing encrypted
  sessions remain encrypted and are preserved if the keychain is temporarily unavailable.
- Split native notification synchronization into full snapshots only when underlying data changes
  and a constant-size visible-channel update for selection/focus/blur. Main caches unread aggregates
  and avoids duplicate badge calls.
- Replaced the renderer image-menu bridge with Electron's `webContents` `context-menu` event and
  native `Menu`. Images stop bubbling into the message reaction menu. Main copies directly from the
  displayed image coordinates and streams Save to a bounded temporary file rather than accepting a
  huge renderer-owned image string.
- Added complete-write handling for streamed file output rather than assuming one write consumes the
  whole buffer.
- Split Electron main with Bun, retained the isolated host utility, and added budgets for main,
  preload, utility, updater/CLI chunks, maps, native modules, and total runtime output.
- Kept dev Electron split/watch behavior aligned with production; the CLI is still built once when
  the dev watcher starts, so changing CLI source requires restarting the dev process.

### Renderer and React

- Warmed the existing lazy Search boundary only after app-ready/idle, plus pointer/focus intent.
- Moved the notification projection inside its effect to eliminate retained render contexts.
- Stabilized the capability object and hidden-agent callback so selection and routine events do not
  invalidate memoized App/Sidebar work.
- Precomputed mention search keys, removed a second full filter, and updates popup geometry only for
  the bounded result count.
- Changed virtual-row registration to constant-time key lookup and pruned stale size measurements.
- Preserved routine-array identity when a three-second poll has no visible change; offscreen rows use
  `content-visibility: auto` without altering layout, controls, order, or polling cadence.
- Delegated pending rich-widget keyboard shortcuts per document while preserving keyboard behavior.
- Removed the redundant renderer server-version request in Electron; the browser fallback remains.
- Kept channel and timeline mount bounds intact under both workloads.

### Shared compatibility and CSS

- Replaced the CommonJS `semver` barrel on the shared compatibility hot path with a small strict
  SemVer parser/comparator covered for prerelease and build metadata. The CLI still has an independent
  `semver` use, so the dependency was not incorrectly removed from the monorepo.
- Removed `tw-animate-css` and supplied only the exact enter/exit/fade/zoom/slide utilities, keyframes,
  and properties used by the current UI. Timing, easing, class names, reduced-motion behavior, and
  visual language remain unchanged.

## Dependency and lazy-loading audit

No critical dependency regression, missing dynamic import, or obviously unused direct desktop
dependency was found. Runtime imports are bundled even where workspace build tooling declares them as
development dependencies; the packaged ASAR scan independently confirms no runtime `node_modules`
dependency escaped the build.

### Cold graph

- The final renderer JavaScript entry is 633,706 B. Drag-and-drop is the largest discretionary cold
  dependency family: about 228 KB of pre-minified module input across `@dnd-kit/dom` (~150 KB), its
  abstract layer (~41 KB), React bindings (~26 KB), and smaller support modules. Lazily loading the
  whole sidebar would trade launch bytes for first-drag and keyboard regressions. If more cold headroom
  is needed, isolate only the enhancement layer and A/B first pointer drag, keyboard drag, reorder
  focus, and context-menu parity.
- The Radix umbrella is install-heavy but the production runtime is tree-shaken. Its remaining concern
  is mounted menu listener multiplicity, not a demonstrated startup parsing bottleneck.
- Search, settings, plugins/details, routine summary/editor, emoji, documents, and rich-message
  capabilities remain split. Nothing was eagerly imported to hide a first-use delay.

### Rich-message graph

| Capability closure | Raw | Gzip |
|---|---:|---:|
| Base Markdown | 461,812 B | 140,913 B |
| Advanced Markdown | 462,038 B | 141,034 B |
| Code | 649,717 B | 199,369 B |
| Math | 1,015,360 B | 485,971 B |
| Mermaid | 1,137,903 B | 309,890 B |

Shiki exposes 235 lazy languages totaling 7,425,414 B of closure data; the largest measured language
closure was Twig at 1,954,225 B. Mermaid exposes 40 lazy diagrams totaling 3,109,011 B; architecture
was the largest measured diagram closure at 1,938,823 B. None of those nested capability chunks was
missing or pulled into startup. The right optimization is worker-side, cancellable first-use
evaluation and bounded result caching, not eager loading or deleting supported languages.

### Documents and optional native packages

- PDF (1,440,500 B), DOCX (502,432 B), and spreadsheet (363,689 B) viewers/parsers stay lazy; document
  parsing remains off the main renderer path where implemented.
- Emoji data is lazy, cached, and virtualized.
- Optional PDF support installs roughly 25 MB of `@napi-rs/canvas` in the development tree, but it is
  not shipped. The final package contains no `.node`, WASM, source-map, or `node_modules` entry.

## Final build and package

The final coherent production build passed every configured budget:

| Output | Exact raw size | Exact gzip size where gated | Notes |
|---|---:|---:|---|
| Renderer total | 15,515,138 B | 3,764,476 B | 9,862 B below 15,525,000 raw ceiling; 35,524 B below 3.8 MB gzip ceiling |
| Renderer startup | 943,042 B | — | below 1.2 MB ceiling |
| Renderer JS entry | 633,706 B | — | cold application graph |
| Startup CSS | 164,604 B | — | 396 B below 165 KB ceiling |
| Electron main entry | 100,836 B | — | updater excluded from cold main |
| Lazy updater | 541,972 B | — | on demand |
| Host utility | 22,799 B | — | isolated host work |
| Update CLI | 1,476,174 B | — | unpacked executable chunk |
| Preload | 7,918 B | — | no synchronous version IPC |
| Electron runtime total | 2,151,503 B | 532,504 B | all Electron output combined |

The packaged ASAR was 16,306,603 B with 440 entries. Its only top-level payload was `dist/`,
`dist-electron/`, and `package.json`; it contained zero `node_modules`, source maps, WASM files, or
native modules. The raw renderer and CSS gates now have very little headroom. That is an intentional
regression alarm, not evidence that further broad features can safely be added without another split
or an explicit, evidenced rebaseline.

### Packaged smoke

The first empty-profile package launch exposed a real Keychain stall and led to the token-store fix
described above. After the fix, a fresh packaged directory build navigated its local file entry in
78.8 ms, showed the first UI in 96.1 ms, had no frame over 20 ms in a 120-frame sample, and reached the
username/password auth gate.

The packaged local-directory build used the normal port-8787 user tunnel, so its smoke intentionally
validated package boot and authentication rather than attaching it to the auth-free audit database.
The data-rich path was tested through the exact frozen production renderer at port 5175 against the
disposable heavy server at port 8879. No notarized artifact, signed release DMG, real update install,
or update rollback was exercised.

## CUA usability and visual parity

The final production replay preserved the existing light-theme layout, typography, colors, rounded
surfaces, spacing, sidebars, details panel, search rows, composer, and animation language. It exercised:

- Search opened to a focused input in 22 ms after idle preload; a `png` query navigated to Audit Bot
  0002 and focused the matching file message.
- The image preview opened. Coordinate right-click showed Electron's native `Copy image`,
  `Save image…`, and `Copy image address` menu and did not show the message reaction menu. The menu was
  dismissed without copying or saving.
- Typing `@` showed mention suggestions; Down and Escape worked. The draft was cleared and never sent.
- The attachment drawer showed `Attach files` and dismissed normally; no file dialog action was taken.
- Compact sidebar mode toggled and restored to the prior 280 px width.
- Settings → General, Computer, and Updates loaded their lazy sections and closed normally.
- The composer remained empty at the end of the replay.

No message was sent, no profile/account setting was changed, no save destination was chosen, and no
installed OpenBot profile was used. These checks found no visible or keyboard usability difference
from the optimization work; they do not substitute for physical Windows/Linux and assistive-technology
release qualification.

## Remaining bottlenecks and recommendations

### P1: typed deltas instead of coarse aggregate refreshes

The normal bootstrap is bounded, but the heavy bootstrap is still 1.58 MB and a product event can
still trigger a full aggregate reconcile. Add typed message, channel, unread, run, approval, routine,
and bot-lifecycle deltas with a cursor-based trailing recovery path. This is the next architectural
change most likely to improve latency, network use, and background power together.

### P1: cap retained warm history by message count and bytes

DOM virtualization bounds mounted rows, not retained JavaScript arrays. Repeatedly loading older pages
can grow each warm channel, and three warm channels are retained. Add per-channel message and byte
ceilings while preserving the visible anchor/context window; refetch evicted pages. Gate it with
thread-root, deep-link, search-target, and prepend-anchor tests.

### P1: move rich first-use computation off the renderer

Lazy loading keeps Shiki and Mermaid out of startup, but first-use grammar initialization/tokenization
still produced the only realistic launch long task. Move tokenization and diagram preparation to
module workers with cancellation and bounded compact-result caches. Keep the current broad capability
set lazy.

### P1 correctness/performance: resolve virtual message links by index

Internal `sand-msg` links still depend on finding a mounted DOM node. A target outside the virtual
window can fail silently. Resolve the target to its virtual index/context, call `scrollToIndex`, then
focus the mounted row. This is functional parity work exposed by the performance architecture.

### P2: main-owned background notification subscription

`backgroundThrottling: false` preserves minimized notification delivery because the renderer owns the
live stream, but it can keep Chromium active in the background. Move the durable subscription and
projection to main or a dedicated utility, verify completion/needs-input parity while minimized, then
restore Electron's default throttling.

### P2: reduce host serialization and lifecycle growth

- A maximum 10 MiB host image can still become roughly 14 MB of base64/JSON across the host
  utility/main boundary; `JSON.stringify` measured 10.3 ms p50 and 22.6 ms p95. Prefer `AssetRef`, a
  stream, buffer transfer, or `MessagePort`.
- Terminal logs can approach 64 MiB each without age/count/total-byte retention. Protect active logs
  and prune inactive logs by all three dimensions.
- Bulk downloads are serial and have no overall byte ceiling, progress UI, or cancellation. A bounded
  three- or four-item pool should reduce latency without material memory growth.

### P2: routine polling bandwidth

The visible 250-routine summary still downloads about 176 KB every three seconds. This pass prevents
an unchanged response from committing/painting again, but not its network and JSON cost. Add an ETag,
revision token, or event invalidation so unchanged polls return 304 or a tiny version response.

### P2: protect the nearly full build budgets

Renderer raw has 9,862 B of headroom and CSS has 396 B. Keep both hard gates. The first candidate for
future cold splitting is the DnD enhancement layer, but only after first-drag and keyboard A/B proves
no usability regression. Do not rebaseline solely to make CI green.

### P3: reduce mounted menu roots and optional-surface retention

Radix keyboard-modality listeners dominate the remaining document-keydown inventory when many menus
are mounted. Reduce menu-root multiplicity or share a higher-level menu where practical, then re-run
keyboard and pointer parity. Also give optional-surface data explicit ownership/TTL so closing a lazy
dialog does not leave an unbounded cache. Search cancellation already prevents stale rendering, but
server-side cancellation could avoid finishing superseded queries.

## Validation and limitations

Final gates:

- Desktop tests: **303 passed, 0 failed**.
- TypeScript: passed.
- Production renderer and Electron build: passed.
- Renderer startup, entry/total/gzip, CSS, dynamic-boundary, Shiki/Mermaid, Electron-output,
  source-map, WASM, and native-module budgets: passed.
- Isolated macOS directory package: built and inspected; fresh-profile smoke passed after the Keychain
  fix.
- CUA parity: passed for the exact actions listed above, with no message or file action committed.

The evidence supports the conclusion that the audited macOS production app is smooth under the
tested realistic and heavy workloads, that each reported fix removed its measured bottleneck, and
that the visible workflows checked by CUA did not regress. It does not claim physical-device
Windows/Linux behavior, assistive-technology coverage, a multi-hour background power soak, a signed
and notarized release, a live update/rollback, or every native file-dialog branch.
