# iOS performance, dependency, and parity audit

Original audit date: 2026-08-31; native Simulator follow-up: 2026-09-01

Original upstream revision under audit: `32eb185`

Status: implementation and non-native validation are complete. A 2026-09-01 follow-up has now
completed signed Release simulator build/install, native Computer Use replay, scale testing, and
simulator-host CPU/network/footprint measurement. See
[native iOS simulator validation](./39-ios-native-simulator-validation.md). Physical-device
Instruments and production-archive inspection remain required for App Store release signoff.

Evidence directory:
[openbot-ios-audit-2026-08-31](./evidence/openbot-ios-audit-2026-08-31/)

Related records:
[iOS product/parity specification](./34-ios-mobile-parity.md),
[post-pull server/search evidence](./evidence/openbot-post-pull-audit-2026-08-31/), and
[earlier native captures](../apps/mobile/artifacts/README.md).

## Executive verdict

The iPhone client had real scale and lifecycle problems. The largest were not cosmetic: broad
workspace imports nearly doubled the release JavaScript payload, a foreground 2-second full
bootstrap loop repeatedly downloaded the entire roster, selected files were copied into Base64 in
JavaScript, cached and hydrated histories could grow without a retention policy, several 1,000-Bot
surfaces eagerly created every row, the search cache was unbounded, and the shared-computer screen
could continue polling or retain takeover state after it was covered or backgrounded.

The remediation addresses each of those paths without intentionally redesigning the in-app visual
language:

- the frozen 2026-08-31 tree reduced the exact Hermes bytecode from 8,127,954 B / 2,495 Metro modules
  to 4,296,128 B / 1,819 modules, a 47.14% byte reduction and 676 fewer modules. Its gzip size is
  1,773,235 B, and all eight routes remain present; this is preserved as the original audit A/B,
  while the superseding current-tree bundle and artifact are recorded in the 2026-09-01 native
  validation;
- the steady-state full-sync schedule changes from one bootstrap every 2 seconds to event-triggered
  reconciliation with a 60-second healthy safety fallback. Using the recorded 1,000-Bot payload,
  this changes modeled bootstrap traffic from 2,798,922,600 B (2.607 GiB) per hour to
  93,297,420 B (88.98 MiB) after initial load; an open 100-message history changes total modeled
  traffic from 2,872,576,800 B (2.675 GiB) to 95,752,560 B (91.32 MiB);
- 100 same-burst product events coalesce to one reconciliation in the Bun test, rather than 100
  requests, and the committed cursor is not advanced until the authoritative bootstrap succeeds;
- live state retains three inactive histories at 120 messages each and only the latest message for
  other channels; the disk cache retains at most 200 messages for the active/recent histories and
  coalesces 100 rapid saves to one latest-value write;
- attachments now use the native file-backed uploader with no picker Base64, preserve the same
  authentication/filename/MIME/alt contract, and run at no more than two uploads concurrently;
- the home pinned lookup fell from 1,211,100 modeled comparisons to 4,400 indexed build/lookups at
  the 1,100-row fixture and from 1.196 ms to 0.070 ms median in the local Bun microbenchmark;
- New, Details, Settings, Home, chat, and Search use virtual lists or bounded selectors. All 1,000
  Bots remain reachable, while search controls appear only above 12 Bots so the compact layout is
  unchanged for ordinary rosters;
- Search now has a 100 ms debounce, cancellation plus stale-result rejection, and a 64-entry
  cursor-aware LRU. It continues to use the measured bounded PostgreSQL search path rather than a
  device-side scan;
- the computer status poll is focus- and foreground-bound, single-flight, and scheduled 2.5 seconds
  after the previous request settles. Takeover writes are serialized and a forced `false` follows
  blur/background even if an earlier enable finishes late;
- required username/password validation adds 1.387250 ms at p50 and 2.919584 ms at p95 versus
  explicit trusted disabled mode on the same exact 100 B loopback response; and
- required-mode push devices are bound to a live username/password session, disabled mode remains
  an explicit trusted-origin choice, and push dispatch/sign-out share one bounded PostgreSQL lock so
  a session cannot finish signing out while a newly unauthorized push is being handed to Expo.

At the close of the 2026-08-31 audit, this was strong source, Metro, API-fixture, and Bun-test
evidence but **not** a current native result: that environment had only Command Line Tools, no
Xcode application, and no `simctl`, and iPhone Mirroring reported `Unable to Connect to iPhone`.
The screenshots under
[`apps/mobile/artifacts`](../apps/mobile/artifacts/README.md) and
[`plans/evidence/openbot-ios`](./evidence/openbot-ios/) are earlier live-build baselines only; they
did not validate that changed tree
([native CUA availability](./evidence/openbot-ios-audit-2026-08-31/native-cua-availability.json)).
The user-added Simulator removed that tooling blocker on 2026-09-01: current-tree Release
build/install, native CUA, scale replay, and simulator-host CPU/network/footprint measurement are
now complete in [the native validation record](./39-ios-native-simulator-validation.md). A
production archive and physical-device Instruments/capability/accessibility pass remain hard gates.

## Evidence boundary and method

Four evidence classes are kept separate throughout this report:

1. **Release-export measurement.** Expo/Metro generated iOS Hermes bytecode in disposable system
   temporary directories. The exact release export had no source map; a separate mapped export was
   used only for route and package attribution. Adding an external source map changes HBC size, so
   the two HBC files are not compared to each other.
2. **Controlled local measurement.** Bun tests and microbenchmarks exercised pure selectors,
   coalescers, cursor transitions, cache journals, upload contracts, virtual-list configuration,
   search invalidation, and takeover scheduling. These do not measure Hermes, UIKit layout, or an
   iPhone GPU.
3. **Controlled API and source/schedule model.** A final auth-disabled Docker fixture measured 1,000
   Bots, 1,100 channels, 32,006 messages, 1,100 routines, and 36,207 search documents. The hourly
   model combines its exact response bytes with the pre/post schedules and excludes HTTP headers,
   SSE keepalive bytes, TLS/radio effects, event-triggered reconciliations, and one-time
   settings/hidden-Bot requests.
4. **Native observation.** None was possible in the 2026-08-31 environment. The 2026-09-01 follow-up
   separately records current-tree Simulator CUA and simulator-host measurements. Those establish
   Simulator behavior, not physical-device frame pacing, energy, thermals, memory pressure, exact
   reference-app visual parity, or App Store readiness.

The code pass covered Expo configuration, the checked-in Xcode project, navigation, auth, global
state, event transport, cache/drafts, attachments, home/chat/search/details/settings/computer
routes, package imports, production source maps, auth-mode transitions, session-bound push,
server/worker sign-out ordering, database migration, Docker workspace manifests, native
autolinking, release version/signing metadata, tests, and prior evidence. It also examined
dependencies retained in the production iOS source map rather than treating `package.json`
membership as proof of runtime cost.

## Findings and remediation map

| Area | Audited problem | Remediation | Evidence class |
|---|---|---|---|
| bundle | Root `@openbot/contracts` imports retained `effect` and `fast-check`; a direct React Navigation import retained an avoidable navigation closure | Narrow contracts subpaths, consume theme exports through Expo Router, remove direct dependency, enforce package/route budgets | isolated Metro A/B |
| live data | Full bootstrap and active history every 2 seconds | authenticated SSE invalidation, 50 ms trailing coalescing, 60 s healthy / 15 s degraded fallback, 30 s 100-byte runtime check, background abort | source + Bun tests + API payload model |
| cursor/recovery | Failed reconciliation could skip an observed event; a restored server could be behind a cached cursor; no-cache initial failure could stall | separate observed/committed cursor, rollback on `snapshot.required`, bounded reconnect retry, initial-sync retry | source + tests |
| state retention | Histories and persisted snapshots could grow with channel usage | three-entry inactive LRU, 120-message inactive cap, 200-message persisted cap, one latest message elsewhere | source + 30,000-message fixture test |
| cache I/O | Every accepted snapshot could write a full JSON file; overlapping saves could race | 250 ms latest-wins debounce, serialized drain, generation-tagged A/B slots, `.next` replacement, background flush | source + mocked filesystem test |
| upload | Picker Base64 and legacy file reads duplicated large files in JS and JSON | `base64: false`, native `File.upload`, raw bytes, max two concurrent uploads | source + transport contract test |
| 1,000-Bot UI | New/Details/Settings eagerly mapped the roster; pinned lookup was quadratic | FlatList/SectionList, conditional roster search, indexed pins, memoized rows and formatter | source tests + Bun microbenchmark |
| chat lifecycle | Covered chat routes could continue suppressing notifications, hydrate history, and mark content read | focus-scoped active channel/hydration/release and highest-visible-sequence read acknowledgement | source + pure tests |
| search | Per-screen cache grew without a bound and abort alone could accept a late response | 64-entry LRU keyed by cursor/category/query plus generation gate | source + tests |
| computer | interval overlap, covered/background polling, stale results, and late takeover enable | serial poller, focus/AppState gates, revision guards, serialized takeover and forced release | source + tests |
| auth/push | Origin races and best-effort unregister could leave a stale required-mode push registration deliverable after session retirement | origin/generation guards, session-bound devices, mode-aware eligibility, shared dispatch/sign-out advisory lock, fail-closed migration | source + server/worker/mobile contract tests |
| Docker | Selective manifest copies no longer represented the expanded workspace during frozen production installs | copy every workspace manifest in both build stages; rehearse fresh and legacy migration paths | frozen Docker builds + tmpfs migration rehearsal |
| native shell | Placeholder launch resources and drift-prone checked-in config | versioned opaque icon, scaled transparent splash, config/autolink/version gate | file inspection + tests; current Simulator launch in plan 39 |

## Bundle, dependencies, and loading

### Stable isolated A/B

The following arms were exported from clean temporary directories and changed only the named import
surfaces. Route topology and the 23 Metro runtime assets were identical across arms; these arms did
not modify UI markup, styles, or native assets.

| Arm | Exact HBC | Metro modules | Change from baseline |
|---|---:|---:|---:|
| pre-rewrite baseline | 8,127,954 B | 2,495 | — |
| contracts subpaths only | 4,302,282 B | 1,891 | -3,825,672 B (-47.07%), -604 modules |
| Expo Router theme import only | 7,930,015 B | 2,380 | -197,939 B (-2.44%), -115 modules |
| both interventions, isolated | 4,106,203 B | 1,776 | -4,021,751 B (-49.48%), -719 modules |

The baseline mapped export attributed 358 modules / 3,475,244 source characters to `effect`, 223
modules / 382,542 characters to `fast-check`, and 113 modules across React Navigation's native,
core, and router packages to the direct theme import. The combined isolated arm retained none of
the forbidden runtime packages and still contained all eight routes
([bundle A/B](./evidence/openbot-ios-audit-2026-08-31/bundle-baseline-and-ab.json)).

The import change is deliberately narrow:

- Bot avatar constants come from `@openbot/contracts/bot-avatar`;
- notification copy comes from `@openbot/contracts/notification-content`; and
- `DarkTheme`, `DefaultTheme`, and `ThemeProvider` come from `expo-router`, which is already the
  application's navigation owner.

`@react-navigation/native` was removed as a direct mobile dependency. Reanimated, Worklets,
Gesture Handler, Screens, SVG, Notifications, and Expo Router remain because they are used directly
or remain in Expo Router's supported production navigation/transition graph. No removal was
credited without a production source-map result.

### Frozen 2026-08-31 combined tree and budgets

After the sync, upload, chat, auth, push, and list changes were frozen for the original audit, its
exact and mapped exports both passed:

| Final export | HBC | Metro modules | Mapped sources | Assets | Source maps |
|---|---:|---:|---:|---:|---:|
| exact release | 4,296,128 B (1,773,235 B gzip) | 1,819 | n/a | 23 / 23,136 B | 0 |
| attribution export | 3,490,844 B | 1,819 | 1,805 | n/a | 1 external analysis map |

Against the 8,127,954 B / 2,495-module pre-rewrite baseline, that 2026-08-31 exact tree is 3,831,826 B
smaller (-47.14%) with 676 fewer modules. It retains all eight expected routes and no `effect`,
`fast-check`, or `@react-navigation/*` runtime source. The exact HBC is 203,872 B below its budget;
the module count has 31 modules of headroom, so future dependency additions still need deliberate
measurement. The final Hermes bytecode version is 98 and the exact bundle SHA-256 is
`b4e8fd6b91089f4b2509f30ffbb9ba21c56a2a5b00b003c03fb4f80c2359ec59`
([final bundle](./evidence/openbot-ios-audit-2026-08-31/bundle-final.json)).

These values identify the frozen 2026-08-31 checkpoint and must not be presented as the current
artifact. Later thread/activity/routine/plugin/A2A and native fixes legitimately changed the graph;
the superseding exact export, installed bundle, source/artifact chronology, and budget headroom are
reported in [plan 39](./39-ios-native-simulator-validation.md). Exact bundle SHA identifies one
export artifact; it is not used as a deterministic source fingerprint.

The permanent gate creates exact and mapped exports, removes its temporary directory in `finally`,
and enforces:

- exact Hermes HBC no larger than 4,500,000 B;
- mapped HBC no larger than 3,700,000 B;
- no more than 1,850 Metro modules or mapped source files;
- no more than 25 Metro assets / 30,000 asset bytes;
- zero release source maps;
- exact route-source parity; and
- no `effect`, `fast-check`, or `@react-navigation/*` production source-map entries.

See [`check-mobile-budgets.ts`](../scripts/performance/check-mobile-budgets.ts) and its
[`measurement utilities`](../scripts/performance/mobile-export-measurement-utils.ts).

### What “lazy” means on native Expo Router

The native production build is one Hermes bytecode bundle; Expo Router's route files are not
independent production chunks on iOS. Hermes can memory-map bytecode and avoid eagerly executing
every route, but a dynamic route import cannot be reported as an APK/IPA-style split that Metro did
not produce. The audit therefore budgets the total HBC and module/source graph, then reduces
runtime work with focus ownership, native virtual lists, bounded data, and native file I/O. This is
the useful iOS equivalent of demand-loading here; pretending the eight route files ship as separate
native chunks would be misleading
([native/dependency audit](./evidence/openbot-ios-audit-2026-08-31/dependency-native-audit.json)).

### Dependency health

`bun install --frozen-lockfile` passes without changing the lockfile. `expo-doctor` passes 19 of 21
checks, not 21 of 21:

1. Bun's isolated workspace layout exposes duplicate filesystem installations of the same versions
   of nine Expo packages. The deterministic Apple autolinker currently resolves 22 unique Expo
   packages and 23 unique pods, and the inspected Podfile lock has one source for each checked
   native module. This lowers the likelihood of duplicate native code but does not prove the
   distribution binary; a clean archive is still required.
2. Because `ios/` is checked in, Expo warns that `icon`, `orientation`, `scheme`, appearance, iOS,
   and plugin fields may not automatically synchronize. The new native gate compares Expo
   introspection, Info.plist, entitlements, Xcode marketing version, plugin permissions, and
   autolinking, but controlled prebuild/native-project review remains necessary whenever config
   changes.

`bun audit --json` reports no critical advisories, two high advisories for `image-size@1.2.1`
through Metro build tooling, and two moderate advisories. The high package is absent from the
production iOS source map. One `decode-uri-component@0.2.2` module remains at runtime through
Expo Router/query-string; `uuid@7.0.3` is Expo/Xcode configuration tooling and is absent from the
runtime map. These are classified, not dismissed
([dependency/native evidence](./evidence/openbot-ios-audit-2026-08-31/dependency-native-audit.json)).

## Live sync and network A/B

The pre-remediation foreground path requested a complete client bootstrap every 2 seconds and,
after a chat was opened, also requested its latest 100-message history every 2 seconds. The final
frozen-tree rerun used exact server image `734af988b7eb`, auth-disabled mode, PostgreSQL 17 on
tmpfs, all 34 migrations, 1,000 Bots, 1,100 channels, 32,006 messages, 1,100 routines, and 36,207
search documents. It ran 50 measured requests after ten warmups:

| Response | Bytes | End-to-end p50 / p95 | Server p50 / p95 |
|---|---:|---:|---:|
| 1,000-Bot / 1,100-channel bootstrap | 1,554,957 B | 40.039583 / 49.095708 ms | 31.71 / 40.15 ms |
| active history, 100 messages | 40,919 B | 1.934208 / 4.027958 ms | not instrumented |
| lightweight runtime | 100 B | 0.461 / 1.711542 ms | not instrumented |
| legacy compatibility snapshot | 14,878,193 B | 150.3035 / 164.781708 ms | 88.99 / 96.8 ms |

The user's normal Docker volume could not initialize because the Docker VM was full. No unrelated
Docker data was pruned; the final production images ran on an isolated network with PostgreSQL and
mutable paths backed by disposable tmpfs.

The iOS hourly projection below applies the exact final payloads to the two schedules; it is not a
cellular capture.

| Steady foreground state, after initial load | Before: 2 s | After: healthy 60 s fallback | Change |
|---|---:|---:|---:|
| full bootstraps/hour | 1,800 | 60 | 30x fewer |
| bootstrap bytes/hour | 2,798,922,600 B (2.607 GiB) | 93,297,420 B (88.98 MiB) | -96.67% |
| open-history bytes/hour | 73,654,200 B (70.24 MiB) | 2,455,140 B (2.34 MiB) | -96.67% |
| bootstrap + open history | 2,872,576,800 B (2.675 GiB) | 95,752,560 B (91.32 MiB) | -96.67% |
| 100-byte runtime checks | included in full bootstrap | 120/hour = 12,000 B | negligible payload |

The bootstrap consistency fence was also tested as an alternating source A/B (`post`, `pre`,
`post`, `pre`), with 50 samples and ten warmups per arm. Capturing the replay cursor before all
projection reads changed the mean of end-to-end p50s from 39.812376 to 39.251292 ms and the mean of
server p50s from 31.405 to 30.89 ms (-1.41% and -1.64%). The small improvement is treated as host
noise; the conclusion is that the race fix introduced no measurable slowdown. The fence ensures a
concurrent commit is replayed over SSE instead of falling between the projection and cursor
([final mobile API evidence](./evidence/openbot-ios-audit-2026-08-31/api-mobile-final.json)).

The new primary path is an authenticated fetch-backed SSE connection. Product events trigger a
50 ms trailing coalescer; a synchronous 100-event burst produces one authoritative reconciliation
in the test. Only the committed bootstrap cursor is used for reconnect, so observing event 41 and
then failing bootstrap still reconnects after 40. `snapshot.required` allows an authoritative
server restored to cursor 50 to replace cached cursor 100. Initial sync retries with exponential
backoff, stream reconnect is capped at 30 seconds, and a malformed or throwing stream handler
cancels the response body. Backgrounding aborts the stream and flushes pending cache writes;
foregrounding reconnects and requests reconciliation.

The 60-second fallback intentionally remains while SSE is healthy; if streaming is degraded it is
15 seconds. Consequently “idle equals zero bootstrap” is **not** claimed. Likewise, each separated
event burst still reconciles through a full bootstrap rather than applying a compact domain delta.
This architecture removes pathological polling and missed-event races, but the roster-proportional
bootstrap remains the dominant network residual
([sync scheduler](../packages/client-core/src/sync.ts),
[`mobile data tests`](../apps/mobile/test/network-data-performance.test.ts), and
[`client stream tests`](../packages/client-core/test/client.test.ts)). The complete deterministic
network/chat/auth record is in
[`network-data-chat-auth-final.json`](./evidence/openbot-ios-audit-2026-08-31/network-data-chat-auth-final.json).

## Snapshot, history, drafts, and disk I/O

The retained data policy is explicit:

- the active conversation retains loaded history so pagination and scroll position are not silently
  discarded while the user is reading;
- at most three inactive conversations retain history, capped at 120 messages each;
- every other visible channel retains only its latest message for the home preview; and
- the persisted snapshot stores no more than 200 messages for each retained active/recent channel,
  plus one latest message for the other channels.

In a source-level fixture with 100 channels and 300 messages per channel (30,000 total), no active
channel, and three recent histories, live retention fell to 457 messages: 97 latest previews plus
3 × 120. The persisted projection held 697: 97 plus 3 × 200. This validates the policy, not native
RSS or JSON parse time.

Snapshot writes are latest-wins. A 250 ms debounce feeds one serialized drain; 100 immediate saves
produced one filesystem write containing cursor 100 in the mocked Expo filesystem test. Two
generation-tagged slots provide a last-known-good fallback, each write is staged to `.next`, and
the selected server origin must match during load. Pending work flushes when the app backgrounds.
Conversation drafts are separately keyed by server origin and channel, serialized per path, staged
through `.next`/`.previous`, limited to six attachment references, restored after hydration, and
flushed on background.

The main residual is deliberate: an actively open, repeatedly paginated conversation has no
in-memory message-count ceiling. FlatList bounds mounted views, not the backing array. A long
single-session transcript therefore still needs an anchor-preserving data-window policy before it
can be called memory-bounded at arbitrary depth. Snapshot acceptance also reconstructs and sorts
the retained message array; it is bounded for inactive channels but still proportional to the
active transcript
([retention policy](../packages/product-core/src/history.ts),
[`snapshot cache`](../apps/mobile/src/snapshot-cache.ts), and
[`draft journal`](../apps/mobile/src/drafts.ts)).

## Attachment upload and memory pressure

Before this pass, photo/camera selection requested Base64 and document selection read the whole
file as a Base64 string before submitting JSON. Base64 alone expands bytes by about one third: a
25 MiB regular attachment becomes about 33.3 MiB of characters, six maximum-size regular files can
represent about 200 MiB of Base64 text, and a 200 MiB video can represent about 266.7 MiB before
counting the original file, JavaScript string representation, JSON serialization, request buffers,
or server decoding.

The remediated path requests `base64: false` and passes the selected URI to Expo FileSystem's native
`File.upload` foreground session. It sends raw bytes with the same bearer session, MIME type,
encoded filename, and optional alt text. The server response is status-checked and schema-checked,
401 still invokes authentication recovery, selection order is preserved, and at most two files are
in flight. The existing limits remain six attachments, 25 MiB for regular files/images, and 200 MiB
for recognized video files.

The Bun tests prove the method contract, headers, raw-file API selection, alt preservation,
ordering, and maximum concurrency. They do **not** prove peak native/JS memory, upload cancellation
behavior under process suspension, or cellular retry behavior. A physical-device Instruments pass
with one 200 MiB video and six 25 MiB files remains required
([native upload](../apps/mobile/src/native-asset-upload.ts),
[`composer`](../apps/mobile/src/components/composer.tsx), and
[`upload queue`](../packages/client-core/src/async.ts)).

## Lists, rendering work, and chat behavior

### 1,000-Bot and 1,100-channel A/B

The old New, Details, and Settings screens placed Bot rows inside ScrollViews and mapped every
eligible Bot to a React element. At 1,000 Bots, that means 1,000 eager row elements before viewport
culling, and the Create/Save footer could sit at least 58,000 layout points below the first row.

The new implementation uses FlatList or SectionList with a shared configuration:

- `initialNumToRender: 12`;
- `maxToRenderPerBatch: 10`;
- `updateCellsBatchingPeriod: 32` ms; and
- `windowSize: 7`.

All 1,000 Bots remain addressable by source order and normalized name/title/description search;
tests find Bot 999 and Bot 742 outside the initial window. Above 12 Bots, New Group and Group
Details place the exact existing Create/Save Pressable in a flex-bounded sibling below the
scrollable list, so the primary action stays reachable. At 12 or fewer Bots, search controls are
omitted and the original in-list footer remains. The six-member maximum, one-member edit minimum,
58-point member row, 38-point mark, 64-point settings row, 78-point routine row, loading/error/saved
states, routine toggles, and destructive delete semantics are all locked by source tests.

Home's old pinned selection performed an `Array.find` for each pinned id and an `includes` for each
rendered channel. At 1,100 pins and 1,100 rows the controlled model counted 1,211,100 comparisons.
The Map/Set version performs 4,400 build/lookups, a 99.6367% operation reduction. Across 80 local
Bun samples after ten warmups:

| Home pin projection | Median | p95 | Output |
|---|---:|---:|---|
| repeated arrays | 1.195583 ms | 1.433416 ms | 1,100 rows |
| Map + Set | 0.070167 ms | 0.102042 ms | same 1,100 rows/order |

That is a 17.04x median selector speedup on Bun, not an iPhone frame-rate claim. Home also reuses
one module-level `Intl.DateTimeFormat`, memoizes visible row fields, and passes stable callbacks
([list A/B evidence](./evidence/openbot-ios-audit-2026-08-31/list-scale-ab.json)).

### Chat lifecycle and viewport safeguards

The conversation route now owns expensive/live state only while focused. Focus hydrates the latest
100-message page (and bounded target context for deep links); blur releases the channel into the
inactive retention policy and stops suppressing its notifications. Read acknowledgement uses the
highest actually visible numeric sequence and only runs while focused, rather than marking the
whole conversation read merely because a covered route remains mounted. Duplicate read requests
coalesce to one per channel and converge on the highest pending sequence.

FlatList preserves visible position when history is prepended, animates only genuinely appended
messages, tracks whether the user is near the live edge, avoids snapping a reader away from older
content, exposes a jump-to-latest control, and explicitly paginates earlier messages in 100-row
pages. At the 2026-08-31 checkpoint these behaviors had pure/source tests but no current native
long-conversation trace. The 2026-09-01 follow-up subsequently replayed a 10,020-message conversation, history/thread
pagination, live-edge behavior, and bounded mounted rows in the Release Simulator build; physical
device frame timing and unbounded active-JS-history eviction remain open.

## Search

Search is not a 1,000-Bot device scan when connected. The mobile route debounces a normalized query
for 100 ms and calls the bounded server search for All, Messages, Bots, Chats, Files, Links, and
Routines. Superseded requests are aborted, and a generation token rejects a transport that resolves
after ignoring abort. The screen-local Map is now a real 64-entry LRU keyed by snapshot cursor,
category, and normalized query; a cursor change invalidates both cache and outstanding generation,
preventing stale results from crossing revisions.

The preceding 36,207-document server search fixture measured the 2026-08-31 public-API p50/p95 values of
17.013/17.575 ms for All, 9.010/9.607 ms for Messages, 13.516/14.701 ms for Bots,
5.278/5.862 ms for Chats, 12.540/13.766 ms for Files, 8.262/9.101 ms for Links, and
5.283/5.818 ms for Routines. A missing term was 1.884/2.648 ms. An exact Bot title ranked 1,000th
by recency still returned through the indexed exact-title lane outside the 512-row recent candidate
window
([search timing](./evidence/openbot-post-pull-audit-2026-08-31/search-final.json) and
[`exact-title proof`](./evidence/openbot-post-pull-audit-2026-08-31/search-exact-title-final.json)).

Those historical server results plus the bounded mobile request/cache behavior support “high
performance” at the data layer. The later implementation added NFKC/whitespace normalization, a
200-character input cap, an uncontrolled native text field, exact single-character matching, and
bounded result copy/URLs. Plan 39 therefore keeps the values above as historical and reports a
separate exact-current server benchmark after those changes. The 2026-09-01 CUA pass proved
off-window/category result and navigation behavior at scale. Results remain capped at 24 with no
mobile result pagination; app-only input-to-paint, keyboard animation profiling, full VoiceOver
behavior, and worst-case memory across 64 populated result sets remain unmeasured.

## Shared computer polling and takeover

The old computer route used an ordinary 2.5-second interval. A slow request could overlap the next
tick, and a route retained in the navigation stack could keep polling or heartbeating after another
screen covered it. A late takeover response could also restore control after blur.

The replacement:

- starts on focus and stops on blur;
- makes an immediate status request, then schedules the next request 2.5 seconds only after the
  previous one settles;
- does not run while AppState is inactive and wakes once on foreground;
- uses epoch/revision checks to ignore stale status and action results;
- serializes takeover changes and converges on the latest desired value without overlapping writes;
- always queues a server-side `false` on blur/background, even if local state did not observe the
  preceding `true`; and
- runs the 20-second takeover heartbeat only while focused, active, and controlling.

Tests cover a slow poll, stop/restart, recovery after rejection, a pending enable that resolves
after blur, rapid takeover toggles, single-flight writes, and a forced release. The visible screen
still polls a complete status and refreshes the frame URL every cycle even when nothing changed.
Revision/ETag-aware frame delivery or a computer event channel is the next bandwidth/decode
optimization; it should be measured against a real shared computer before changing semantics
([serial poller and takeover controller](../packages/client-core/src/screen.ts)).

## Authentication, push authorization, and sign-out ordering

The mobile client no longer needs or accepts a separate `OPENBOT_API_TOKEN`. In the default
`OPENBOT_AUTH_MODE=required`, the owner signs in with username/password and the resulting Better
Auth bearer is stored with its normalized server origin. Token and auth-mode writes are serialized
and generation-guarded; changing servers retires the prior credential, delayed login/session/mode
responses cannot commit into the new origin, and a 401 clears auth only if both the server and the
bearer actually used by that request are still current.

`OPENBOT_AUTH_MODE=disabled` remains an explicit trusted-network mode. A live discovery response
must say exactly `disabled`; malformed, unknown, or any other live response fails closed to required
mode. On a discovery transport failure only, the app may reuse a previously observed disabled grant
for that exact origin so its offline snapshot can open. Disabled mode carries no bearer. A stale
disabled grant is deleted before a required-mode tombstone is written, so a storage failure remains
fail-closed. Provider mutations apply the same captured-client/connection-epoch rule after every
await, preventing a delayed send, upload, history load, reaction, approval, routine, or computer
response from crossing a server switch.

The final server image also has a direct auth-cost A/B. Both arms used the same 34-migration,
1,000-Bot fixture and returned an exactly identical 100 B `/api/v0/client-runtime` body (same
SHA-256). One hundred measured requests per arm, after ten warmups and in alternating order, gave:

| Auth mode | p50 | p95 | Mean |
|---|---:|---:|---:|
| explicit trusted disabled | 0.571167 ms | 1.305625 ms | 0.695587 ms |
| required username/password bearer | 1.958417 ms | 4.225209 ms | 2.261404 ms |
| required-mode overhead | +1.387250 ms | +2.919584 ms | +1.565817 ms |

This closes the server-side required-mode measurement residual without inventing another token
scheme. It is loopback end-to-end latency, not iPhone or cellular/radio timing
([final auth A/B](./evidence/openbot-ios-audit-2026-08-31/auth-overhead-final.json)).

Push delivery now follows the server's **current** auth mode:

- required-mode registrations persist `authRequired=true` and a foreign key to the live session;
  the worker accepts them only while enabled and that session is present and unexpired;
- disabled-mode registrations persist `authRequired=false` with no session, and are eligible only
  while the server itself remains explicitly disabled; and
- undefined/invalid worker configuration defaults to required. Switching from disabled to required
  therefore stops old disabled registrations immediately rather than trusting their stored mode.

Required-mode sign-out has strict ordering. The mobile app first gives its captured old-origin
client a bounded cleanup opportunity, then posts sign-out with the still-current bearer. The server
acquires the shared push advisory lock, disables every enabled device bound to that session, and
only then lets Better Auth invalidate the session. The worker acquires the same lock, row-locks and
revalidates candidate devices immediately before Expo delivery, and holds the transaction through
the Expo request. A delivery authorized first must finish before sign-out reports completion;
otherwise retirement wins and the worker skips it.

That safety boundary has a deliberate performance cost: push batches are serialized at the final
authorization/send boundary, the database transaction and connection can remain open through the
15-second-capped Expo request, and both dispatch and sign-out transactions use a 20-second cap. An
already handed-off Expo notification cannot be recalled. The lock makes that send complete before
sign-out returns; it does not undo an external handoff. Queue depth, advisory-lock wait, transaction
duration, and sign-out latency should be monitored in a multi-worker production deployment.

Migration `20260831000700_push_device_session_binding` intentionally maps legacy devices to
`authRequired=true` with no session. They remain stored but fail closed until the next foreground
registration binds a live required-mode session; an explicitly disabled server can re-register the
same installation without a session. The final 33-to-34 migration rehearsal preserved the legacy
row in exactly this ineligible state
([auth/push evidence](./evidence/openbot-ios-audit-2026-08-31/network-data-chat-auth-final.json) and
[`migration rehearsal`](./evidence/openbot-ios-audit-2026-08-31/docker-workspace-build-final.json)).

## Docker workspace and migration regression

The final frozen-production build exposed a repository-level regression relevant to deployment of
the mobile API: the Dockerfiles' selective workspace-manifest copy did not include newly added
`apps/landing`, `packages/design-tokens`, and `packages/product-core` manifests. That meant the
container install stage no longer reproduced the root lockfile's complete workspace topology. Both
[`docker/computer.Dockerfile`](../docker/computer.Dockerfile) and
[`docker/app.Dockerfile`](../docker/app.Dockerfile) now copy those manifests before running their
filtered frozen installs.

The final computer build target installed 426 production packages in 140.41 seconds, bundled 1,243
modules into the reported 1.81 MB entry, and produced a 131,413,495 B build image. This validates
dependency resolution and the computer build stage, not the final Debian computer runtime image.
The final migrate image is 343,144,641 B; its server and worker bundles report 10.14 MB and 7.78 MB.
A fresh tmpfs database applied all 34 migrations. A separate rehearsal applied the prior 33-migration
image, inserted an enabled legacy iOS PushDevice, then deployed migration 34 and verified
`authRequired=true`, `authSessionId=null`, matching the intended fail-closed policy. Development,
performance, required-auth deployment, and disabled-auth deployment Compose configurations all
validate
([Docker/migration evidence](./evidence/openbot-ios-audit-2026-08-31/docker-workspace-build-final.json)).

## Native configuration, assets, and release posture

Positive source/native controls now include:

- Hermes and React Native New Architecture/Fabric enabled;
- precompiled Expo/React Native modules available by default;
- iOS deployment target 16.4;
- `CADisableMinimumFrameDurationOnPhone` enabled;
- Release assertions disabled and deployment product validation enabled;
- no declared background modes;
- camera and selected-photo-library usage copy aligned between Expo introspection and Info.plist,
  with unused microphone and Face ID copy absent;
- package, Expo config, Info.plist, and both Xcode configurations aligned at marketing version
  `0.1.0`;
- EAS remote build-number ownership and production `autoIncrement: true`;
- Expo Updates intentionally disabled for store-only binary releases; and
- no JavaScript source map in the exact production export policy.

The 2026-09-01 Simulator log also contains UIKit diagnostics because the Expo AppDelegate exposes
background-fetch and remote-notification callbacks while the installed `Info.plist` correctly has
no `UIBackgroundModes`. The audited product path does not require silent/content-available push or
background fetch, so declaring `fetch` or `remote-notification` merely to silence that warning would
broaden background authority without a feature need. Re-evaluate this against an Expo-supported
native template and real APNs lifecycle on hardware.

The app icon and launch image were intentionally replaced during this pass; this is the one native
branding change, not an in-app style rewrite. Built-in image generation used the repository's
existing mint robot visual. The icon prompt intent was a centered, friendly mint-and-off-white
rounded robot with a dark face and happy mint eyes, no text, an opaque warm off-white square, and
no pre-rounded corners. The splash uses the matching isolated robot on a transparent background.
The checked asset is an opaque 1024 × 1024 PNG at both
[`assets/openbot-icon-v2.png`](../apps/mobile/assets/openbot-icon-v2.png) and the native AppIcon
catalog, SHA-256 `8790242e97fe1cc6d350040506347737786ad453f93c6c4a89be5ff8bbb2206b`.
The splash catalog provides 120, 240, and 360 px scales referenced as `SplashScreenLogo` by the
storyboard. Native branding is outside the 23 Metro runtime assets
([asset evidence](./evidence/openbot-ios-audit-2026-08-31/dependency-native-audit.json)).

Source entitlements correctly remain `aps-environment=development` for Expo/Xcode generation.
That is not App Store proof: the distribution provisioning profile must produce
`aps-environment=production` in the codesigned application. Likewise, the remote build number,
actual IPA/app and app-thinning bytes, dSYM presence, launch metric, architectures, privacy
metadata, and embedded native dependency graph can only be accepted from a signed archive. This
archive check is a hard release gate, not a documentation follow-up.

## Functionality and style safeguards

The performance pass keeps the same light/dark tokens, open row treatment, Bot marks, compact
floating controls, glass surfaces, composer language, row heights, labels, and navigation routes.
It preserves or strengthens:

- username/password session auth by default and explicit trusted `OPENBOT_AUTH_MODE=disabled`
  discovery; no separate mobile API token is required;
- home pin/hide/unhide/duplicate actions, unread/working/approval semantics, search and new-Bot/group
  entry points;
- Bot/group create/edit, one-to-six group membership, profile fields, notification toggles,
  destructive confirmation, and routine create/edit/pause/resume/run/history/delete with
  composite-trigger preservation;
- message send, optimistic acknowledgement, attachment-only send, replies, group mentions,
  reactions, approvals, question/secret widgets, file/link/image display, drafts, earlier-history
  paging, exact-message deep links, paginated native threads, bounded run/activity projection, and
  chronology-preserving A2A collapse with a view-only loaded-history sheet;
- plugin catalog search, setup/install/remove, connect/disconnect or OAuth handoff, and paged,
  server-searched per-Bot access management;
- shared-computer watch, input, takeover, release, reconnect and error states;
- notification permission/deep-link behavior and focused-conversation suppression; and
- System/Light/Dark appearance, server connection settings, hidden Bot management, and sign out.

The large-roster search field and sticky Create/Save placement are conditional accessibility/scale
adaptations, not global restyling; they are absent at 12 or fewer Bots. Source parity tests lock the
same actions, limits, critical labels, row geometry, switches, routes, and destructive semantics.
The current focused suite also locks visible-message read behavior, appended-versus-prepended
motion, auth server-switch serialization, raw upload metadata, cursor recovery, cache fallback,
notification policy, and takeover release.

This is sufficient to say no intentional functionality or in-app style was removed. The 2026-09-01
CUA replay also found no obvious regression in the sampled light/dark tokens, open rows, Bot marks,
glass/navigation/composer language, or critical actions. It is not a pixel-perfect, zero-difference,
VoiceOver, Dynamic Type, Reduce Motion, or physical-animation proof; the prior screenshots remain
baseline references, and the icon/splash change is intentional. Mobile remains a companion rather
than literal Electron-shell parity, but channel hydration now includes `runItems` and the native
activity sheet, and the transcript now has a bounded native Markdown subset. Tables, math, and
Mermaid remain readable source fallbacks, large documents use native file handoff, the A2A sheet is
limited to loaded history, and arbitrarily paged active transcript backing state is not yet evicted.
Those are explicit platform/scale boundaries rather than performance-remediation regressions.

## Historical 2026-08-31 non-native validation

The frozen 2026-08-31 combined tree passed the following gates. These counts are retained to bind
the original A/B evidence; they are superseded as current-tree test and bundle totals by plan 39:

| Command | Result |
|---|---|
| `bun install --frozen-lockfile` | pass; no lockfile changes |
| `bun run check` | pass: 12 typecheck, 18 test, and 13 build tasks |
| architecture checks | pass |
| `bun mobile:performance` | pass: 4,296,128 B exact HBC, 1,773,235 B gzip, 1,819 modules, 23 assets; 3,490,844 B mapped / 1,805 sources |
| final auth-overhead A/B | pass: exact 100 B parity; required overhead +1.387250 ms p50 / +2.919584 ms p95 |
| `bun --filter @openbot/mobile typecheck` | pass |
| `bun --filter @openbot/mobile test` | 72 tests, 290 expectations, 0 failures across 19 files |
| mobile native-config sub-gate | pass; 22 unique Expo packages, 23 unique Apple pods, version 0.1.0 |
| `bun --filter @openbot/client-core typecheck` | pass |
| `bun --filter @openbot/client-core test` | 16 tests, 39 expectations, 0 failures |
| focused server bootstrap suite | 9 tests, 60 expectations, 0 failures |
| server suite | 110 tests, 467 expectations, 0 failures across 35 files |
| worker suite | 46 tests, 284 expectations, 0 failures across 15 files |
| contracts suite | 36 tests, 132 expectations, 0 failures across 4 files |
| scoped Biome | pass across 83 mobile/relevant files |
| `git diff --check` | pass |
| Compose config | development, performance, deploy-required, and deploy-disabled all validate |
| frozen Docker computer build | pass: 426 packages, 1,243 modules; build-stage image 131,413,495 B |
| final migration image | pass: fresh 34/34 and legacy 33-to-34 push-device rehearsal |
| dependency audit | 0 critical; high findings only `image-size` through Metro build tooling; two classified moderates |
| `expo-doctor` | 19/21; two classified warnings above |

The list-specific evidence was captured earlier at 33/33 mobile tests and 133 expectations; the
larger 72-test result supersedes that test-count checkpoint but does not turn its Bun microbenchmark
into a native measurement. The final cross-layer counts and auth/push recovery cases are recorded in
[`network-data-chat-auth-final.json`](./evidence/openbot-ios-audit-2026-08-31/network-data-chat-auth-final.json);
Docker and migration results are recorded separately in
[`docker-workspace-build-final.json`](./evidence/openbot-ios-audit-2026-08-31/docker-workspace-build-final.json).

The 2026-09-01 follow-up reran the current repository gates and exact bundle budget, built and
installed a signed Release Simulator application, and completed native CUA plus simulator-host
launch/CPU/network/footprint and stress replay. See [plan 39](./39-ios-native-simulator-validation.md)
for the superseding artifact, counts, 200 KB Markdown, 250-reply and 125-deep thread,
1,200-event activity, and 250-routine evidence. Physical-device Instruments, APNs/native hardware
capabilities, a production archive, and the full accessibility/reference-app matrix remain
unmeasured.

## Prioritized residuals and release gates

### P0 — required before distribution

1. **Produce and inspect a signed production archive.** Require production APNs entitlement,
   intended bundle/marketing/build versions, monotonically increasing remotely managed build
   number, dSYM, expected architectures, app-thinning report, embedded dependency sanity, and
   measured IPA/app bytes.
2. **Complete physical-device functional and accessibility replay.** The Simulator matrix is done;
   verify production-signing/Keychain, LAN prompt, camera and real photo-library/HEIC/iCloud flows,
   haptics, push/deep-link routing, background/foreground/interruption behavior, large uploads,
   VoiceOver, Dynamic Type, Reduce Motion/Transparency, contrast, and target sizing on hardware.
   A current reference-app capture is still required for exact style/motion comparison.
3. **Run physical-device performance profiling.** Record cold/warm launch, JS/UI FPS and frame
   hitches, peak RSS/JS heap, main-thread stalls, list cell counts, search input-to-paint, 30,000+
   message pagination, six 25 MiB uploads and one 200 MiB video, network/radio traffic, computer
   image decode/bandwidth, background energy, thermals, and memory-warning recovery.

### P1 — next scale work

1. **Replace invalidation-to-full-bootstrap with bounded deltas or paginated roster state.** The new
   schedule is 30x better at healthy idle, but every separated event burst and 60-second fallback
   still downloads the 1,554,957 B roster-proportional bootstrap at 1,000 Bots.
2. **Window the active transcript data, not only its views.** Preserve deep-link and scroll anchors
   while bounding the active backing array and reloading evicted pages on demand.
3. **Resolve Expo Doctor's native-layout ambiguity in a clean archive environment.** Same-version
   isolated paths and one autolink entry are reassuring, not binary proof. Also make every
   `app.json` change pass an explicit checked-in native synchronization review.
4. **Close the physical-device upload lifecycle.** Add cancellation/progress/retry semantics and
   prove memory/background behavior for maximum-size files without reverting to JS byte buffers.
5. **Smoke the final Debian computer runtime image.** The frozen computer build stage and Compose
   manifests pass, but the evidence deliberately does not claim the final runtime image was built
   and exercised end to end.
6. **Add a maintained XCTest/XCUITest application target.** Manual CUA caught real native defects,
   but the current scheme does not provide a CI-native regression suite.

### P2 — bounded improvements

1. Add revision/ETag or event-driven computer frames so an unchanged visible desktop does not
   trigger a new image decode/URL every 2.5-second status cycle.
2. Upgrade the Expo/Metro dependency set when supported fixes remove the two build-tool
   `image-size` advisories and the runtime `decode-uri-component` advisory; keep source-map
   classification in the gate.
3. Hide or relabel Settings' Sign Out action when the server explicitly runs auth-disabled mode;
   the current control is harmless but conceptually misleading.
4. Instrument push advisory-lock wait, transaction duration, queue depth, and sign-out latency.
   Preserve the final authorization guarantee while avoiding a global throughput bottleneck if
   real multi-worker load shows the 15-second external-request boundary is material.
5. Decide whether tables, rendered math/Mermaid, and larger inline document previews justify native
   renderers. Preserve the current selectable-source/file-handoff fallbacks and require separate HBC,
   accessibility, and native-memory budgets rather than importing the desktop DOM stack wholesale.

## Release decision

The source-level remediation should be retained: it removes clear bottlenecks, has deterministic
behavioral coverage, keeps the existing in-app style vocabulary, and does not trade away roster or
feature reachability. The branch is not yet eligible for a “buttery smooth on iPhone” or “no visual
differences” claim. Current-tree Simulator functional/performance acceptance and repository gates
pass with no observed blocking style regression. Approval for distribution should wait for signed
archive inspection plus physical-device Instruments, APNs/capability, and accessibility validation.
