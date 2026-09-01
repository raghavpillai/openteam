# Post-pull desktop regression audit

Date: 2026-08-31

Upstream revision: `32eb185` (`origin/main`)

Pre-pull performance work: `stash@{2026-08-31 16:26:22 -0400}` (`codex-pre-pull-settings-noop-audit-2026-08-31`)

Comparison baseline: [35-desktop-performance-remediation.md](./35-desktop-performance-remediation.md)

Authentication follow-up: the legacy separate API-token/loopback path identified below has now
been removed from the working tree. Product API access defaults to owner username/password sessions
with `OPENBOT_AUTH_MODE=required`; `OPENBOT_AUTH_MODE=disabled` is an explicit, trusted-network-only
no-auth mode. Invalid values fail startup, and internal tool calls remain independently protected by
`OPENBOT_CONTROL_TOKEN`.

Latest verification after that follow-up: server, CLI, client-core, and mobile typechecks pass, as
do all 71 server tests and the focused authentication/configuration suites. The repository-wide
typecheck now stops at 55 pre-existing desktop integration errors across six renderer files; none is
in the authentication path. The larger error table below records the earlier audit snapshot and is
retained to explain the original post-pull state.

## Executive verdict

**Do not ship the current working tree or upstream `32eb185` by itself.**

The two available states fail for opposite reasons:

- The isolated upstream revision is functionally coherent: dependency installation, all typechecks, all tests, all builds, local macOS packaging, notification identity verification, and strict code-signature verification pass. However, it materially restores the desktop performance and packaging problems removed by the prior remediation.
- The current post-pull working tree retains much of the performance remediation, but every conflicted file was resolved wholesale to the pre-pull/stashed version. It is not a semantic merge. The result has 221 TypeScript errors across seven packages and fails five package test tasks, including 33 desktop behavior/parity tests.

The correct release candidate must semantically integrate the upstream functionality into the remediated architecture. Choosing either side of each conflict is not safe.

## What happened during the pull

The branch fast-forwarded from `b15510a` to `32eb185`. Reapplying the pre-pull work initially produced 28 conflicted files across Electron main/preload, renderer, server, worker, client-core, messaging, and `bun.lock`.

The conflict markers were subsequently removed outside this audit. Hash comparison shows that **all 28 formerly conflicted files now match the stashed version byte-for-byte**, rather than containing a semantic combination. Those files differ from upstream by 8,495 added and 6,133 deleted lines (14,628 changed lines in total).

The named stash still exists, so the pre-pull work remains recoverable.

## Validation results

### Current combined working tree

`bun run typecheck` fails. A continued Turbo run found:

| Package | TypeScript errors |
|---|---:|
| Desktop | 59 |
| Server | 58 |
| Worker | 51 |
| Messaging | 33 |
| Mobile | 14 |
| Computer | 3 |
| Client core | 3 |
| **Total** | **221** |

The continued test run also fails five package tasks:

| Package | Passed | Failed | Errors | Skipped |
|---|---:|---:|---:|---:|
| Desktop | 161 | 33 | 1 | 0 |
| Computer | 98 | 2 | 0 | 1 |
| Messaging | 43 | 4 | 3 | 0 |
| Server | 56 | 6 | 6 | 0 |
| Worker | 16 | 5 | 4 | 0 |

Representative broken contracts include:

- the old renderer and client still importing the removed `InlineImageInput` contract;
- the new file viewer compiling without `pdfjs-dist`, `mammoth`, or `xlsx`, and without the required asset/file preload APIs;
- plugin settings calling API methods removed by the wholesale old `openbot-api.ts` resolution;
- settings calling permission, updater, and version APIs removed from the old preload/environment contract;
- App omitting the new template-sharing callback and passing an obsolete Settings prop;
- server and worker code losing new asset, timeline-event, event-origin, group-profile, and plugin-skill interfaces;
- messaging losing `AssetStore`, filesystem mutation, timeline, background-wake, and plugin-cache exports; and
- mobile calling client methods removed by the old client-core resolution.

There are also direct user-visible breakages even before compilation is repaired:

- Markdown `grokbot:` links still dispatch the upstream deep-link event, but the current wholesale-old `App.tsx` has no listener, so Settings, Plugin, and Template links do nothing.
- Read state is only cleared locally; the pulled durable `markChannelRead` call is absent, so unread state can return after restart and notifications can repeat.
- Sidebar preference hydration uses the legacy nested shape instead of the pulled canonical root settings, risking stale settings writes.
- The current image component retains lazy decoding but lost the pulled gallery navigation, download/context menu, count, and dialog description.

No current-source Electron/CUA run was attempted. A stale artifact would not represent the working tree, and the current source cannot produce a trustworthy app.

### Isolated upstream `32eb185`

The upstream revision was tested in a detached temporary worktree and removed afterward. The shared working tree was not changed.

- `bun install --frozen-lockfile`: pass; 2,936 packages installed.
- `bun run check`: pass; 11/11 typechecks, 15/15 test/build prerequisite tasks, and 11/11 builds.
- `bun --filter @openbot/desktop package:mac-local`: pass.
- Local macOS notification identity verification: pass.
- `codesign --verify --deep --strict --verbose=2`: pass with the expected ad-hoc local signature.

Release notarization, hardened-runtime distribution signing, ZIP creation, and DMG creation were not exercised by the local-package command.

## Measured performance regression in upstream

| Metric | Remediated baseline | Upstream | Gate | Result |
|---|---:|---:|---:|---|
| Entry JavaScript | 581,263 B | 2,336,443 B | 800,000 B | **Fail; 4.02x baseline** |
| Startup assets | 773,876 B | 2,555,142 B | 1,200,000 B | **Fail; 3.30x baseline** |
| Startup CSS | 123,762 B | 178,773 B | 125,000 B | **Fail; +44.5%** |
| Complete renderer | 13,103,419 B | 18,960,469 B | 15,500,000 B | **Fail; +44.7%** |
| `app.asar` | 13,256,142 B | 332,084,627 B | 25 MiB | **Fail; 25.05x baseline** |
| ASAR header | 104,900 B | 5,179,768 B | 256 KiB | **Fail** |
| ASAR entries | 395 | 19,900 | 1,000 | **Fail** |
| Packaged `node_modules` | 0 | 19,430 files / 334,179,671 logical B | 0 | **Fail** |
| Packaged source maps | 0 | 4,104 | 0 | **Fail** |
| Packaged binary WASM | 0 | 3 | 0 | **Fail** |
| Packaged native modules | 0 | 1 | 0 | **Fail** |

The upstream local app occupies 640,784 KiB on disk. Its renderer source-map and renderer binary-WASM checks pass; the violations above are inside the copied production dependency tree.

Largest new/relevant renderer outputs include:

| Asset | Raw | Gzip |
|---|---:|---:|
| Main entry | 2,336,443 B | 557,899 B |
| PDF worker | 1,046,214 B | 289,083 B |
| Advanced rich renderer | 585,343 B | 181,592 B |
| XLSX reader | 423,995 B | 139,925 B |

Largest packaged dependency contributors include Mermaid (83.3 MB), Emojibase data (50.0 MB), PDF.js (36.3 MB), the optional native canvas package (26.3 MB), Effect (22.9 MB), and Lucide React (19.9 MB).

## Why upstream regresses

### Renderer topology

Upstream restores eager imports for Search, Settings/About, Plugins, Inspector/Routines, A2A, async tasks, dialogs, and other optional surfaces. It has only three `React.lazy` boundaries and six dynamic-import sites; the remediation had 20 verified and individually budgeted dynamic sources.

The new file-attachment component is imported by the eager chat path. DOCX and XLSX parsers are dynamically imported on use, but its 1.05 MB PDF worker URL is still part of the renderer graph and artifact. The richer upstream routine, plugin, template, group-profile, and settings surfaces also need to remain behind the existing lazy boundaries.

### Scale-sensitive UI and data paths

Upstream does not contain the remediated timeline or sidebar virtualization. Its snapshot service again performs unbounded `findMany` reads for channel messages, messages, runs, run items, and approvals. Its renderer again uses a 3-second watchdog and can rebuild/refetch the full snapshot after 10 seconds, SSE activity, focus, visibility changes, and every mutation.

Upstream also lacks the direct bounded message-context endpoint used for deep search navigation. The pre-pull full-text search correction is not in upstream: the upstream materialized search-input CTE prevents the intended direct GIN predicate, while the current performance patch keeps the predicate on `SearchDocument`.

These are the same structural failure modes that produced the prior 10,020-message and 1,000-bot bottlenecks. No claim is made that the exact old CUA timings repeat; the current combined app must first be made buildable and then remeasured.

Several new features also need performance-specific redesign during integration:

- The upstream PDF preview creates and renders a canvas for every page. Large PDFs can therefore allocate hundreds of canvases and substantial GPU memory; the page list needs virtualization, cancellation, and a bounded render queue.
- DOCX and XLSX preview code fetches the complete file into one `ArrayBuffer` before limiting presentation work. Heavy parsing should be cancellable and moved off the renderer thread where practical.
- The upstream composer accepts files up to 200 MB and converts them to base64 data URLs before upload. That creates simultaneous `File`, `ArrayBuffer`, base64-string, and JSON/request representations. Uploads must remain binary/streamed or multipart.
- Internal Markdown message jumps use DOM queries. Virtualized offscreen messages do not exist in the DOM, so navigation must resolve the message index/context and call `scrollToIndex`.
- The remediated routine editor currently clears a pending 550 ms save timer on unmount without flushing. The feature-complete merge must flush a valid dirty draft so closing or switching the inspector cannot lose edits.
- The pulled unread-jump implementation searches mounted DOM rows and is incompatible with a virtual sidebar. It must derive the target index from the flattened sidebar model and drive the virtualizer directly.

### Package topology

Upstream declares 22 production dependencies and 10 development dependencies. Electron Builder therefore copies the complete production dependency tree even though renderer/main/preload code is already bundled. The remediation used zero production dependencies and treated all 30 build inputs as build-time dependencies.

Upstream also lacks the remediation's clean build/package scripts, complete renderer boundary budget, ASAR integrity checks, and release performance gate. Consequently, `bun run check` passes while every measured desktop renderer budget fails.

## Functionality that must not be lost

The semantic merge must retain the pulled work for:

- owner authentication and authenticated resources;
- native notifications, deep links, updater/status APIs, permissions, and macOS notification identity checks;
- file/image attachments, document/media previews, downloads, and asset authorization;
- group profiles, avatars, descriptions, member administration, unread state, and template sharing/import;
- Grok-compatible routine triggers, routine lifecycle UI, plugin/MCP/OAuth management, and auto-review variants;
- timeline events, background wake/revival, push notifications, reaction wakes, and event-origin runs;
- filesystem agent data, asset store, plugin skill cache, root settings, and bot-file mutation; and
- the new mobile and CLI contracts introduced by upstream.

The current working tree demonstrably drops parts of all of these surfaces.

## Additional server, security, and data findings

### P0: legacy API authentication could fail open upstream (remediated)

In upstream `apps/server/src/api-auth.ts`, `authorizedApi()` returns `true` when `OPENBOT_API_TOKEN` is absent. `main.ts` then treats `apiAuthorized` as sufficient even when there is no Better Auth session. A remotely reachable server without that environment variable can therefore accept protected API requests without either credential.

The request order also does unnecessary work: Better Auth session lookup runs before the synchronous API-token check, so every valid token request can pay auth/database overhead. The shared client eagerly resolves both `getAuthToken()` and the fallback `accessToken()` even when the first value succeeds.

The follow-up remediation removes that parallel credential model instead of adding more branching:

- username/password sessions are the secure default for desktop, mobile, and headless clients;
- a public `/api/auth/config` discovery response lets UI clients bypass their login gate only for
  the exact `disabled` mode;
- no-auth operation must be opted into explicitly and is documented as unsafe on internet-facing or
  untrusted networks;
- invalid configuration fails startup rather than silently weakening authentication; and
- `/api/internal/tools/call` continues to require the separate internal control token in both modes.

Focused parser, server, mobile discovery, and generated-install configuration tests cover the new
contract. This closes the legacy fail-open finding; full release validation remains blocked by the
unrelated post-pull integration failures described above.

### P0/P1: two incompatible asset systems

Upstream supplies a general content-addressed filesystem `AssetStore` with SHA-256 IDs, image/video/audio/PDF/text/file support, public immutable reads, and byte-range streaming. The remediation stash added a separate image-only UUID/BYTEA database service. Combining both would duplicate bytes and leave incompatible IDs, URLs, authorization rules, cleanup behavior, and search metadata.

Use the upstream `AssetStore`/`AssetRef` model as the single durable representation. Add raw-binary or multipart upload into that store while keeping a compatibility input for older clients. Do not apply the BYTEA `Asset` model/migration.

The upstream store still needs targeted performance work:

- prune references with indexed/batched SQL instead of loading every message's metadata;
- avoid rehashing an entire asset on the first read of every process lifetime;
- bound the verified-asset cache with LRU/TTL;
- stream remote ingest to a temporary file while hashing instead of buffering the whole object; and
- stage network/filesystem materialization outside Prisma transactions and advisory locks.

### P1: search projection is incomplete for pulled data

The optimized GIN query should remain, but the existing search projection reads legacy `metadata.images` rather than canonical `metadata.attachments`. New files can therefore be missing from Files search. Group routines can be channel-owned with a nullable bot owner, while current visibility/navigation assumes every routine is bot-owned.

Add a new migration that indexes canonical attachments plus legacy images, stores filename/kind/asset route, reindexes existing messages, and records group-routine `channelId`. Authorize bot routines through visible bot ownership and group routines through visible channels.

### P1: bounded snapshot must incorporate pulled fields

The remediated bootstrap/history/context architecture should remain, but its current channel projection omits pulled read state, unread counts, group description, and avatar presence. Broad snapshot casts currently hide the mismatch.

Rebuild the bounded projection from upstream channel fields, compute unread counts with grouped/indexed SQL, and remove broad casts. Mobile and several list routes also need to stop calling the legacy unbounded full snapshot. Replace the message-thread ancestor loop (up to 100 sequential queries) with a recursive CTE or batched traversal.

### P1: event and worker robustness

Retain PostgreSQL LISTEN-based wakeups and the optimized SQL delta projection, but address:

- malformed nonempty event cursors currently becoming `0` and replaying up to 100,000 events;
- future cursors waiting indefinitely;
- LISTEN connections handling `error` but not a clean `end`/reconnect;
- a 15-second fallback delay when the listener or trigger is unhealthy; and
- missing slow-consumer/backpressure handling for SSE.

Use upstream worker/messaging behavior as the base so push delivery, background revival, event origins, agent-store adoption, shared workspace behavior, plugin restrictions, routine concurrency, and group completion remain. Transplant only the SQL delta append, debounced projection, and a bounded transcript-fingerprint cache.

### P1: migration and lockfile ordering

The combined directory has duplicate timestamp prefixes for event/search vs Grok filesystem work, binary assets vs plugin runtime, and Better Auth vs timeline events. Full directory names are unique, but already-applied history and ordering must be inspected before any rename. Give unapplied event/search work a new later timestamp, omit the incompatible binary-assets migration, and never rename an applied migration.

Start dependency resolution from upstream `bun.lock`, add the direct `pg`/`@types/pg` dependencies required by the LISTEN implementation, then regenerate only after manifests are semantically merged.

## Performance invariants that must not be lost

The semantic merge must preserve:

1. bounded bootstrap plus cursor-paginated channel history;
2. virtualized timelines, sidebars, member lists, and emoji results;
3. bounded direct message-context navigation for search/deep links;
4. the GIN-usable full-text predicate, bounded result/query/term limits, debounce, cancellation, and closed-dialog guard;
5. lazy optional App surfaces and feature-specific rich-rendering/parser boundaries;
6. the lightweight runtime check and event-driven refresh path instead of recurring full snapshots;
7. the host utility process, job queue, backpressure, cancellation, and bounded read/shell behavior;
8. binary/streamed attachment references rather than base64 payloads in snapshots and events;
9. zero packaged `node_modules`, source maps, native modules, and binary WASM unless explicitly reviewed; and
10. clean build/release directories plus renderer, ASAR, ZIP, and DMG gates.

## Safe integration plan

1. **Contracts and storage first.** Restore the upstream contracts, filesystem `AssetStore`, agent-data, timeline, plugin, group, root-settings, and event-origin behavior. Add compatible streaming upload; do not keep the parallel BYTEA attachment system.
2. **Server projection second.** Extend the bounded bootstrap/history/context projections with upstream channel descriptions, avatars, unread state, attachments, notification data, timeline events, and new runtime fields. Do not restore full snapshots.
3. **Client and renderer third.** Port the new callbacks and UI states into the virtualized/lazy shells. Keep PDF, DOCX, XLSX, template, plugin, group-editor, and full routine surfaces behind measured boundaries.
4. **Electron integration fourth.** Merge notifications, permissions, updater, deep links, file dialogs, and download APIs into the remediated main/preload/utility-process design.
5. **Dependency topology fifth.** Regenerate `bun.lock` only after manifests are semantically merged. Keep bundled runtime inputs in `devDependencies`; explicitly guard the optional PDF.js native canvas dependency and PDF worker asset.
6. **Automated parity gate.** Require all newly pulled tests plus all remediation tests, `bun run check`, the desktop budget command, local packaging, notification verification, ASAR inspection, and `git diff --check`.
7. **CUA last.** Recreate the isolated 1,100-bot/10,000-message fixtures and add auth, group profile/avatar, template import/share, files (image/PDF/DOCX/XLSX), plugin OAuth/MCP, routine triggers, permission settings, notifications/deep links, reaction wakes, and mobile/shared-client smoke cases. Compare UI style and behavior as well as frame gaps, DOM, heap, requests, and artifact size.

## Release recommendation

The current state is a **hard release blocker**, not a marginal performance regression. No trustworthy combined performance or usability claim can be made until the semantic merge passes automated checks. The previous performance evidence remains valid only for the pre-pull remediation build, and the upstream functional evidence remains valid only for isolated `32eb185`.

This audit did not change product source or resolve user-owned conflicts.
