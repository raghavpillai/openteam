# OpenBot desktop performance audit

**Audit date:** 2026-08-29

**Source baseline:** `a2d065e8825ff4061435be13fa7a94c108d3b019`, plus the existing uncommitted working-tree changes present during the audit

**Desktop runtime:** Electron 43.4.1, Bun 1.3.8, Node 24.13.1

**Test machine:** Mac mini (Mac16,11), Apple M4 Pro, 12 CPU cores, 24 GB RAM, macOS 26.5.2 (25F84), arm64

## Executive verdict

OpenBot is responsive with a tiny dataset, but it is not yet buttery smooth at realistic long-lived scale. The dominant problems are architectural rather than animation or CSS tuning:

1. the desktop repeatedly downloads, parses, fingerprints, and propagates the complete application history;
2. chat and sidebar trees are not virtualized, and chat rendering contains an O(messages²) lookup;
3. images can be retained as very large base64 strings in requests, durable state, snapshots, and IPC;
4. burst updates produce one persisted sidebar request per newly unread channel;
5. expensive host work and unbounded child-process output run in Electron's main process;
6. search prevents PostgreSQL from using its GIN index;
7. the packaged app includes **252.1 MB** of production dependencies that the renderer has already bundled; and
8. the normal renderer entry eagerly embeds the complete emoji index and initializes the contracts schema barrel, while the one broad “advanced Markdown” boundary loads code, math, CJK, and Mermaid together.

The failure modes are measurable, not hypothetical. Opening a 10,020-message conversation through the real Electron UI blocked the renderer for about **5.1 seconds**, mounted **220,077 DOM elements**, retained roughly **884 MB of live JavaScript heap**, and made a one-page scroll take **574 ms**. With the same conversation selected at reload, the chat was not ready for **8.19 seconds**. At 1,000 bots with a short chat, startup was materially better but still produced an **850 ms long task** and needed **2.75 seconds** before the selected chat was ready.

The dependency follow-up found substantial work even before scale becomes a factor. The normal entry is **1.778 MB** of JavaScript. Ordinary Markdown raises the loaded JavaScript total to about **2.24 MB**; a fresh Mermaid message raised it to **3.52 MB across 31 JavaScript files**. The expanded emoji picker mounted 1,914 emoji buttons and increased the page from 561 to 2,512 elements. A fresh package was **273.35 MB ASAR**, of which 252.1 MB and 17,937 files were redundant `node_modules`.

The app also has good foundations worth preserving: secure BrowserWindow defaults, one renderer, direct HTTP/SSE instead of routing all data through IPC, structural snapshot reconciliation, memoized rows, lazy rich-message rendering, content visibility, and existing Long Task/Event Timing instrumentation. The recommended changes build on those choices.

## Scope and method

The audit combined five kinds of evidence:

- Static review of the Electron main/preload code, renderer state and component trees, server snapshot/search/event paths, worker projection paths, and packaging configuration.
- Production builds of the current desktop code, not a Vite development renderer. Main and preload were rebuilt immediately before the UI run because the current development command can otherwise launch stale ignored output.
- Real UI interaction through macOS accessibility/Computer Use: global search, bot selection, warmed channel switching, long-transcript opening, scrolling, and reload. DOM clicks were not substituted for these user actions.
- Runtime diagnostics from `window.openbotPerformance`, Chromium DevTools Protocol performance counters, process RSS, direct HTTP timing, PostgreSQL `EXPLAIN (ANALYZE, BUFFERS)`, and microbenchmarks of the exact production algorithms.
- A second dependency/loading pass using a production Vite manifest, source maps, controlled alias/externalization builds, a fresh electron-builder package, ASAR inspection and repacking, and actual first-use resource traces for Search, Plugins, GroupForm, Markdown, TypeScript, math, Mermaid, and emoji through the Electron UI.

The interactive fixture ran in a separate Compose project, database, volume, ports, Electron profile, and stub computer service. The deeper server fixture used a second disposable database. No normal OpenBot rows or user volumes were modified. Both synthetic databases were removed after the audit.

The reproducible harness is in [`scripts/performance`](../scripts/performance/README.md).

## Measured results

### Interactive Electron scale matrix

All snapshot HTTP figures below are repeated direct localhost requests against the same current-source server used by Electron. UI figures are production-renderer observations in Electron with `?profile=1`.

| Scenario | Data | Snapshot | Renderer after settle | User-visible result |
|---|---|---|---|---|
| Baseline | 10 bots, 12 channels, 240 messages | 114 KB; 7.5 ms average; 8.5 ms p95 | 760 elements; 859 nodes; 302 listeners; 15.5 MB JS heap | First UI paint 226 ms; FCP 604 ms; channel switch 18.4–27.9 ms; click Event Timing 48–104 ms |
| Medium | 250 bots, 275 channels, 5,500 messages | 2.66 MB; 35.2 ms average; 40.6 ms p95 | 6,093 elements; 7,049 nodes; 1,648 listeners; 39.8 MB JS heap | Warm switches 21.2–25.3 ms; clicks 64 ms; unread burst requests reached 661 ms |
| Heavy sidebar | 1,000 bots, 1,100 channels, 22,000 messages | 10.65 MB; 126.8 ms average; 212.8 ms p95 | 20,041 elements; 23,472 nodes; 5,970 listeners; 84.2 MB JS heap | Bot switch 36.8 ms; click 72 ms; 67 and 109 ms long tasks |
| Heavy transcript | Same sidebar plus 10,000 extra messages in one chat | 14.72 MB; 152.3 ms average; 165.1 ms p95 | 220,077 elements; 234,013 nodes; 56,037 listeners; 883.5 MB JS heap | Open 5.10 s; click 4.21 s; long tasks 4.05 s and 1.03 s; one-page scroll 574 ms |

At 1,000 bots, a cold reload with a normal 20-message chat selected measured:

- first UI paint: 646 ms;
- first contentful paint: 668 ms;
- selected chat ready: 2.75 s;
- longest task: 850 ms;
- post-GC live heap: 78.2 MB;
- 19,145 DOM elements and 4,569 listeners.

With the 10,020-message chat selected, a cold reload measured:

- first UI paint: 2.21 s;
- first contentful paint: 2.24 s;
- selected chat ready: 8.19 s;
- long tasks: 4.64 s, 913 ms, and 359 ms;
- post-GC live heap: 837 MB;
- 219,145 DOM elements and 44,569 listeners.

During the long-chat reload, the old and new documents briefly occupied about **1.97 GB of JavaScript heap** before forced collection. Collection reduced the live heap to 837 MB, but after returning to a 20-message chat and collecting again, the renderer process still held about **927 MB RSS**. That high-water behavior makes one pathological chat affect the rest of the session.

### Live-update amplification

The app has a visible watchdog at [`use-openbot.ts:65-71`](../apps/desktop/src/renderer/state/use-openbot.ts#L65), so an otherwise idle visible window performs another full snapshot roughly every 12 seconds. This contradicts the earlier “no snapshot polling while idle” result in [`plans/24-performance-optimization.md:77`](24-performance-optimization.md#L77).

Adding channels while the app remained open exposed a second amplification path:

- moving from 275 to 1,100 channels introduced 825 new channels;
- the UI issued approximately one `PATCH /api/v0/settings/sidebar` per newly unread channel;
- the final settings object held 1,086 unread IDs and serialized to about 42.5 KB;
- the 200-entry performance ring became entirely sidebar PATCH calls;
- those retained calls averaged 2.10 s, with 2.35 s p95 and 2.38 s maximum.

The source loop is at [`App.tsx:123`](../apps/desktop/src/renderer/App.tsx#L123), and each call independently serializes, writes local storage, and persists remotely in [`use-sidebar-preferences.ts:149`](../apps/desktop/src/renderer/hooks/use-sidebar-preferences.ts#L149) and [`use-sidebar-preferences.ts:197`](../apps/desktop/src/renderer/hooks/use-sidebar-preferences.ts#L197).

Adding the long transcript while it was still closed also caused two full snapshots, 11.9–19.4 ms reconciliation, and a 97 ms long task. Opening it then caused UI-thread contention severe enough that unrelated tiny requests appeared to take 2.4–5.8 seconds in renderer instrumentation.

### Deep server/database fixture

A second disposable database exercised the server independently with:

- 1,000 bots and 1,100 channels;
- 119,900 channel messages, including one 10,000-message DM;
- 20,000 runs, 80,000 run items, and 2,000 approvals;
- 250,000 events; and
- about 127,600 search documents.

The complete client snapshot measured:

| Phase | Result |
|---|---:|
| Service query, mapping, and internal clone | 1,223 ms |
| Final HTTP JSON serialization | 121 ms |
| Payload | 102,327,695 bytes |
| Server heap increase | 277 MB |
| Localhost HTTP TTFB | 887–1,028 ms |
| Localhost total transfer | 1.145–1.275 s |
| Client fetch plus `response.json()` | 1.220–1.284 s |
| Client heap increase | about 98 MB |

The service also clones the completed snapshot with `JSON.stringify` plus `JSON.parse` in [`view-mappers.ts:4`](../apps/server/src/services/view-mappers.ts#L4); that clone alone took 227 ms at 102 MB. `Server-Timing` understates the total because it is computed before `Response.json()` performs the final serialization in [`main.ts:141`](../apps/server/src/main.ts#L141).

Search at the same scale showed a separate query-planning bug:

| Query | Current implementation | Equivalent indexed predicate |
|---|---:|---:|
| Missing term | 297–306 ms | 0.384 ms |
| Common term (`buttery`) | about 1,076 ms | 247 ms |

The `search_input AS MATERIALIZED` CTE in [`search-service.ts:71`](../apps/server/src/services/search-service.ts#L71) prevents the full-text predicate from becoming a GIN index condition. The missing-term plan scanned all 127,600 documents and spent 244 ms in PostgreSQL JIT; the inline form used the existing GIN bitmap index.

### Exact Electron-main microbenchmarks

The host bridge performs file processing and command orchestration in Electron main. Running its exact algorithms produced:

- A permitted 10 MiB short-line file became 5,242,881 numbered lines and a 56.6 MB intermediate string before truncation, consuming 454 ms CPU and roughly 637 MB peak RSS.
- A 128 MiB child-process output burst made all 2,049 stream writes report backpressure, but the code ignored every `false`; 66 MiB became queued, 39 MiB remained queued when the child closed, and the test reached 137 MiB RSS.

The relevant main-process paths are [`host-bridge.ts:127`](../apps/desktop/src/main/host-bridge.ts#L127), [`host-bridge.ts:184`](../apps/desktop/src/main/host-bridge.ts#L184), and the main listener at [`index.ts:233`](../apps/desktop/src/main/index.ts#L233).

### Build and package footprint

The current production renderer distribution contains:

| Asset class | Count | Raw bytes |
|---|---:|---:|
| JavaScript | 402 | 15,204,809 |
| CSS | 1 | 150,549 |
| Fonts | 59 | 1,072,948 |
| HTML | 1 | 1,167 |
| **Total renderer** | **463** | **16,429,473** |

Normal startup reads the 1,777,993-byte entry, a 716-byte Rolldown runtime, and 150,549-byte CSS file: **1,929,258 raw bytes** before application data. The entry is about 401.7 KB gzip and the three-file startup set is about 425 KB at gzip level 9, but the packaged `file://` renderer reads the raw assets from ASAR. Gzip is an artifact/download comparison, not the local parse input.

The earlier packaged entry was 389,682 bytes, and the earlier performance plan reported a 372.7 KB / 118.3 KB gzip entry. The current 1.778 MB entry is therefore roughly 4.6–4.8 times larger raw. The current CSS is 150,549 bytes versus 45,689 bytes in the prior package.

A fresh current-source arm64 package, rather than the older artifact used in the first pass, measured:

| Package surface | Current result |
|---|---:|
| `app.asar` | 273,352,346 B |
| Logical ASAR contents | 268,559,686 B |
| ASAR header | 4,792,652 B |
| ASAR files / directories | 18,404 / 1,435 |
| Copied `node_modules` | 252,109,925 B; 17,937 files |
| Renderer `dist` | 16,429,473 B; 463 files |
| Main + preload | 19,426 B; 3 files |
| macOS arm64 ZIP | 175,199,190 B |
| Uncompressed application | 561,032,206 B / 535 MiB |

`node_modules` is **93.9%** of logical ASAR contents. Main and preload are fully bundled and resolve only Electron and Node built-ins; the renderer is already bundled by Vite. None of the 19 production dependencies is needed as a runtime Node module.

To prove the limit rather than estimate it, the exact package was repacked without `node_modules`:

| Metric | Current | Dependency-free proof |
|---|---:|---:|
| ASAR | 273,352,346 B | 16,574,505 B |
| Header | 4,792,652 B | 124,736 B |
| Files | 18,404 | 467 |
| Gzip proxy | 56,122,866 B | 4,073,582 B |
| Header parse p95, 100-run Node proxy | 13.85 ms | 0.356 ms |

That is a **93.94% ASAR reduction** and a **97.4% metadata-header reduction** without changing application code. The macOS `ElectronAsarIntegrity` value matched the SHA-256 of the ASAR header, making that header directly relevant to mount/integrity work. The proof was not shipped as a release artifact, but it projects an approximately 290 MiB uncompressed macOS application and roughly 117 MiB ZIP; Electron itself becomes the dominant remaining size.

The 252 MB is platform-independent JavaScript/assets, so the same waste recurs in macOS, Windows, Linux, every architecture, CI storage, downloads, installation, signing, antivirus scanning, and update calculations. Framework overhead differs by target, so each artifact needs its own outer-size budget while sharing the same ASAR invariants.

The redundant dependency copy contains 94.2 MB of source maps, 50.9 MB of JSON, 14.8 MB of TypeScript source/declarations, 7.8 MB of demo GIFs, and 5.85 MB of byte-identical duplicates. It contains no native `.node` addons and nothing under `app.asar.unpacked`, so `npmRebuild: false` is safe today but must be guarded if a native runtime dependency is ever added. The build also retained a stale 245-byte `preload.js` beside the used `preload.cjs`, confirming that `dist-electron` is not cleaned before packaging.

## Dependency and loading deep dive

### Runtime dependency verdict

Every production dependency in [`apps/desktop/package.json:17-36`](../apps/desktop/package.json#L17) is a renderer or build-time input. There is no dead direct declaration—the declarations are used—but all 19 are in the wrong packaged-runtime class. Main is an 18.4 KB bundle and preload is an 810-byte bundle; both externalize only `electron` and use Node built-ins. The renderer resolves its packages into static assets. A private desktop package can therefore move these libraries to `devDependencies`, or packaging can generate a dependency-free staging manifest containing only `dist`, `dist-electron`, and application metadata.

The “own / closure” figures below are exact raw bytes inside the fresh ASAR. Closures follow package dependencies and overlap, so they must not be summed.

| Direct dependency | Actual load/use | Own / closure bytes | Assessment |
|---|---|---:|---|
| `@dnd-kit/dom` | Eager sidebar pointer constraints | 1,172,259 / 1,983,094 | Used; build-only. Part of about 115 KB raw eager DnD code. |
| `@dnd-kit/react` | Eager sidebar sortable/DnD hooks | 229,423 / 2,212,517 | Used; build-only. Defer registration to visible rows or active reorder mode. |
| `@openbot/contracts` | 36 type-only references; two avatar-helper value imports | 891,101 / 24,709,468 | Used; build-only. Root barrel pulls Effect and both tool catalogs into startup. |
| `@streamdown/cjk` | Broad advanced-message boundary | 2,713 / 991,439 | Used; build-only. Loaded for code/math even without CJK-specific need. |
| `@streamdown/code` | Broad advanced-message boundary | 2,971 / 13,485,906 | Used; build-only. Its API imports Shiki's bundled registries. |
| `@streamdown/math` | Broad advanced-message boundary | 1,875 / 6,443,974 | Used; build-only. KaTeX is paid with every advanced message. |
| `@streamdown/mermaid` | Broad advanced-message boundary | 1,915 / 125,447,123 | Used; build-only. Mermaid core is statically reachable for ordinary code/math. |
| `class-variance-authority` | Eager button/badge variants | 18,369 / 22,438 | Used; build-only. |
| `clsx` | Eager `cn` helper | 4,069 / 4,069 | Used directly; build-only. |
| `emojibase-data` | Eager English JSON in emoji picker | 50,011,176 / same | Used; build-only. Only English is bundled, but all locales are copied to ASAR. |
| `katex` | Global CSS plus math plug-in | 4,019,198 / 4,109,042 | Used; build-only. All font formats are shipped before math is used. |
| `lucide-react` | Named icons in 22 renderer files | 19,924,469 / same | Used; build-only. Tree-shaking works in the bundle; full package copying is the issue. |
| `radix-ui` | Eager umbrella import for 14 primitives | 37,741 / 4,529,864 | Used; build-only. Direct primitive packages would reduce install/packaging breadth. |
| `react` | Eager renderer core | 170,356 / same | Used; build-only in packaged Node terms. |
| `react-dom` | Eager root and portal renderer | 7,318,210 / 7,400,425 | Used; build-only. About 179 KB of the minified entry. |
| `streamdown` | Lazy basic/rich Markdown | 495,455 / 4,755,777 | Used; build-only. Basic Markdown's first load is still about 461 KB raw. |
| `tailwind-merge` | Eager `cn` helper | 876,408 / same | Used; build-only. About 27 KB of the minified entry. |
| `tw-animate-css` | CSS build import only | 31,938 / same | Used only at build time. |
| `use-stick-to-bottom` | Eager conversation scrolling | 22,928 / same | Used; build-only. |

All ten dev dependencies were also traced to a real use:

| Dev dependency | Evidence |
|---|---|
| `@tailwindcss/vite` | Vite plug-in at [`vite.config.ts:1`](../apps/desktop/vite.config.ts#L1) |
| `@types/react`, `@types/react-dom` | Renderer TypeScript declarations |
| `@vitejs/plugin-react` | Vite plug-in at [`vite.config.ts:2`](../apps/desktop/vite.config.ts#L2) |
| `concurrently`, `wait-on` | Desktop `dev` script |
| `electron` | Desktop runtime, local launch, types, and packaging input |
| `electron-builder` | `package` script |
| `tailwindcss` | Global stylesheet compilation |
| `vite` | Dev server and renderer production build |

The largest redundant packages show why declaration topology dominates the ASAR:

| Copied package | Bytes |
|---|---:|
| `mermaid` | 83,346,755 |
| `emojibase-data` | 50,011,176 |
| `effect` | 22,920,918 |
| `lucide-react` | 19,924,469 |
| `@mermaid-js/parser` | 11,845,330 |
| `cytoscape-fcose` | 9,302,011 |
| `@shikijs/langs` | 8,041,605 |
| `react-dom` | 7,318,210 |
| `cytoscape` | 5,398,253 |
| `katex` | 4,019,198 |

Those ten account for 88.1% of copied `node_modules`. Eight package names are present at multiple versions, primarily through Mermaid/graph and Streamdown chains: `marked`, `d3-array`, `d3-path`, `d3-shape`, `internmap`, `layout-base`, `cose-base`, and `commander`. The smaller duplicate copies total about 1.1 MB. Version alignment is lower priority because the entire runtime copy should disappear.

Tree-shaking itself is mostly healthy: Lucide emits only the used icons, Radix's renderer code is pruned to used primitives, the 3 KB GroupForm chunk excludes unrelated form exports, and no positive-size source module was duplicated across output chunks. It cannot property-shake the emoji JSON, and it cannot discard the contracts root's top-level tool-catalog mapping and Effect schema construction. Fixing package/export boundaries is more robust than relying on extra purity annotations.

### Two hidden startup regressions

#### The complete emoji index is eager

[`emoji-picker.tsx:2`](../apps/desktop/src/renderer/components/openbot/emoji-picker.tsx#L2) imports the 775,157-byte English JSON file. [`chat-pane.tsx:67`](../apps/desktop/src/renderer/components/openbot/chat-pane.tsx#L67) imports that module to obtain both quick reactions and the full panel, so the JSON enters the normal entry. Module initialization then filters and sorts the records and builds a glyph map, grouped arrays, and an all-emoji array at [`emoji-picker.tsx:24-38`](../apps/desktop/src/renderer/components/openbot/emoji-picker.tsx#L24), before any picker is opened.

A controlled build replacing the data import with an empty module reduced initial assets by **775,173 raw bytes / 94,097 gzip bytes**. A compact generated dataset with only the fields actually read would be about 232,760 bytes as objects or 166,900 bytes as tuples (about 46 KB gzip), before lazy loading. The correct boundary is a tiny eager quick-reaction module plus an on-open full panel/data module.

#### Avatar helpers execute the contracts schema barrel

There are 38 renderer references to `@openbot/contracts`, but 36 are type-only. The only value imports are avatar helpers in [`avatar-picker.tsx:1`](../apps/desktop/src/renderer/components/openbot/avatar-picker.tsx#L1) and [`avatar-picker-icons.tsx:1`](../apps/desktop/src/renderer/components/openbot/avatar-picker-icons.tsx#L1). The package exposes only `.` at [`packages/contracts/package.json:6`](../packages/contracts/package.json#L6); that root imports Effect and both tool-catalog JSON files before re-exporting the small avatar module at [`packages/contracts/src/index.ts:1-5`](../packages/contracts/src/index.ts#L1).

A controlled build redirecting those two imports to `bot-avatar.ts` reduced startup by **264,250 raw bytes / 81,632 gzip bytes**. Add an exported, side-effect-free `@openbot/contracts/bot-avatar` subpath and use it for those imports. Effect remains appropriate where runtime schemas are required; avatar constants should not initialize it.

Together, these two causes explain about 1.04 MB of the 1.778 MB entry. Raw-size subtraction suggests an entry near 739 KB before any other optimization; a combined build should establish the actual compressed result. Controlled optional-surface builds attributed another 134,888 raw / 34,695 gzip bytes to UI that can be mounted on demand. The complete model reached roughly **604 KB raw / 185 KB gzip** after emoji, contracts, and optional-surface changes, and **490 KB / 148 KB** with DnD deferred as well—a modeled 72% raw reduction. Changing Vite's target to Electron's Chromium saved only 1.7 KB. The build target is not the regression.

| Eager optional surface | Isolated entry cost raw / gzip |
|---|---:|
| Inspector, including routines/screen/settings modes | 80,683 / 21,370 B |
| Plugins | 21,262 / 4,511 B |
| Settings/About | 12,179 / 2,848 B |
| Search | 10,305 / 2,945 B |
| Async tasks | 3,830 / 1,009 B |
| New Bot | 3,186 / 666 B |
| Desktop dialogs | 2,594 / 811 B |
| A2A sheet | 342 / 87 B |

### Complete lazy-boundary audit

There are only three source-authored dynamic imports in the renderer:

- basic Markdown at [`message.tsx:46`](../apps/desktop/src/renderer/components/ai-elements/message.tsx#L46);
- the broad advanced Markdown renderer at [`message.tsx:47`](../apps/desktop/src/renderer/components/ai-elements/message.tsx#L47); and
- GroupForm at [`desktop-dialogs.tsx:17`](../apps/desktop/src/renderer/components/openbot/desktop-dialogs.tsx#L17).

There are no authored `import.meta.glob` registries, module prefetch/preload hints, idle feature preloads, or other dynamic feature boundaries. The hundreds of additional imports are generated inside Shiki and Mermaid registries.

`React.lazy` is declared correctly at module scope, Suspense fallbacks work, and Vite fetches each boundary's static imports in parallel. The problem is coverage and granularity, not incorrect use of `lazy`.

| Actual trigger in Electron | Incremental resource load | What the trace showed |
|---|---:|---|
| Empty shell | 2 JS files, 1,778,709 B; one 150,549 B CSS file | Empty database UI ready 199 ms; FCP 244 ms; 53 elements. |
| Open New Channel | 1 JS file, 3,085 B | GroupForm loaded only on open. This boundary works well. |
| First ordinary Markdown | 2 JS files, about 461,014 B | A roughly 300 B facade pulls a roughly 460.7 KB Streamdown/config/parser chunk. |
| Any fenced code or math | 19-file static closure, about 1.63 MB | CJK, code, math, Mermaid, and their shared graph/parser code load together. |
| TypeScript fence after basic Markdown | 21 new JS files, 1,359,749 B | Includes the rich static closure not already cached plus 181,146 B TypeScript grammar and 11,402 B dark theme; chain span 349 ms locally. |
| Math after rich renderer cached | 3 fonts, 47,920 B | KaTeX loaded Size2, Main Regular, and Math Italic WOFF2; about 23 ms locally. |
| Mermaid after rich renderer cached | 10 JS files, 112,997 B | Flow parser/layout modules were requested about 632 ms after the tiny Mermaid entry; resource-chain span 648 ms. |
| Fresh Mermaid reload | 31 JS files, 3,519,023 B, plus CSS | Shell FCP 100 ms; diagram-dependent resources completed at 766.5 ms. |
| Open full emoji picker | No new JS—the data was already eager | Elements rose 561 → 2,512; 1,914 emoji buttons; CDP nodes +3,878, layout objects +5,793, listeners +1,939; controlled max frame gap 33.3 ms. |
| Filter emoji for “rocket” | No request | 1,914 buttons fell to four about 7.2 ms after the input event. Search is fine; initial mounting is not. |
| Open Search | No new JS | UI is eager. An empty query was already sent in the background, then repeated when its 15 s cache expired. |
| Open Plugins | No new JS; one `/plugins` request | UI is eager, but plugin data fetching is correctly gated by `open`. |

The fresh Mermaid trace is especially useful because it separates shell paint from feature readiness. The shell painted at 100 ms on the small fixture, but 1.63 MB of advanced static JavaScript began after the 10 KB snapshot, a hidden empty search ran at 349 ms, and Mermaid's diagram-specific modules did not finish until 766.5 ms. There were no >50 ms long tasks on this fast machine for that small case, but the content was not fully ready at FCP.

The advanced boundary is selected by one regex at [`message.tsx:50`](../apps/desktop/src/renderer/components/ai-elements/message.tsx#L50). [`message-response-rich.tsx:1-5`](../apps/desktop/src/renderer/components/ai-elements/message-response-rich.tsx#L1) statically imports all four plug-ins and passes them together at line 25. Approximate modeled static closures make the coupling visible:

| Renderer composition | Raw | Gzip proxy |
|---|---:|---:|
| Streamdown base | 459.6 KB | 138.2 KB |
| Base + CJK | 484.6 KB | 146.7 KB |
| Base + code, before grammar/theme | 652.7 KB | 198.2 KB |
| Base + math | 730.4 KB | 218.8 KB |
| Base + Mermaid | 1.136 MB | 307.4 KB |
| **Current all-plug-in boundary** | **1.627 MB** | **456 KB** |

Split code, math, and Mermaid by detected syntax. A `mermaid` fence should be the only path that imports Mermaid. A math expression should import KaTeX and its CSS. A normal fence should import a constrained highlighter. CJK support can join only renderers that need it.

### The deferred universe is still too broad

The advanced renderer exposes **341 potential dynamic imports**. Its complete reachable closure is 380 files and 13,420,053 bytes—81.7% of the whole renderer distribution. Major families include 213 Shiki language entry chunks (5,688,071 bytes), 65 Shiki themes (1,311,967 bytes), 55 Mermaid/parser dynamic entries (1,102,487 bytes), graph engines, and a shipped Shiki Oniguruma/WASM path. These files do not load at startup, which is good, but they increase package size, ASAR metadata, update/signing/antivirus work, and worst-case first feature use.

The app supplies a custom light theme and `github-dark` at [`message-response-config.tsx:74`](../apps/desktop/src/renderer/components/ai-elements/message-response-config.tsx#L74), so the other emitted themes are unlikely to be reachable through application configuration. `@streamdown/code` imports Shiki's complete bundled registry and does not expose a language allowlist. Use or upstream a plug-in built on `shiki/core` with explicit common languages, the two real themes, the JavaScript regex engine, cached highlighters, and a plain-code fallback/on-demand path for uncommon grammars.

[`vite.config.ts:17-29`](../apps/desktop/vite.config.ts#L17) defines the renderer base, plug-ins, dev proxy, and output directory but no manifest/bundle gate, feature budgets, preload policy, CSS strategy, or Electron Chromium target. The output has no positive-size source-module duplication across chunks, so broad manual chunking is not the answer. Track entry plus complete feature closures in CI and fix dependency boundaries; do not merely raise Vite's 500 KB warning.

### CSS and font loading

[`styles.css:3`](../apps/desktop/src/renderer/styles.css#L3) globally imports KaTeX CSS. Vite therefore emits 59 unique font assets totaling 1,072,948 bytes: 20 TTF files (513,664 B), 20 WOFF files (303,116 B), and 19 emitted WOFF2 files (256,168 B; one source duplicate is deduplicated). Chromium fetched only the three WOFF2 faces used by the math fixture, so this is primarily install/ASAR waste plus roughly 24 KB of initial CSS, not a 1 MB startup transfer.

Controlled stylesheet builds measured the individual sources:

| CSS composition | Raw / gzip proxy |
|---|---:|
| Current | 150,549 / 29,278 B |
| Without KaTeX | 122,068 / 20,689 B |
| Without Streamdown plug-in sources | 141,557 / 28,093 B |
| Without `tw-animate-css` | 146,495 / 28,590 B |
| Without all three | 109,022 / 18,860 B |

KaTeX alone costs 28,481 raw / 8,589 gzip bytes in the startup stylesheet. One 3,624-byte WOFF2 face is inlined because it falls below Vite's default asset threshold.

Import KaTeX CSS from the math-only boundary and use WOFF2-only declarations for the fixed Chromium runtime unless a measured compatibility requirement says otherwise. [`styles.css:4-8`](../apps/desktop/src/renderer/styles.css#L4) also asks Tailwind to scan Streamdown and every plug-in. Those directives are build-time inputs, not runtime imports, but their generated utilities remain in the single 150.5 KB startup stylesheet.

### Missing feature boundaries and proposed loading policy

[`App.tsx:5-15`](../apps/desktop/src/renderer/App.tsx#L5) statically imports A2A exchange, async tasks, chat, desktop dialogs, inspector/routines/screen UI, new-bot UI, plugin settings, Search, settings/about, and the full DnD sidebar. Search, Settings, Plugins, About, and DesktopDialogs are instantiated at [`App.tsx:753-782`](../apps/desktop/src/renderer/App.tsx#L753) even while closed. Search's mount effect schedules an empty all-category query after 250 ms at [`search-dialog.tsx:162-176`](../apps/desktop/src/renderer/components/openbot/search-dialog.tsx#L162), independent of `open`; its cache lasts only 15 seconds.

Use this load policy:

1. **Eager:** shell, selected short channel, visible/sidebar summary rows, composer, plain messages, quick reactions.
2. **Predictive/idle:** Search after keyboard intent/hover or a truly idle period; inspector summary after first paint if product evidence supports it.
3. **On open:** settings, plugins, transcript, A2A, async tasks, new-bot/group forms, full emoji panel, inspector editors.
4. **On content detection:** basic Markdown, code, math, and Mermaid independently.
5. **Never global by default:** every emoji locale, Shiki language/theme, Mermaid diagram engine, or KaTeX font format.

Conditional rendering matters: wrapping an always-mounted closed component with `lazy()` still requests it as soon as React renders the lazy element. Gate the element itself on its open/active state.

### Complete recurring/background-work inventory

| Cadence/trigger | Work | Gating verdict |
|---|---|---|
| Every 3 s check; full refresh after >10 s | Visible renderer snapshot watchdog at [`use-openbot.ts:65`](../apps/desktop/src/renderer/state/use-openbot.ts#L65) | Bad: repeats full history while SSE is healthy. |
| 32 ms after relevant event | Snapshot refresh debounce | Too broad: event should reduce a patch, not trigger a snapshot. |
| Mutation completion | Explicit snapshot refresh; matching SSE can request another | Bad: `refreshAgain` guarantees a second full fetch if an event overlaps an in-flight refresh. |
| Focus/visibility/SSE reconnect | Full snapshot if last refresh >500 ms | Too aggressive with replayable SSE. |
| Every 750 ms per connected desktop | Server polls the Event table; retries after 1.5 s | Bad at idle; use wakeup/notify and drain batches. |
| 250 ms after closed Search mounts | Empty all-category database search | Bad: competes with startup and cache expires after 15 s. |
| Every 500 ms in `?profile=1` | Serializes metrics summary into DOM attributes | Intentional audit overhead; exclude from release gates or measure it separately. |
| Every 60 s per warm ChatPane | Updates the time label and can rerun transcript derivation | Bad for up to three hidden full trees; use one shared next-change timer. |
| Every 1.5 s in RoutineEditor | Fetch executions and replace array | Bad while inspector/document is hidden; gate and use non-overlapping polling. |
| Every 5 s / 4 s / 20 s | Screen frame refresh, readiness poll, takeover heartbeat | Good: gated by enabled, active, visible/open state. |
| Every 1 s | Async-task elapsed clock | Acceptable: panel exists only while open. |
| 400 ms after profile edit | Bot profile autosave | Mostly reasonable, but its pending timer is not cleared on unmount. |
| 550 ms after routine edit | Routine autosave | Reasonable and cleaned up. |
| 50 ms after Search input | Query debounce with abort/cache | Reasonable after the SQL and eager-prefetch fixes. |

Each warm ChatPane also owns two OpenBot `ResizeObserver`s and a scroll handler, while `use-stick-to-bottom` adds another `ResizeObserver`, scroll and wheel listeners, and requestAnimationFrame scrolling. Three warm panes therefore retain roughly nine observers, six scroll handlers, and three wheel handlers even when two panes are `display:none`. Preserve scroll/draft state, not whole inactive DOM/observer trees.

## Findings and recommendations

### P0 — Replace the full-history client snapshot

**Evidence.** [`snapshot-service.ts:102-175`](../apps/server/src/services/snapshot-service.ts#L102) loads all visible bots, channels, messages, rounds, runs, attempts, run items, and approvals. The renderer downloads it at [`use-openbot.ts:31`](../apps/desktop/src/renderer/state/use-openbot.ts#L31), parses JSON on its UI thread in [`http.ts:41`](../apps/desktop/src/renderer/client/http.ts#L41), fingerprints every entity in [`snapshot-reconcile.ts:29-46`](../apps/desktop/src/renderer/lib/snapshot-reconcile.ts#L29), and propagates a monolithic React value. Reconciliation permanently retains `JSON.stringify(value)` for every entity, then re-stringifies all incoming entities and allocates arrays and live-ID sets on every refresh—even when nothing changed. Events, mutations, reconnects, focus, visibility changes, and the watchdog all request it again. Every mutation explicitly refreshes; its resulting SSE event can independently refresh, and `refreshAgain` deliberately performs another full fetch if the two overlap at [`use-openbot.ts:23-57`](../apps/desktop/src/renderer/state/use-openbot.ts#L23).

**Why it matters.** Work scales with the user's entire retained history rather than the changed entity. At the deep fixture this is a 102 MB response, 1.2 seconds of server work, hundreds of milliseconds of client transfer/parse, and roughly 375 MB of combined temporary heap. The idle watchdog guarantees that cost recurs even without activity.

**Change.** Make bootstrap contain only bot/channel descriptors, latest-message summaries, unread state, active runs, and a revision. Add cursor-paginated channel history (`beforeSequence`, 50–100 rows). Send replayable entity patches/revisions over the event stream and apply them to a normalized external store with selector subscriptions. Load completed run items only for the active channel/run. Use server-owned entity revisions instead of retaining serialized-content fingerprints. Remove the snapshot-wide stringify/parse clone. Until migration is complete, coalesce concurrent snapshots, remove the healthy-idle watchdog, and move parse/reconciliation into a Worker.

### P0 — Virtualize transcripts and remove O(messages²) rendering

**Evidence.** Every timeline entry is mounted at [`chat-pane.tsx:901`](../apps/desktop/src/renderer/components/openbot/chat-pane.tsx#L901). Each row calls `mainMessages.findIndex` at [`chat-pane.tsx:941`](../apps/desktop/src/renderer/components/openbot/chat-pane.tsx#L941). At 10,000 messages that is roughly 50 million comparisons per render before React reconciliation. The pane also constructs maps, derives threads, filters, and sorts transcript data twice. Each message owns action menus, popovers, tooltips, and context-menu structure at [`chat-pane.tsx:328`](../apps/desktop/src/renderer/components/openbot/chat-pane.tsx#L328). Up to three chat trees remain warm at [`App.tsx:569`](../apps/desktop/src/renderer/App.tsx#L569), and each owns a minute clock plus observer/listener machinery.

**Why it matters.** A 10,020-message chat produced a 5.1-second switch, a 4.05-second long task, 220,077 elements, 56,037 listeners, and 884 MB live heap. `content-visibility:auto` avoids some layout/paint but not React creation, hooks, retained objects, markdown work, or event infrastructure.

**Change.** Paginate first, then use a dynamic-height virtualizer with bounded overscan. Precompute row position/group metadata or an ID-to-index map once per timeline. Keep draft and scroll state separately instead of retaining full hidden trees; unmount or strongly suspend hidden panes above a small history threshold. Cache parsed rich-message output by message ID/content hash. Replace the per-pane one-minute clock with one shared next-midnight timer.

### P0 — Materialize image assets instead of retaining base64

**Evidence.** The renderer accepts eight 20 MiB images at [`prompt-input.tsx:19`](../apps/desktop/src/renderer/components/ai-elements/prompt-input.tsx#L19), reads them concurrently as data URLs at [`prompt-input.tsx:83`](../apps/desktop/src/renderer/components/ai-elements/prompt-input.tsx#L83), stringifies them into a request at [`openbot-api.ts:181`](../apps/desktop/src/renderer/client/openbot-api.ts#L181), and the server stores them in message metadata at [`channel-service.ts:178`](../apps/server/src/services/channel-service.ts#L178). Raw metadata returns in every future snapshot at [`snapshot-service.ts:268`](../apps/server/src/services/snapshot-service.ts#L268). It is also duplicated into inbox and idempotency JSON.

**Why it matters.** Eight maximal inputs expand to about 213 MB of base64 before accounting for request JSON, durable copies, parsed snapshots, fingerprints, IPC, and GC. One message can exceed the entire 102 MB deep stress snapshot.

**Change.** Stream attachments to a bounded asset service before creating the message. Store only asset ID, MIME type, dimensions, byte size, and thumbnail descriptor. Use object URLs for temporary renderer previews and an authenticated cached endpoint or secure custom Electron protocol for reads. Generate bounded thumbnails outside the renderer, using `nativeImage` where appropriate. Never place original bytes in snapshots, events, inbox receipts, fingerprints, or idempotency responses. In the interim, add `loading="lazy"` and `decoding="async"` to sidebar avatars and message images so 1,000 offscreen avatars and hidden transcript images are not eagerly decoded.

### P0 — Let search use its GIN index

**Evidence.** The materialized search CTE at [`search-service.ts:71`](../apps/server/src/services/search-service.ts#L71) converts the FTS predicate into a join filter. A zero-result query scanned every row and took about 300 ms; the equivalent inline predicate took 0.384 ms with the existing GIN index.

**Change.** Branch empty-query behavior in TypeScript. Put `searchVector @@ to_tsquery(...)` directly in the SQL predicate and rank from the same inline expression. Validate parameterized queries with `EXPLAIN`, not only literal SQL. Either use the 26 MB title-prefix index in a real candidate query or remove it. Do not issue the unbounded empty search 250 ms after every application mount; trigger it on Search intent or a measured idle budget after the query is fixed.

### P1 — Move host execution out of Electron main and enforce backpressure

**Evidence.** The host HTTP bridge is created in main at [`index.ts:233`](../apps/desktop/src/main/index.ts#L233). File numbering/truncation, PDF buffering, image base64 conversion, shell lifecycle, and output streams are handled there. Shell writes ignore `write() === false` at [`host-bridge.ts:184`](../apps/desktop/src/main/host-bridge.ts#L184); completion resolves after `end()` rather than `finish`; jobs are not globally/per-bot bounded, not cancelled on disconnect, and not all terminated on quit.

**Change.** Keep only window lifecycle, validation, native dialogs, and permissions in main. Launch a named lazy `utilityProcess` for approved host jobs. Communicate by request IDs through `MessagePortMain`; stream bounded chunks with acknowledgements/backpressure. Add a job registry, per-bot/global quotas, disconnect cancellation, shutdown cleanup, log rotation, byte/time limits, and consistent caller/server timeouts. Stream file truncation and PDF output instead of constructing full intermediates.

This follows Electron's own guidance to keep the main/UI thread unblocked and use its multi-process architecture for long-running work: [Electron performance](https://www.electronjs.org/docs/latest/tutorial/performance), [utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process), and [MessagePortMain](https://www.electronjs.org/docs/latest/api/message-port-main).

### P1 — Batch unread persistence

**Evidence.** The 1,000-bot live update produced approximately 825 individual preference PATCHes and saturated the 200-entry metrics ring with requests taking up to 2.38 seconds.

**Change.** Derive the complete next unread set once, update React/local storage once, and debounce/coalesce one remote persistence call. Server writes should use revision/last-write-wins semantics. The same batch API should handle mark-read bursts and bulk channel creation.

### P1 — Virtualize the sidebar and limit drag-and-drop registration

**Evidence.** Expanded and compact sidebars map every row at [`sidebar.tsx:955`](../apps/desktop/src/renderer/components/openbot/sidebar.tsx#L955), [`sidebar.tsx:1047`](../apps/desktop/src/renderer/components/openbot/sidebar.tsx#L1047), and [`sidebar.tsx:1745`](../apps/desktop/src/renderer/components/openbot/sidebar.tsx#L1745). Every expanded row registers a draggable at [`sidebar.tsx:569`](../apps/desktop/src/renderer/components/openbot/sidebar.tsx#L569). Channels are sorted twice.

**Change.** Virtualize unpinned rows, retain pinned/section headers separately, register DnD targets only for visible rows or during an active drag, memoize compact tiles, share one context menu, and remove the redundant sort. Maintain accessible set size/position so virtualization does not degrade keyboard and screen-reader navigation.

### P1 — Remove runtime-unused dependencies and halve the entry

**Evidence.** A fresh package contains 252.1 MB and 17,937 files of copied `node_modules` around a 16.4 MB renderer and 19 KB main/preload. A dependency-free proof reduced ASAR from 273.35 MB to 16.57 MB and the header from 4.79 MB to 125 KB. The normal entry regressed from roughly 390 KB to 1.778 MB. Eager emoji data accounts for 775 KB, and the contracts root imported for avatar helpers accounts for 264 KB.

**Change.** Generate a dependency-free runtime package manifest, or move all 19 bundled renderer dependencies to `devDependencies` while main/preload remain fully bundled. Clean `dist` and `dist-electron` before every build. Verify the finished ASAR—not only `package.json`—for zero `node_modules`, source maps, sources, demos, stale outputs, and native addons. Add `@openbot/contracts/bot-avatar`; split quick reactions from a lazy compact/virtualized emoji panel. Make ASAR bytes, header bytes, file count, initial raw/gzip bytes, and artifact deltas hard CI gates.

electron-builder documents that production dependencies are always copied even with custom file patterns: [application contents](https://www.electron.build/docs/contents/).

### P1 — Split feature loading by actual user intent

**Evidence.** Only three authored lazy imports exist. First ordinary Markdown adds 461 KB. Any fence or math expression adds a 1.63 MB, 19-file static closure containing CJK, Shiki, KaTeX, and Mermaid together. A fresh Mermaid fixture loaded 3.52 MB of JavaScript across 31 files and did not finish its diagram dependency chain until 766.5 ms. Search, Inspector, Plugins, Settings/About, routines, DnD, and the full emoji data are eager. Global KaTeX CSS emits 1.07 MB of fonts.

**Change.** Preserve the plain-text bypass and correct GroupForm boundary. Split basic Markdown, code, math, and Mermaid independently; use `shiki/core` with a curated language/theme set and fallback. Import KaTeX CSS only with math and ship WOFF2 only. Conditionally mount and lazy-load Inspector/modes, Search, Plugins, Settings/About, transcripts, A2A, async tasks, and the full emoji panel. Load DnD only for visible rows or an explicit reorder state. Add import-start, import-resolved, rendered, and next-paint marks per feature.

### P1 — Repair the development/performance workflow

**Evidence.** `dev` starts Vite and Electron but does not build or watch main/preload at [`apps/desktop/package.json:12`](../apps/desktop/package.json#L12). `dist-electron` is ignored. During this audit, source expected `preload.cjs` while the prior ignored build exposed an older preload surface.

**Change.** Add an unavoidable `predev` build immediately, then introduce main/preload watch plus Electron restart while keeping renderer HMR. Clean both output directories first. Performance and CUA commands should always build all three targets, use a production renderer, print the source revision, and fail if output predates source.

### P1 — Coalesce transcript projection and repair event delivery

**Evidence.** Each relevant message/reaction schedules an independent full transcript rebuild at [`messaging/index.ts:1026`](../packages/messaging/src/index.ts#L1026); the worker reconstructs and uploads all history at [`worker.ts:553`](../apps/worker/src/worker.ts#L553). A 10,000-message transcript took about 50 ms warm and generated a 4.77 MB upload, so a 100-event burst can repeat about five seconds of work and create roughly 477 MB of bodies.

The event stream stores renderer-ignored `message.delta` events, polls PostgreSQL every 750 ms at [`main.ts:492`](../apps/server/src/main.ts#L492), emits keepalives on empty polls, catches up only 200 events at a time, and has no retention. A 250,000-event fixture occupied 92 MB and requires at least 15.6 minutes to drain at the current sleep cadence.

**Change.** Use a keyed debounce/singleton transcript job because every projection reads current state. Avoid durable token deltas that no client consumes. Wake SSE with `LISTEN/NOTIFY` or an in-process signal, drain full batches without sleeping, keep alive every 15–30 seconds, add bounded retention, and return `snapshot_required` when a cursor is older than retained history.

### P2 — Stabilize renderer memo boundaries and hidden work

Important secondary sources of avoidable work:

- `agentNameById` is rebuilt by reference on any message change and defeats warmed-chat memoization at [`snapshot-index.ts:59`](../apps/desktop/src/renderer/lib/snapshot-index.ts#L59) and [`chat-pane.tsx:108`](../apps/desktop/src/renderer/components/openbot/chat-pane.tsx#L108).
- App creates fresh callbacks inside warmed pane/inspector maps at [`App.tsx:598`](../apps/desktop/src/renderer/App.tsx#L598) and [`App.tsx:731`](../apps/desktop/src/renderer/App.tsx#L731).
- Every mounted ChatPane advances its own clock every 60 seconds at [`chat-pane.tsx:781`](../apps/desktop/src/renderer/components/openbot/chat-pane.tsx#L781), which can re-enter the O(messages²) timeline derivation in up to three warm panes.
- Inspector pointer movement updates top-level React state continuously at [`App.tsx:688`](../apps/desktop/src/renderer/App.tsx#L688). Fresh pane/inspector callbacks break memo equality, so a resize can invoke chat work for hidden warm panes. The sidebar's imperative-during-drag/commit-on-release implementation is the model to copy.
- Up to three Inspectors remain mounted at zero width. Each unconditionally mounts `RoutinesSummary`, whose mount effect fetches routines at [`routine-panel.tsx:1210`](../apps/desktop/src/renderer/components/openbot/routine-panel.tsx#L1210), so merely visiting chats accumulates hidden requests.
- Hidden routine editors can poll every 1.5 seconds because closing the inspector does not unmount its active editor and the poll ignores visibility/active state at [`routine-panel.tsx:966`](../apps/desktop/src/renderer/components/openbot/routine-panel.tsx#L966).
- `agentNameById` and `botById` are global maps whose reference changes can invalidate every warm chat, sidebar row, and inspector for an unrelated entity update; scope selectors/maps by channel or entity revision.
- `useRecentChannels` updates the warm set in an effect after selection at [`use-recent-channels.ts:5`](../apps/desktop/src/renderer/hooks/use-recent-channels.ts#L5), causing a second App commit on a channel switch. Unstable callbacks can make both commits expensive.
- Nested thread root derivation is O(depth²) at [`threads.ts:21`](../apps/desktop/src/renderer/lib/threads.ts#L21); 5,000 nested replies measured 352 ms.
- Mention suggestions filter twice, traverse editable DOM, force layout, and mount all matches at [`mention-editor.tsx:102`](../apps/desktop/src/renderer/components/openbot/mention-editor.tsx#L102).
- New Bot and GroupForm render every matching bot; an empty `@` mention can mount 1,000 options; transcript events and thread replies are unwindowed; and the full emoji grid mounts 1,914 buttons. Cap, index, and virtualize each large chooser/list.
- Bot profile autosave's 400 ms timer is not cleared on unmount at [`inspector.tsx:72`](../apps/desktop/src/renderer/components/openbot/inspector.tsx#L72).

Use stable/scoped maps and callbacks, imperative CSS-variable resize with one state commit on pointer-up, visibility/active gating, recursive non-overlapping polling, path-compressed thread roots, capped indexed mention results, and batched geometry reads/writes.

### P2 — Correct native image context menus and notification ownership

The renderer currently sends the full image URL, potentially a 26.7 MB data URL, over IPC and main buffers it again. Electron's native `webContents` `context-menu` event already supplies coordinates, source URL, alt text, media type, and suggested filename, and `copyImageAt` avoids that renderer-to-main payload. Use the native path and stream bounded saves: [webContents context-menu and copyImageAt](https://www.electronjs.org/docs/latest/api/web-contents/).

Keep Chromium's default background throttling. Move only lightweight event/notification ownership to main or a utility process so minimized completions are not missed when renderer refreshes are intentionally paused. Aggregate globally and replace per-channel notifications instead of allowing one native notification per bot.

### P2 — Fix performance telemetry before using it as a gate

The 200-entry ring splices old entries at [`performance.ts:31`](../apps/desktop/src/renderer/lib/performance.ts#L31), but the DOM publisher only compares array length at [`performance.ts:79`](../apps/desktop/src/renderer/lib/performance.ts#L79). Once length reaches 200, DOM diagnostics never update. Use a monotonic revision and expose exportable scenario metadata.

Add opt-in Electron-wide metrics:

- `app.getAppMetrics()` sampled by process type;
- JS heap, DOM nodes/listeners, long tasks, Event Timing, and dropped-frame indicators;
- server snapshot rows/bytes/query/map/serialize phases;
- `unresponsive`/`responsive`, `render-process-gone`, and `child-process-gone` events;
- GPU feature status and process crashes;
- utility job queue depth, bytes, cancellation, and backpressure;
- one-click bounded `contentTracing` capture for packaged scenarios.

Electron exposes process metrics and cross-process tracing directly: [app.getAppMetrics](https://www.electronjs.org/docs/latest/api/app/#appgetappmetrics) and [contentTracing](https://www.electronjs.org/docs/latest/api/content-tracing/).

## Target Electron architecture

```text
Renderer
  UI, virtualized views, normalized local store
  Web Worker for temporary parse/reconcile offload
       │
       ├── HTTP + replayable patches ──> OpenBot server/database
       │
       └── narrow validated IPC ───────> Electron main
                                           windows, dialogs, permissions,
                                           native menus, lifecycle, metrics
                                                  │
                                                  └── MessagePortMain
                                                        │
                                                  lazy utilityProcess
                                                  host files, shell/PDF jobs,
                                                  streaming, quotas, cancellation
```

Additional Electron-specific choices:

- Preserve sandboxing, context isolation, disabled Node integration, web security, one BrowserWindow, and default background throttling.
- Keep GPU acceleration enabled; the bottlenecks observed here are CPU/DOM/data volume, not a reason to disable compositing.
- After the larger problems are fixed, benchmark replacing production `file://` with a standard, secure `app://` protocol and `codeCache: true`. Electron documents that privileged standard schemes can support V8 code cache: [protocol](https://www.electronjs.org/docs/latest/api/protocol/).
- Keep direct renderer-to-local-server HTTP/SSE. Do not turn Electron IPC into the general application data bus.

## Delivery order

### Phase 0: stop catastrophic scaling

1. Paginated bootstrap/history plus event patches; remove healthy-idle full snapshots.
2. Dynamic transcript virtualization and O(n) row metadata.
3. Asset-backed images with no base64 in durable state.
4. Inline indexed search predicate.
5. Batched unread persistence.

### Phase 1: isolate processes and shrink shipped work

1. Utility-process host job service with bounded streaming and cancellation.
2. Sidebar virtualization and visible-only DnD.
3. Dependency-free runtime package and ASAR inspection gates.
4. Lazy emoji data plus browser-safe avatar contracts subpath.
5. Code/math/Mermaid-specific renderers and feature-owned CSS/fonts.
6. Coalesced transcript projections and event retention/wakeup.
7. Reliable main/preload dev watch and packaged profiling command.

### Phase 2: remove recurring polish regressions

1. Stable memo boundaries and resize behavior.
2. Hidden routine/inspector gating.
3. Lazy, virtualized emoji/mention surfaces.
4. Native image context menus and background notification tracker.
5. Cross-process metrics, tracing, and CI performance gates.

## Acceptance budgets

These should be automated on a fixed reference machine and tracked as distributions, not single best runs.

| Surface | Proposed gate |
|---|---|
| Bootstrap | under 250 KB and 150 ms warm at 1,000 bots; no completed history or original image bytes |
| Idle visible app | zero full snapshots while SSE is healthy; no recurring hidden-view polling |
| Event update | p95 under 150 ms from event to painted entity patch; no full application reload |
| Warm channel switch | p95 at or below one 60 Hz frame for short chats; no task over 50 ms |
| 10k history open | first 50–100 rows interactive under 150 ms; at most 200 message rows mounted |
| Transcript scroll | no long task over 50 ms; no sustained frame below 55 fps on reference hardware |
| 1,000-bot sidebar | at most 200 row DOM nodes/drag registrations; p95 selection under 50 ms |
| Search at 100k documents | p95 under 75 ms for empty, rare, and zero-result queries |
| Renderer memory | under 150 MB live JS heap at 1,000 bots; opening/closing long history returns near baseline after GC |
| Main process | no host operation produces a main-thread task over 50 ms; all jobs cancellable and bounded |
| Runtime dependencies | zero packaged Node dependencies while main/preload remain bundled; zero unexpected `node_modules` |
| Package | `app.asar` at most 25 MiB; header at most 256 KiB; at most 1,000 ASAR files; zero source maps/source/demo assets |
| Artifact | macOS arm64 ZIP at most 130 MiB; uncompressed app at most 320 MiB; fail unapproved regressions above 5% |
| Entry bundle | at most 800 KB raw / 200 KB gzip first gate; target 600 KB raw / 150 KB gzip, then restore the prior under-100 KB gzip stretch target |
| Initial CSS | at most 125 KB raw; no KaTeX or closed-feature CSS in the shell |
| Basic Markdown | at most 500 KB raw first-use closure |
| Advanced feature | each code/math/Mermaid static closure at most 1 MiB raw; no unrelated plug-in in its graph |
| Full renderer | at most 12 MiB first ratchet, target 10 MiB; at most 200 JS files initially, target 150 |
| Native modules | zero `.node` files while `npmRebuild:false` is set |
| Telemetry | ring always current; scenario export includes revision, counts, bytes, heap/RSS, and source commit |

## Existing optimizations to preserve

- Secure BrowserWindow defaults and validation in [`main/index.ts:133-206`](../apps/desktop/src/main/index.ts#L133).
- Narrow asynchronous preload API with listener cleanup in [`preload/index.ts:3`](../apps/desktop/src/preload/index.ts#L3).
- Structural entity/collection identity reuse in [`snapshot-reconcile.ts:29`](../apps/desktop/src/renderer/lib/snapshot-reconcile.ts#L29).
- Stable grouped arrays in [`snapshot-index.ts:109`](../apps/desktop/src/renderer/lib/snapshot-index.ts#L109).
- Relevant-run-aware `ChatPane` comparison and memoized message rows.
- Plain-text bypass before rich markdown rendering in [`message.tsx:52`](../apps/desktop/src/renderer/components/ai-elements/message.tsx#L52).
- Module-scoped lazy basic/rich renderers and text-preserving Suspense fallback; retain the mechanism while splitting the broad rich dependency graph.
- `content-visibility:auto` in [`styles.css:213`](../apps/desktop/src/renderer/styles.css#L213), retained as a complement to virtualization.
- Search abort/debounce/cache behavior; gate the eager empty-query prefetch on intent/idle and fix its SQL plan.
- Screen polling gated by active/enabled/visible state in [`bot-screen.tsx:58`](../apps/desktop/src/renderer/components/openbot/bot-screen.tsx#L58).
- GPU acceleration, single-window/single-instance behavior, denied renderer-created windows, and direct HTTP/SSE.

## Caveats

- UI timings are diagnostic scenario runs rather than statistically powered release benchmarks. The multi-second gaps are far beyond profiler noise, but final gates should collect repeated cold/warm distributions.
- DevTools Protocol and accessibility inspection add some overhead. The tests used the same instrumentation at every scale, and direct HTTP/database benchmarks corroborate the trend.
- Synthetic messages were mostly plain text with one representative rich response per chat. Real image-, code-, math-, or Mermaid-heavy histories will be more expensive.
- The graphical-computer service was stubbed. Screen/noVNC lifecycle was reviewed statically but not saturated with 1,000 live desktops.
- Package figures come from a fresh current-source macOS arm64 build. The dependency-free ASAR was a controlled proof repack, not a signed release; build and budget every supported platform/architecture in CI after dependency cleanup.
- Rich-resource timings used the production renderer over loopback so the isolated API could be proxied. Packaged `file://` reads the same raw assets from ASAR, but final release gates should repeat cold/warm traces on signed packages and slower Intel/Windows hardware.
- The test machine is fast. Lower-end Intel Macs and typical Windows laptops should be expected to fail earlier.

## Conclusion

The fastest path to a genuinely smooth desktop is not micro-optimizing React first. Bound the data, bound the DOM, and put long-running native work in the process Electron designed for it. Pagination/event patches, transcript virtualization, asset-backed images, indexed search, batched preferences, and a utility-process host bridge remove the dominant orders of magnitude. In parallel, the dependency work is unusually high leverage and low ambiguity: stop packaging 252 MB of unused modules, remove the 1.04 MB emoji/contracts startup paths, and split rich features by actual content. Those changes will materially improve startup, install/update size, feature readiness, and the reliability of every later performance measurement.
