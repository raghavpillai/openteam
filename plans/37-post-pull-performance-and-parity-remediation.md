# Post-pull performance, dependency, and parity remediation

Date: 2026-08-31

Upstream revision: `32eb185`

Status: complete. The implementation, frozen dependency install, dependency-audit scope, full
repository check, desktop build/package and release-integrity gates, runtime API/search/auth
measurements, Compose/migration validation, and isolated Electron replay all pass.

Evidence directory:
[openbot-post-pull-audit-2026-08-31](./evidence/openbot-post-pull-audit-2026-08-31/)

Earlier reports:
[desktop performance audit](./34-desktop-performance-audit.md),
[first remediation](./35-desktop-performance-remediation.md), and
[post-pull regression audit](./36-post-pull-desktop-regression-audit.md).

## Executive verdict

The post-pull tree has been semantically reconciled and the major measured regressions have been
removed without intentionally changing the desktop's visual language or deleting pulled features.
This was not a wholesale choice between upstream and the previous performance branch: upstream's
feature-complete auth, notifications, attachments, templates, groups, routines, plugins, and
agent-store behavior were ported into the bounded, virtualized, lazy architecture.

The most important results are:

- the upstream renderer entry fell from 2,336,443 B to 606,930 B, startup assets from 2,555,142 B
  to 867,703 B, and the runtime renderer from 18,960,469 B to 15,435,332 B;
- the fresh ASAR is 15,635,368 B / 425 files, versus upstream's 332,084,627 B / 19,900 files, and
  contains bundled output with no `node_modules`, source maps, WASM, native modules, stale preload,
  or unexpected package topology;
- the candidate-bounding stage reduced the common 36,207-document search case from p50/p95
  544.33/579.49 ms to a final combined 17.013/17.575 ms; the indexed exact-title lane also returns
  a target ranked 1,000th by recency, outside the bounded 512-row candidate set;
- required username/password-session validation adds 1.134 ms at p50 and 2.330 ms at p95 over
  explicit trusted no-auth mode on the same 100-byte runtime response;
- 10,000 streamed token fragments now coalesce to three delta events and three hot-path database
  statements in the controlled fixture, instead of 10,000 events and a modeled 40,000 statements;
- in the retained 100,000-event slow-consumer model, the old eager SSE loop made 200 source-window
  reads and queued all 100,000 events; the pull-driven stream makes no window read before demand
  and then reads one 64-event window;
- the 1,000-bot periodic agent-store poll fell from 7,001 filesystem operations and p50 61.604 ms
  to an unchanged-roster cache hit with no directory scan and p50 0.017 ms;
- the 1,000-agent Grok store now retains at most 32 agents / 64 SQLite objects / 192 additional file
  descriptors, instead of 1,000 / 2,000 / 6,000;
- a 5,000-envelope transcript publication fell from 1,808.7 ms and 5,000 root rewrites to 17.6 ms
  and one root rewrite, with byte-identical final state;
- repeated worst-position legacy attachment lookup across 1,000 agents fell from p50 26.535 ms and
  1,003 filesystem operations to p50 0.056 ms and two operations after a validated cache fill;
- the final Electron replay found a real history-pagination cascade, then confirmed that the
  per-channel 750 ms state-layer guard changes one manual load from two requests / 200 extra rows
  to one request / 100 extra rows while keeping only 38 timeline rows mounted;
- a 10,000-row XLSX preview moved off the renderer: the maximum frame gap fell from 307.2 ms to
  16.8 ms with exact HTML parity; and
- a real 10,000-node DOCX preview now mounts progressively with a 17.8 ms maximum frame gap, no
  observed long task, and exact final HTML and node count.

The one deliberate budget change is startup CSS: the old 125 KB ceiling described the smaller
pre-pull feature set. The feature-complete startup stylesheet is 160,706 B after safe Tailwind
source scoping, versus 178.8 KB in upstream. Experiments that forced it below 125 KB either removed
valid styles or attached an 82.5 KB shared stylesheet to first-open lazy surfaces and broke their
budgets. The new 165 KB ceiling is explicit, still tighter than upstream, and does not hide runtime
code or remove styles. Total renderer CSS is 186,894 B because the separate 26,188 B math
stylesheet is demand-loaded; it is not startup CSS and is not substituted into the startup gate.

## Audit method

The audit used four layers rather than relying on a single synthetic score:

1. Source and dependency review across Electron main/preload/renderer, server, worker, computer,
   messaging, client-core, migrations, Docker builds, and release configuration.
2. Controlled A/B fixtures for renderer payloads, search, snapshot queries, streaming,
   notification counts, periodic reconciliation, filesystem persistence, SQLite handle retention,
   transcript publication, document parsing, and large-file handling.
3. A 1,000-bot / 1,100-channel / 10,000-message PostgreSQL fixture with real HTTP requests and
   server timing.
4. An isolated Electron application (`com.github.Electron`) driven through Chromium accessibility
   and DevTools interfaces. The user's existing packaged OpenBot application was not used or
   modified.

The upstream revision was also installed, checked, built, and packaged in a detached worktree. It
passed its own tests but failed every established desktop performance/package gate. This gives the
comparison a real build baseline rather than an estimate from source changes.

On the reconciled tree, `bun install --frozen-lockfile` passes. The final `bun run check`, executed
after the history cascade fix, passes 11 typecheck tasks, 15 test tasks, and 12 build tasks. Dev,
performance, and deployment Compose configurations validate; the database contains all 32
migrations, and the migrator reports none pending.

## Authentication: the minimal model

`OPENBOT_API_TOKEN` and the parallel loopback/token credential path are gone. Product API access
now has two modes:

- `OPENBOT_AUTH_MODE=required` is the default. Desktop, mobile, and headless clients use the same
  Better Auth username/password session.
- `OPENBOT_AUTH_MODE=disabled` is an explicit trusted-network mode with no product API
  authentication. It is intended only for isolated/headless deployments where the surrounding
  network is the security boundary.

The public `GET /api/auth/config` endpoint returns the exact mode. Clients bypass the login UI only
for `{ "mode": "disabled" }`; unknown or missing values fail closed. Invalid environment values
fail server startup. Internal tool calls remain independently protected by
`OPENBOT_CONTROL_TOKEN` in both modes.

This removes the separate static `OPENBOT_API_TOKEN` credential and dual-provider fallback logic
from desktop/mobile/client-core. Required mode still stores the normal Better Auth session token.
Changing the configured server invalidates the previous mobile session, and disabled mode clears
auth headers rather than retaining a stale bearer token. Compose, CLI-generated installs, example
configuration, and documentation use the same contract.

The final request-overhead A/B alternated 100 measured requests per mode after ten warmups against
`GET /api/v0/client-runtime`. Both modes returned the same 100 bytes and SHA-256.

| Mode | p50 | p95 | Mean |
|---|---:|---:|---:|
| trusted no-auth | 0.580 ms | 0.952 ms | 0.627 ms |
| required username/password session | 1.714 ms | 3.282 ms | 1.941 ms |
| required-mode overhead | +1.134 ms | +2.330 ms | +1.314 ms |

This isolates Better Auth session validation from response construction without inventing a second
API credential
([auth A/B evidence](./evidence/openbot-post-pull-audit-2026-08-31/auth-overhead.json)).

## Desktop renderer and Electron

### Lazy loading and budgets

Every renderer dynamic source is discovered from the production Vite manifest and must be assigned
to a named budget. The audit follows static imports for each boundary and separately measures nested
dynamic registries and worker payloads, closing the earlier blind spot where a tiny file-viewer
shell could hide PDF.js, Mammoth, SheetJS, Shiki languages, or Mermaid diagrams.

The current architecture keeps these surfaces demand-loaded:

- Markdown richness by capability: basic, advanced, CJK, code/Shiki, math/KaTeX, and
  Mermaid/diagram engines;
- emoji data/grid, search, inspector, routines and advanced trigger fields;
- plugin shell/detail, template sharing, group/avatar forms, A2A and async-task surfaces;
- settings shell plus General, General Bot, Computer, Usage, Updates, and About sections; and
- file viewer shell, PDF engine/worker, DOCX worker/parser, and spreadsheet worker/parser.

The production gate also rejects unbudgeted dynamic sources, startup Shiki registries, source maps,
binary WASM, stale preload output, unexpected ASAR files, and packaged dependency trees.

### Rendering and interaction work

- The message timeline mounts at most 80 rows and preserves scroll anchoring, direct context
  navigation, and warm history for at most three channels.
- Older-history loading uses a per-channel 750 ms state-layer cascade guard. It survives timeline
  remounts and protects manual and automatic callers from turning one prepend-anchor correction
  into a second adjacent page request.
- The 1,100-row sidebar, pinned areas, compact mode, unread jumps, emoji grid, and 1,000-bot group
  member editor are virtualized. Unread navigation addresses virtual indices instead of querying
  rows that may not be mounted.
- Rich Markdown capabilities load only when content requires them. Images use native lazy loading;
  immutable content-addressed assets use direct public URLs so an eager authenticated Blob fetch
  does not defeat browser lazy loading.
- Settings were split without changing dialog dimensions, navigation, wording, or deep-link
  behavior. About shrank from a 45,542 B shared closure to 2,707 B; default settings dropped to
  37,670 B, and each optional section stays below 29 KB in the recorded build.
- Routine polling runs only while the surface is active, does not overlap, ignores stale responses,
  and preserves a single requested rerun. Valid dirty drafts flush on owner/routine change and
  unmount.
- Plugin bot access is server-paginated and searchable in 60-row Bot pages at 1,000 bots,
  preserving every toggle and the existing styling. Previous/Next and server-side Bot search make
  the entire roster reachable. The initial settings response carries a bot count instead of every
  bot/grant. A compact two-second connection-status request runs only while the dialog is open and
  a visible connection still needs authentication; refresh bursts coalesce to one active request
  plus one rerun.

  In the controlled 1,000-bot / five-connection projection, the legacy settings JSON was 180,106 B.
  The optimized closed response is 294 B (612.6x smaller), and an opened 60-bot page is 11,698 B
  (15.4x smaller). Initial bot rows fall from 1,000 to zero; an open page materializes 60. Estimated
  access-view DOM nodes fall from 6,000 to zero while closed and 360 for an open page. Empty status
  polls make no query, and a live poll is one bounded connection-only query; an explicit poll is
  capped at 50 connection IDs
  ([fixture evidence](./evidence/openbot-post-pull-audit-2026-08-31/plugin-settings-ab.json)).
- DOCX/XLSX parsing occurs in a module worker with transferable buffers. DOCX DOM creation is
  progressively budgeted per animation frame. ZIP central-directory declarations are checked for
  entry count/expanded bytes and the HTML handoff has a character cap, rejecting declared-oversize
  documents before parser work.
- Electron shell/file work is bounded and runs in a utility process where appropriate. Raw upload,
  download, and image-save paths stream instead of materializing large duplicate buffers.

### UI and feature parity

The remediation retained the existing UI styling and restored the pulled behavior for:

- templates, deep links, group profiles/avatars/descriptions, group member administration, pinning,
  drag-and-drop, unread controls, working avatars, and account/update/help/logout menus;
- image gallery navigation, downloads/context menu, generic attachments, PDF/DOCX/XLSX previews,
  routines, approvals, optimistic acknowledgements, and message reactions;
- plugin installation, OAuth/configuration/restart/removal, per-bot access, auto review, permission
  settings, update status, notifications, and application version; and
- bot- and group-owned routines, all trigger editors, execution history, conflict retries, template
  sharing, and requested routine opening.

Static parity tests lock down labels, geometry, event names, accessibility hooks, and feature
wiring. The CUA replay separately checks visible behavior and responsiveness.

## Search

Search remains PostgreSQL full-text search, not a renderer-side scan. Queries are length-, term-,
candidate-, and result-bounded; the direct `SearchDocument.searchVector @@ to_tsquery(...)`
predicate remains visible to PostgreSQL's GIN planner. The UI debounces, cancels superseded
requests, ignores closed-dialog responses, and loads a bounded message context for navigation.

The post-pull projection now includes canonical attachments plus legacy images, links, bot and
group routines, and correct visibility/navigation for channel-owned routines.

The candidate stage uses the newest 512 matches for predictable ranking cost plus a separate
indexed exact-title lane. The exact lane uses `md5(lower(title))` only as an index key and rechecks
full case-insensitive title equality against the normalized query, so hash collisions cannot become
false matches. A deliberately old exact-title sentinel outside the recent 512 rows is returned.
The exact lane itself measured about 0.116 ms total with a 0.023 ms index scan in the fixture.

Controlled 36,207-document candidate-bounding stage in the no-auth performance stack, before the
separate exact-title lane was added:

| Query | Before p50 / p95 | After p50 / p95 | Result parity |
|---|---:|---:|---|
| all: `performance` | 544.33 / 579.49 ms | 17.60 / 19.90 ms | top 24 exact |
| messages: `synthetic` | 539.64 / 573.91 ms | 9.01 / 11.40 ms | top 24 exact |

The final current-tree public-API run used 20 measured requests after three warmups in the no-auth
performance stack. These are end-to-end timings with the exact-title lane enabled:

| Category / query | Results | p50 | p95 |
|---|---:|---:|---:|
| all / `performance` | 24 | 17.013 ms | 17.575 ms |
| messages / `synthetic` | 24 | 9.010 ms | 9.607 ms |
| bots / `Audit Bot` | 24 | 13.516 ms | 14.701 ms |
| channels / `Audit Group` | 24 | 5.278 ms | 5.862 ms |
| files / `audit-report` | 24 | 12.540 ms | 13.766 ms |
| links / `openbot` | 24 | 8.262 ms | 9.101 ms |
| routines / `Audit Routine` | 24 | 5.283 ms | 5.818 ms |
| all / missing term | 0 | 1.884 ms | 2.648 ms |

`Audit Bot 0001` was independently proven to rank 1,000th by recency among 1,000 bot documents,
outside the newest-512 candidate window, and the public API returned exactly that one title. Files,
links, bots, channels, routines, missing terms, old exact titles, and direct message-context
navigation are therefore covered without returning to an unbounded rank operation
([search timing](./evidence/openbot-post-pull-audit-2026-08-31/search-final.json),
[exact-title proof](./evidence/openbot-post-pull-audit-2026-08-31/search-exact-title-final.json)).

## Server data paths

The desktop no longer downloads the 14.9 MB compatibility snapshot during normal startup. It uses
a message/activity-bounded but roster-proportional bootstrap, 100-message history pages,
channel-scoped activity, direct message context, and a 100-byte runtime endpoint. On the 1,000-bot
no-auth performance fixture, the final run used ten measured requests after two warmups:

| Endpoint | Payload | p50 | p95 |
|---|---:|---:|---:|
| client bootstrap | 1,555,506 B | 35.781 ms | 40.782 ms |
| client runtime | 100 B | 0.441 ms | 1.728 ms |
| history, 100 messages | 40,920 B | 1.571 ms | 2.843 ms |
| legacy compatibility snapshot | 14,879,358 B | 138.216 ms | 154.660 ms |

Bootstrap server-side p50/p95 were 29.78/35.21 ms; the compatibility snapshot's were
76.18/94.17 ms. Normal desktop startup still transfers about one-tenth the compatibility payload,
although its roster-proportional bootstrap remains a documented scale residual
([final API evidence](./evidence/openbot-post-pull-audit-2026-08-31/api-final.json)).

Thread ancestry uses one bounded recursive CTE instead of up to 100 sequential reads. In the deep
fixture it fell from p50 14.80 ms to 3.09 ms and from 100 traversal round trips to one. Latest
message lookup across 1,100 channels changed from a broad `DISTINCT ON` scan (p50 15.09 ms) to
indexed lateral lookup (p50 3.35 ms), with exact output parity.

Unread badge counts are aggregate SQL, not JavaScript scans of visible history. With 16,406
messages, the old path materialized 16,406 rows per count; the new path returns one row with the
same answer. p50/p95 were 8.80/10.46 ms before and 8.79/10.17 ms after—the latency is similar in
this local fixture, but allocation and transfer are bounded.

SSE is demand-driven with a one-chunk high-water mark and 64-event windows. Malformed nonempty
cursors return 400; future and expired cursors request a snapshot. LISTEN reconnects on error/end
and uses a short fallback while unhealthy. Disconnect cancellation reaches the pending wait. The
slow-consumer evidence counts calls to the window source; one real source call currently performs
an aggregate plus a bounded event read, so the first demanded window is two SQL statements rather
than one. The backpressure test uses the stream/source boundary rather than an instrumented network
socket.

## Worker, messaging, and computer service

### Token and event streaming

Adjacent token fragments coalesce for up to 32 ms or 4,096 characters. The computer response body
and product SSE both pull only when the downstream peer has capacity. The worker's delta projection
is one atomic append/upsert statement and no longer creates global product events for every token.

Controlled 10,000-fragment result:

| Metric | Before | After |
|---|---:|---:|
| delta events | 10,000 | 3 |
| modeled hot-path DB statements | 40,000 | 3 |
| pulls with a 100,000-event stalled computer peer | 100,001 | 1 |
| SSE window reads/events queued for a stalled peer | 200 / 100,000 | 0 / 0 before demand; 1 / 64 after |

### Periodic scale work

- Automation reconciliation uses startup/watcher fast paths plus an eight-bot round-robin safety
  page. At 1,000 bots it falls from 1,000 transactions every second to eight, completing a fallback
  sweep over 125 ticks.
- Agent-store discovery caches a roster/ETag and does an O(1) unchanged-root check instead of
  reading every agent directory every five seconds. Partial directories remain retryable and a
  periodic full parity scan remains.
- Platform prompts include at most 12 recent/related peers and eight groups, plus bounded discovery
  tools. The old all-peer catalog grew from 30,889 B at 1,000 bots to 318,889 B at 10,000; the
  bounded prompt remains 541 B in both fixtures.
- Memory/skill prompt fast paths reuse frozen request snapshots rather than issuing live reads;
  Todo mutations cap item count/identifier/content and use set-based merge.
- Push-notification drain runs on meaningful approval/completion events with a two-second safety
  timer rather than on every token. Outbox claim is a single `SKIP LOCKED` CTE.

### Filesystem and SQLite persistence

Box-store snapshots now reuse content hashes and safe SQLite snapshots by signature, accept dirty
root/path hints, and coalesce bursts into one active plus one pending rerun. At 2,391 files and 40
WAL databases, unchanged p50 fell from 192.04 to 118.69 ms while file reads/hashes fell from 2,391
to zero and SQLite VACUUMs from 40 to zero. One dirty agent takes p50 6.27 ms. Startup repair fell
from 67.2 to 32.3 ms after deduplicating roots and excluding build/cache trees.

GrokAgentStore uses lease-aware LRU/idle close and `closeAll` shutdown. The 32-agent cap reduces
retained SQLite/file descriptors by 31.25x; visiting many agents can pay variable close overhead,
so no startup-speed claim is made. Transcript backfill writes envelopes in one transaction and
publishes the root once. The 5,000-envelope A/B was 102.7x faster and wrote 2,500.9x fewer root
bytes, with identical final bytes and SHA-256.

## Attachments and assets

The filesystem `AssetStore` and canonical lowercase SHA-256 `AssetRef` remain the single durable
representation. Reads are public, immutable, range-capable URLs; uploads are raw binary. This
preserves image/video/audio/PDF/text/file behavior, search metadata, and browser-native lazy image
loading without the incompatible UUID/BYTEA store from the earlier performance branch.

Remote/file ingest, HTTP uploads, agent materialization, and desktop data-URL saves stream through
bounded temporary files while hashing/decoding. Dedupe remains atomic, size classes and limits are
unchanged, and large network/filesystem work occurs outside narrow database transactions. Asset
lookup checks the central store before the legacy per-agent directory fallback.

The legacy fallback now retains a validated 1,024-entry positive path LRU and coalesces concurrent
cold lookups for the same asset. In the worst-position 1,000-agent fixture, repeated lookup fell
from p50/p95 26.535/27.654 ms and 1,003 filesystem operations per request to 0.056/0.071 ms and two
operations after the initial fill—about 474x faster at p50. The first lookup remains a full
dynamic scan at 25.738 ms so newly added legacy files stay discoverable. Sixteen simultaneous cold
requests fell from 187.207 ms / 16,048 operations to 27.059 ms / 1,003 operations
([A/B evidence](./evidence/openbot-post-pull-audit-2026-08-31/runtime-assets-ab.json)).

The remaining cross-process runtime-image contract still requires inline base64 data URLs. A
sequential-read candidate was rejected: for six 19,922,944-byte images, it increased p50 latency
from 20.189 to 28.886 ms and measured peak heap from 93,007,426 B to 239,094,235 B, while peak RSS
remained about 240 MB. Replacing base64 materialization requires an `AssetRef`-aware computer
runtime contract rather than a local scheduling change.

For a 48 MiB input, raw-upload p50 fell from 34.98 to 28.27 ms, peak RSS fell 71.9%, and peak heap
fell 97.6%. Materialization p50 fell from 35.63 to 28.30 ms; more importantly, the advisory
transaction/lock interval fell from 35.54 to 0.52 ms while output and the one-read/one-write I/O
shape remained equal.

For a byte-exact 64 MiB desktop `data:image`, streaming decode changed peak RSS from +63.3 MiB to
+2.9 MiB, external memory from +64.0 MiB to +0.4 MiB, and the largest allocation from 64 MiB to
192 KiB. Worst timer gap improved from 13.4 to 2.2 ms. Total save time increased from 21.6 to
74.7 ms, an accepted throughput trade-off for bounded memory and responsiveness.

SheetJS 0.20.3 is vendored at
[`vendor/sheetjs/xlsx-0.20.3.tgz`](../vendor/sheetjs/xlsx-0.20.3.tgz) with SHA-256
`8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`; the lockfile and Docker
builds use the local artifact rather than an integrity-less CDN URL.

## Dependencies, packaging, and release security

- Desktop has zero production dependencies. Its 34 build inputs are `devDependencies`, and the
  application bundles only `dist`, `dist-electron`, and a minimal package manifest.
- `pg` is aligned at 8.23.0 across direct use and pg-boss, eliminating two bundled PostgreSQL
  clients. MCP SDK, SheetJS, Next/RSC/Vite, and `ws` advisories found during the audit were upgraded
  or compatibly resolved.
- A fresh high-severity audit reports only `image-size@1.2.1` through Metro in the Expo/React Native
  mobile build-tool chain. No high-severity advisory reaches the desktop, server, worker, or
  computer runtime dependency graph, and `image-size` is not present in the desktop ASAR.
- Docker filtered installs are frozen against the workspace lock and include the landing manifest,
  patches, and vendored SheetJS bytes. The computer image no longer runs fresh `bun add` commands
  during its runtime stage.
- Compose preserves username/password/no-auth configuration, UID 1000 ownership, persistent shared
  asset storage, workspace/home/box-store migrations, and server/worker path parity.
  Dev, performance, and deployment Compose configurations all validate, and the live audit database
  is at 32/32 migrations with no pending migration.
- Local packaging remains credential-free and ad hoc. A separate `package:mac-release` path
  requires a Developer ID identity and complete notarization credentials, enables hardened runtime
  and entitlements, and verifies authority/team/bundle ID/runtime/entitlements/Gatekeeper/stapling
  after packaging. Credentials were not available or used during this audit.
- `OPENBOT_RENDERER_URL` is accepted only in an unpackaged app, so a packaged preload bridge cannot
  be pointed at a configured remote page. Unpackaged development intentionally permits remote and
  Tailscale renderer origins for the existing remote-development workflow; that workflow exposes
  the development preload bridge and must remain trusted.

## Measured build comparison

These values are from the current production build and fresh ad-hoc package.

| Metric | Pre-pull remediation | Upstream `32eb185` | Current | Gate |
|---|---:|---:|---:|---:|
| entry JavaScript | 581,263 B | 2,336,443 B | 606,930 B | 800,000 B |
| startup assets | 773,876 B | 2,555,142 B | 867,703 B | 1,200,000 B |
| startup CSS | 123,762 B | 178,773 B | 160,706 B | 165,000 B |
| renderer runtime files | 13,103,419 B | 18,960,469 B | 15,435,332 B | 15,500,000 B |
| build-analysis manifest | included above | n/a | 182,906 B, excluded from runtime | 256,000 B |
| ASAR | 13,256,142 B | 332,084,627 B | 15,635,368 B | 25 MiB |
| ASAR files | 395 | 19,900 | 425 | 1,000 |
| packaged `node_modules` | 0 | 19,430 files | 0 | 0 |

The upstream app's 25.05x ASAR regression was therefore packaging topology, not unavoidable product
functionality. The fresh ASAR has a 112,984 B header. Its 424 generated build files match the build
output byte-for-byte, with no missing, changed, or unexpected file and no package violations. The
fresh DMG is 122,198,401 B and the ZIP is 122,307,367 B. The ZIP-embedded ASAR and packaged ASAR
share SHA-256 `29c3969ee1031145feed87eed23e65a249feebc12ec337c5eb6887ebdbceb27c`, and the
local ad-hoc bundle passes deep/strict code-signature and notification-identity verification with
identifier `dev.openbot.desktop`. The fresh package is newer than the measured build, and
`check-desktop-budgets --release` passes the complete artifact-integrity gate.
The complete measured build/package record is stored in
[`build-final.json`](./evidence/openbot-post-pull-audit-2026-08-31/build-final.json).

## Computer-use findings

The final audit sequence used an isolated Electron application against the 1,000-bot / 1,100-channel
fixture with `OPENBOT_AUTH_MODE=disabled`; the user's packaged OpenBot process was not used. The
replay retained the existing visual language and produced these bounded-state results:

- **Heavy initial surface:** 17 of 1,100 sidebar rows and 15 of 28 timeline rows were mounted. The
  focused 120-frame window peaked at 18.2 ms with no interval above 20 ms. The cumulative trace did
  retain 69, 69, and 100 ms startup/lazy-richness long-task entries, so the report does not relabel
  the entire launch trace as long-task-free
  ([evidence](./evidence/openbot-post-pull-audit-2026-08-31/cua-09-final-heavy.json)).
- **Deep search/navigation:** `Audit Bot 0001` was searched and opened while only 17 sidebar rows
  and 25 of 100 message rows were mounted. The focused frame window peaked at 24.3 ms, with one
  interval above 20 ms and none above 50 ms
  ([evidence](./evidence/openbot-post-pull-audit-2026-08-31/cua-10-final-deep-search.json)).
- **Group scale and routine parity:** the five-member group's editor materialized ten checkboxes,
  then server search found off-window `Audit Bot 0999` as one row. The group-owned routine retained
  its instruction, active switch, trigger compatibility message, and test-run control. Search and
  routine windows peaked at 17.7 ms; initial editor opening had one 33.9 ms frame and no long task.
  Membership was intentionally not mutated
  ([evidence](./evidence/openbot-post-pull-audit-2026-08-31/cua-13-final-group-scale.json)).
- **Plugin scale:** the closed settings view reported 1,000 bots with zero access rows; opening
  access materialized the expected `1–60 of 1000` page, and search found `Audit Bot 0999` as one
  row. Catalog, opening, and search maxima were 17.8, 34.0, and 34.0 ms respectively, with no
  recorded long task. The isolated audit installed the fixture plugin but did not alter a grant
  ([evidence](./evidence/openbot-post-pull-audit-2026-08-31/cua-14-final-plugin-scale.json)).
- **Trusted no-auth settings:** the account action displayed the explicit no-session explanation,
  sign-out was disabled, and General, Computer, Usage & Billing, Updates, execution policy,
  version, and update-check surfaces remained present. Opening peaked at 17.7 ms with no long task;
  preferences were not mutated
  ([evidence](./evidence/openbot-post-pull-audit-2026-08-31/cua-15-final-noauth-settings.json)).
- **Document previews:** the 12,000-row spreadsheet produced the bounded 200-row / 800-cell preview;
  the DOCX produced 5,001 paragraphs / 5,015 nodes. Both peaked at 17.8 ms with no interval above
  20 ms and no long task, while title, download, and close controls remained intact
  ([evidence](./evidence/openbot-post-pull-audit-2026-08-31/cua-16-final-document-previews.json)).
- **Compact sidebar:** only 22 accessible chat buttons were mounted for 1,100 channels, the selected
  row remained present, the `88 Compact` resize value was exposed, and expanded mode was
  restored. The frame maximum was 17.7 ms
  ([evidence](./evidence/openbot-post-pull-audit-2026-08-31/cua-17-final-compact-sidebar.json)).

The earlier pass had already found and fixed two defects: a non-RFC routine UUID matcher and a
153 ms one-shot DOCX `innerHTML` commit. The final group and document evidence above confirms both
fixes without removing their UI controls.

The final replay found one more real regression. One manual **Load older messages** action started
with 100 entries but reached 300 and issued two 100-row requests, the second observed at 427 ms,
because prepend anchor correction crossed the automatic loading threshold. Rendering stayed
bounded at 38 mounted rows and a 17.8 ms sampled maximum, but the network/data behavior was wrong
([first replay](./evidence/openbot-post-pull-audit-2026-08-31/cua-11-final-history-page.json)).

The fix records each channel's latest page-load start in the state layer and rejects another start
inside 750 ms, so it survives component remounts and covers every caller. The source test reproduces
the manual-load/anchor-correction cascade and verifies that a later intentional page remains
available. In the post-fix replay, one action changed 100 to 200 entries through exactly one
request, kept 38 rows mounted, and had a 17.7 ms maximum with no sampled interval above 20 ms. The
broader capture also contains one 63 ms Long Tasks API entry, which is reported separately from the
frame sample rather than hidden
([source test](../apps/desktop/test/virtual-window.test.ts),
[post-fix replay](./evidence/openbot-post-pull-audit-2026-08-31/cua-12-final-history-single-page.json)).

## Residual risks and accepted trade-offs

1. `backgroundThrottling: false` intentionally keeps renderer event/notification handling awake
   while minimized. That preserves current notification behavior but costs background CPU/power.
   A future main-process product-event subscriber could allow the renderer to throttle.
2. The legacy compatibility snapshot and a few non-desktop list routes remain unbounded. The
   desktop hot path uses message/activity-bounded bootstrap/history/state/context endpoints, but
   bootstrap still carries every visible bot and channel—1.55 MB at 1,000/1,100 in this
   fixture—and old clients can still request the fully unbounded compatibility representation.
   Very large rosters ultimately need roster pagination or a compact projection.
3. Asset reference pruning still performs periodic metadata work. It is off the startup path and
   infrequent; a normalized asset-reference table would make it fully indexed. Runtime handoff
   still reads and base64-encodes up to six images across the process boundary. The validated
   1,024-entry path LRU removes repeated legacy-directory scans for positive hits and coalesces
   concurrent cold hits, but a first central-store miss remains a dynamic directory walk and misses
   are not negatively cached. An `AssetRef`-aware runtime transport is the remaining structural fix.
4. The worker bounds returned HTML characters, but renderer sanitization still synchronously
   `DOMParser`-parses and walks the complete returned DOM before progressive insertion. It measured
   2.9 ms for 10,834 nodes in the controlled fixture, but there is no independent node-count cap.
5. The 160,706 B startup stylesheet is above the old pre-pull shell-only ceiling but below both the
   measured 178,773 B upstream sheet and the new 165 KB gate. The renderer's additional 26,188 B
   math stylesheet remains lazy. Splitting startup CSS further requires feature-owned chunks rather
   than a shared optional sheet.
6. Release signing/notarization was validated structurally and by tests, but cannot be executed
   without the owner's credentials.
7. Unpackaged remote/Tailscale renderer development exposes the preload bridge to that configured
   origin. It is useful for the existing workflow but should be used only with trusted renderer
   hosts; packaged builds ignore the override.
8. The scale API/search and Electron fixtures use explicit no-auth mode. The separate alternating
   required-mode A/B measures Better Auth session validation at +1.134 ms p50 / +2.330 ms p95 on
   the same response, but it is not a second full 1,000-bot CUA pass through the login UI.
9. The remaining high dependency advisories are confined to mobile build tooling. They should be
   upgraded when the Expo/Metro chain exposes a compatible fixed release.
10. The final group-member and plugin first-open/search samples each contained one roughly 34 ms
    frame interval. Neither crossed 50 ms or registered a long task, but each represents one missed
    60 Hz frame and remains a useful target for follow-up profiling.
11. The cumulative heavy-start trace retained 69, 69, and 100 ms long-task entries while loading
    the initial rich fixture. The later focused 120-frame window stayed at or below 18.2 ms, so this
    is isolated from steady-state scrolling but not erased from the evidence.

## Final gate

The final matrix passes on the current tree:

- `bun install --frozen-lockfile`; the only high advisory is `image-size@1.2.1` in mobile
  Metro build/development tooling;
- `bun run check`: 11 typecheck, 15 test, and 12 build tasks;
- final 1,000-bot no-auth API/search benchmarks, the out-of-window exact-title proof, and the
  alternating required-mode auth-overhead benchmark;
- production desktop entry/startup/CSS/renderer/lazy/nested-payload budgets;
- current ad-hoc DMG/ZIP packaging, the 424/424 ASAR byte comparison, package topology and artifact
  budgets, notification identity, strict local code-signature verification, and ZIP/ASAR digest
  equality;
- dev/performance/deployment Compose validation and the 32/32 no-pending migration check;
- the isolated Electron parity/scale replay, including the post-fix single-page history check; and
- whole-tree `git diff --check`, no unmerged index entries, successful parsing of every evidence
  JSON file, and the release-integrity gate.

The audit left the user's pre-existing packaged OpenBot process (PID 78334) running and interacted
only with the isolated Electron target. This report is the release sign-off for the audited tree.
