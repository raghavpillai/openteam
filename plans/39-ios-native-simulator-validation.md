# Native iOS simulator validation and performance audit

Date: 2026-09-01

Status: **the enumerated simulator acceptance matrix is complete on the added simulator. Full
iOS/device and App Store signoff is not complete.**

Artifact scope note: the performance ledger below remains bound to its recorded signed artifact
and hashes. A later mobile-functionality parity build added native speech, upload lifecycle,
Quick Look, advanced Markdown/math/Mermaid, and account/usage/about surfaces. That later build
passed the Release workspace build and live simulator functional checks, but was not used to
rewrite or relabel the performance measurements in this report.

The exact current signed simulator artifact was installed on the user-added
`OpenBot Acceptance 0901` simulator and exercised through the native UI. The complete acceptance
sequence covered both authentication modes, scale and pathological-content cases,
failure/recovery cases, and a controlled before/after performance route without an observed
functional or visual-style regression. A simulator cannot close the physical-device, APNs,
accessibility, background-execution, energy, or distribution-archive gates listed below.

Primary machine-readable evidence:
[native-performance.json](./evidence/openbot-ios-simulator-2026-09-01/native-performance.json) and
[search-current-final.json](./evidence/openbot-ios-simulator-2026-09-01/search-current-final.json)

Related code/dependency audit:
[iOS performance and parity audit](./38-ios-performance-and-parity-audit.md)

## Executive verdict

This is substantially more than a launch smoke test. The pass used a large PostgreSQL fixture,
the final arm64 `Release-iphonesimulator` product, process-level measurements, PID-filtered logs,
native accessibility state, screenshots, server interruption/recovery, and both supported server
authentication modes.

The exact-current long-chat route reduced incremental physical-footprint growth from 51,871,840 B
to 24,035,400 B versus the original signed baseline, a directional reduction of 27,836,440 B
(53.66%). Settled route footprint fell by 28,852,248 B (16.80%), and mounted accessibility message
rows fell from 100 to 33. Final idle CPU is reported below as simulator-host CPU, not device
energy.

No global visual redesign was introduced. The final native replay retained OpenBot's semantic
colors, marks, glass surfaces, navigation hierarchy, cards, composer, and control placement.
Visible differences are deliberate scale and failure affordances: bounded-list notices,
view-only A2A labeling, offline recovery copy, and a selectable plain-text fallback for
pathological Markdown.

## Evidence boundary

### Final simulator and signed artifact ledger

| Item | Final value |
|---|---|
| Host | Mac mini, Apple M4 Pro, 24 GiB, macOS 26.5.2 (`25F84`) |
| Xcode | 26.6 (`17F113`) |
| Acceptance simulator | iPhone 17 Pro, iOS 26.5 (`23F77`), named `OpenBot Acceptance 0901` |
| Simulator UDID | `92375D9F-362A-47C5-9F06-3B108CA71075` |
| Bundle identifier | `dev.openbot.mobile` |
| Version / minimum iOS | `0.1.0 (1)` / iOS 16.4 |
| Configuration / architecture | signed `Release-iphonesimulator` / arm64 |
| Clean Xcode build | pass |
| Path at capture | `/tmp/openbot-ios-current-final.yE5eeA/DerivedData/Build/Products/Release-iphonesimulator/OpenBot.app` |
| Product | `OpenBot.app`, 50,199,087 regular-file bytes, 96 files |
| Aggregate file-manifest SHA-256 | `7ce619a6e02faf47c49e052f62392040e7ad2060398b6f953b6b74fc7a2decbd` |
| Executable SHA-256 | `f0bea9d6683b94b4b9d39d5e2e8139db882c9a48d3365fa33dfd8118873d4e34` |
| Embedded Hermes bytecode | 4,416,699 B; SHA-256 `b5c936b7dac4688617169a31e6a1d7f2fca4691a53b7ea7d68e2568ef6b7cff7` |
| Bundle verification | strict `codesign`; Info.plist, embedded privacy manifests, and entitlements parse/validation pass |

The installed simulator bundle's `main.jsbundle` hash matched the final ledger above. The generic
simulator copy was terminated before the acceptance run, so the CUA evidence is bound to the
user-added simulator rather than an ambiguous booted device. After the required-auth replay, the
app was returned to the authentication-disabled fixture at `http://127.0.0.1:8877` and left on
Home. The final idle sample used PID 53241.

This is simulator ad-hoc signing. There is no production TeamIdentifier, provisioning profile, or
App Store receipt in this artifact. A strict simulator signature is not evidence of distribution
signing, APNs entitlement, or physical-device Keychain behavior.

The exact-current 79-file source audit scope recorded
`0af9d33556e449ed513c15fe3732065b378a8ec83a7e9aea38d7e3ebed00380c`. An earlier signed
candidate used build-scope fingerprint
`ba786bac12e2d2bafaab777f260e7d90a8b89f6a7fcbc4cfd9bb00cc06b723f1`, while its 86-file
bundle-analysis scope used
`9e3816589e8ccb5c39d5885cabce05709a475afaa2a7e795222761557f788396`. Those historical hashes
select different files and identify only their labelled artifact scopes; they are not current
source identity.

The 79-file fingerprint remained unchanged through the final export and replay, and zero scoped
source files were newer than the embedded HBC. This closes the late-build problem discovered when
three message-rendering files and two focused tests were found to postdate the preceding signed
candidate.

The exact-current rebuild replayed Home, exact Search, the 10k+ chat, rich cards, bounded 200 KB
Markdown, the 250-reply thread, activity, and A2A. Authentication-required, offline recovery, the
125-deep thread, and the 250-routine group had already passed on the immediately preceding signed
candidate; the late delta was confined to message rendering/Markdown and its focused tests, and
the final automated source gates passed. The acceptance matrix is therefore explicit about
aggregate coverage rather than claiming that every manual gesture was repeated after every
rebuild.

The canonical Expo analysis export and the Xcode embedded bundle are separate bundle invocations:
the current byte counts differ by 60 B and their hashes are not expected to be identical. Expo's
temporary path can also change a byte in otherwise equivalent exports. Source fingerprints and
the installed-artifact hash, not cross-pipeline byte equality, are the identity checks used here.

### What the measurements mean

CPU, RSS, and physical footprint are measurements of the Simulator host process. They do not
predict device GPU frame pacing, energy, thermal behavior, or memory-pressure survival.
`simctl launch` timing measures command acknowledgement, not first frame or time to interactive.
CUA action brackets include accessibility serialization, tool transport, and settle time; none is
reported as app-only input-to-paint latency.

Simulator Instruments reported Activity Monitor, Animation Hitches, Network, and Power recording
unsupported. Short CLI App Launch, Time Profiler, and System Trace attempts did not yield usable
captures. That is why this report uses process endpoints and logs and leaves FPS, hitch, energy,
and thermal claims to the physical-device gate.

## Final fixture and stress matrix

The disposable performance database ended with the following observed scale. Small count drift is
from audit actions in the isolated fixture, not production data.

| Fixture dimension | Final observed scale |
|---|---:|
| Bots | 1,103 |
| Channels | 1,104 |
| Channel messages | 32,400 (plus 113 rows in the separate Prisma `Message` table) |
| Routines | 1,353 |
| Search documents | 35,854 before the exact-current benchmark clone migration |
| Runs / run items / subagents | 114 / 1,002 / 101 |
| Plugin installation / connection / Bot enablements / grant | 1 / 1 / 1,103 / 1 |

The separate required-auth database contained 1,000 Bots, 1,100 channels, and 32,008 messages, with
no plugin state. The performance fixture intentionally retained its Utility Lab plugin setup; the
state counts above are authoritative.

| Stress case | Acceptance result | Evidence |
|---|---|---|
| 1,103-Bot Home | Pass; Home remained responsive and exposed 44 mounted Bot rows | [exact-current Home](./evidence/openbot-ios-simulator-2026-09-01/cua-current-rebuild-home.jpeg) |
| Exact off-window search | One-shot input `Audit Bot 0001` retained the exact native value and returned the exact Bot; inactive retained pages exposed no loading state to accessibility | [exact-current search](./evidence/openbot-ios-simulator-2026-09-01/cua-current-rebuild-search.jpeg) |
| Search server loss/recovery | Pass; stopping the exact fixture produced friendly `Search unavailable` copy and a retry action without a crash, while Home retained 44 visible cached Bots; restart recovered 24 results | [offline state](./evidence/openbot-ios-simulator-2026-09-01/cua-offline-search-after.png) |
| 10k+ long chat | Pass; exact-current route exposed 33 mounted message rows (32 regular plus the final rich row) and kept existing card/composer styling | [exact-current list/layout](./evidence/openbot-ios-simulator-2026-09-01/cua-current-rebuild-longchat.jpeg) |
| 200 KB Markdown | Pass with deliberate fallback; the payload became a bounded selectable preview with a bounded accessibility summary instead of retaining a pathological rich/accessibility tree | [exact-current 200 KB fallback](./evidence/openbot-ios-simulator-2026-09-01/cua-current-rebuild-markdown.jpeg) |
| 250 direct replies | Pass; all 250 replies loaded, the loader cleared, and 40 reply rows were mounted (41 transcript rows including the root) | [exact-current wide thread](./evidence/openbot-ios-simulator-2026-09-01/cua-current-rebuild-wide-thread.jpeg) |
| 125-deep reply | Pass; searching `reply 125` opened the correct branch, retained the target in accessibility state, loaded 125 replies, and mounted 48 | [deep thread](./evidence/openbot-ios-simulator-2026-09-01/cua-deep-thread-final.png) |
| 1,200-event activity projection | Pass; the native sheet bounded rendering to 100 of 115 projected rows and explicitly said older server activity was omitted | [exact-current activity sheet](./evidence/openbot-ios-simulator-2026-09-01/cua-current-rebuild-activity.jpeg) |
| Group with 250 routines | Pass at rendered-state boundary; 22 routine controls were mounted and Save remained reachable | [group routines](./evidence/openbot-ios-simulator-2026-09-01/cua-group-250-routines-final.png) |
| Rich message layout | Pass after the width fix; Markdown, question, and secret cards rendered at normal width rather than collapsing | [exact-current rich layout](./evidence/openbot-ios-simulator-2026-09-01/cua-current-rebuild-rich.jpeg) |
| Three-message A2A exchange | Pass; all messages appeared in a labeled `View-only exchange` sheet, with no reply, reaction, widget, or secret mutation action | [exact-current A2A view-only](./evidence/openbot-ios-simulator-2026-09-01/cua-current-rebuild-a2a.jpeg) |
| Active work state | Pass; native accessibility exposed Stop, the Bot working state, and the activity entry point together | included in native state capture |

The activity seed consisted of 101 runs, 1,001 run items, and 101 subagents in addition to the base
fixture and projected 1,200 events. The group ID used in the replay was
`7963ee95-35e0-7820-845e-bf4fe649bacf`; an earlier report contained a stale identifier suffix.

The exact-current long-chat screenshot is evidence for list windowing and layout only. Its final
fixture row was seeded earlier with literal `\\n` escapes, so it is not used as evidence for
real-newline Markdown. The rich-layout replay and focused source tests cover real line breaks.
Likewise, the 200 KB screenshot proves the bounded visible preview; full-copy preservation and the
400-character/four-line accessibility-summary bound come from current source and automated tests,
not from the visible viewport alone.

## Authentication acceptance

Both supported modes passed in the signed acceptance sequence. Required-mode CUA was performed on
the immediately preceding signed candidate; the later exact-current delta touched only
message-rendering/Markdown files and tests, while final auth tests/typecheck remained green:

- **Authentication disabled:** the server at port 8877 presented URL-only Connect. No username,
  password, or API-token field was required.
- **Authentication required:** the isolated server at port 8878 presented username/password only.
  A test owner account signed in successfully, the iOS Save Password prompt was declined, and Home
  loaded. No user-supplied `OPENBOT_API_TOKEN` was needed.

The endpoint was restored to port 8877 after the test.
[The required-auth evidence](./evidence/openbot-ios-simulator-2026-09-01/cua-required-auth-final.png)
contains a masked password and no reusable credential.

The app still fails closed when authentication is required and credentials are missing or wrong.
Disabled mode is intended only for a trusted local/headless deployment.

## Search assessment

### Final native behavior

Search is fast and bounded at the tested fixture scale. The native acceptance sequence verified
exact off-window Bot discovery, the uncontrolled native text-input path, a 200-character
normalized query cap, debounce, cancellation, stale-generation protection, hidden inactive-page
accessibility state, and offline recovery. Exact entry/navigation was repeated on the current
artifact; offline stop/recovery was captured on the immediately preceding artifact before the
render-only delta. The server limits the candidate set to 512 and the returned result set to 24.
The UI therefore proves useful top-result discovery, not an exhaustive enumeration of every
match; there is no result pagination in the current mobile search screen.

The 64-entry LRU is keyed by server snapshot cursor, category, and normalized query. It prevents
unbounded entry count, but it is not byte-budgeted. At the 200-character query and maximum result
URL bounds, a worst-case retained character payload can still approach roughly 25 MB. Frequent
snapshot-cursor changes can also abort and refetch an otherwise identical query. These are the two
largest remaining client-search risks.

The server separately bounds each projected result URL to 8,192 characters and returns `null` for
an oversized value. This is a result-projection/content bound, not an 8,192-byte accepted-request
URL cap. Query input remains separately capped at 200 characters.

### Exact-current server benchmark

The final search implementation was also benchmarked through its HTTP API against a cloned,
disposable database containing 35,955 `SearchDocument` rows. The container ran the latest built
server distribution after the final search source change. Each case used three warmups followed
by 20 measured requests. End-to-end includes loopback HTTP and response handling; Server is the
application-reported processing duration.

| Category | End-to-end p50 | End-to-end p95 | Server p50 | Server p95 | Results |
|---|---:|---:|---:|---:|---:|
| All | 17.471 ms | 20.106 ms | 16.34 ms | 18.92 ms | 24 |
| Messages | 9.331 ms | 10.535 ms | 7.91 ms | 9.20 ms | 24 |
| Bots | 14.518 ms | 16.512 ms | 13.29 ms | 14.45 ms | 24 |
| Channels | 5.333 ms | 7.817 ms | 4.25 ms | 5.58 ms | 24 |
| Files | 14.722 ms | 16.303 ms | 12.62 ms | 14.50 ms | 24 |
| Links | 9.606 ms | 15.603 ms | 7.97 ms | 12.26 ms | 24 |
| Routines | 6.020 ms | 9.795 ms | 5.04 ms | 6.50 ms | 24 |
| Miss | 3.107 ms | 4.108 ms | 2.12 ms | 2.78 ms | 0 |

This is exact-current data-layer evidence, not an on-device input-to-paint measurement. It uses a
cloned local database and loopback server, so network geography and production database load are
outside its scope. The full request-level record is in
[search-current-final.json](./evidence/openbot-ios-simulator-2026-09-01/search-current-final.json).

### Retained server A/B evidence

The following 36,207-document server benchmark predates the final server source timestamp. It is
retained as strong design-regression evidence for the bounded database search, not represented as
a byte-for-byte benchmark of the final signed mobile artifact:

| Category | p50 | p95 |
|---|---:|---:|
| All | 17.013 ms | 17.575 ms |
| Messages | 9.010 ms | 9.607 ms |
| Bots | 13.516 ms | 14.701 ms |
| Channels | 5.278 ms | 5.862 ms |
| Files | 12.540 ms | 13.766 ms |
| Links | 8.262 ms | 9.101 ms |
| Routines | 5.283 ms | 5.818 ms |
| Miss | 1.884 ms | 2.648 ms |

The previous unbounded candidate path was approximately 540-580 ms; all retained bounded cases
were under 20 ms and the exact off-window title was returned. The exact-current p95 for All is
20.106 ms end-to-end and 18.92 ms in the server. CUA timing is deliberately excluded from these
latency tables because tool/accessibility overhead dominates it.

## Before/after performance

### Final-artifact controlled route

The final signed artifact was freshly launched on the acceptance simulator, settled on Home, then
driven Home -> Search -> `Audit Bot 0001` -> the long chat. The long-chat endpoint was sampled
2.5 seconds after navigation.

| Metric | Home | Long chat | Delta |
|---|---:|---:|---:|
| Physical footprint | 118,802,784 B | 142,838,184 B | 24,035,400 B |
| Peak physical footprint | 121,997,664 B | 169,904,552 B | — |
| Host RSS | not retained | 487,296 KiB | — |
| Mounted accessibility message rows | — | 33 | bounded |

A separate exact-current Home process collected 12 one-second CPU observations: 1.150% mean, 1.3%
p50, and 1.4% p95/max. Physical footprint was 119,261,512 B with a 121,882,952 B peak.

The superseded candidate's fresh-process `simctl launch` acknowledgement was 203.306 ms. It is
retained only as historical command-acknowledgement evidence on a warm simulator and must not be
relabeled as exact-current cold-start-to-first-frame.

### Artifact-labelled long-chat A/B

| Metric | Original signed baseline | Intermediate tuned artifact | Superseded signed candidate | Exact-current signed artifact |
|---|---:|---:|---:|---:|
| Home footprint | 119,818,592 B | 116,230,496 B | 117,164,360 B | 118,802,784 B |
| Settled long-chat footprint | 171,690,432 B | 157,895,104 B | 150,260,112 B | 142,838,184 B |
| Incremental growth | 51,871,840 B | 41,664,608 B | 33,095,752 B | 24,035,400 B |
| Mounted accessibility rows | 100 | 33 | 48 | 33 |

No complete artifact hash was retained for the original or intermediate columns. The superseded
candidate is bound to embedded-HBC SHA-256
`df3082953c0a0db54421b7d971a4df53d657ced125f270d0bfccc97e8a03b2b4`; the exact-current
column is bound to `b5c936b7dac4688617169a31e6a1d7f2fca4691a53b7ea7d68e2568ef6b7cff7`.

The final-versus-original directional result is:

- 27,836,440 B less incremental growth, or 53.66%;
- 28,852,248 B lower settled footprint, or 16.80%; and
- 67% fewer mounted accessibility rows.

The intermediate 33-row result and the superseded candidate's 48-row result remain useful
historical evidence, but neither is the current installed artifact. All columns are separate
Release processes and the original route included an additional off-window search. Row counts are
direct; cross-process footprint changes are directional rather than a laboratory-identical trace.

Not every sampled metric moved downward. The exact-current transient peak was 169,904,552 B,
5,128,216 B (3.11%) above the superseded candidate's 164,776,336 B peak, while exact-current
settled footprint was 7,421,928 B (4.94%) lower and incremental growth was 9,060,352 B (27.38%)
lower. The transient-peak comparison is inconclusive because the artifacts, fixture mutations,
search/CUA timing, and accessibility capture differed; it should neither be hidden nor treated as
a proven regression.

### Final runtime log audit

The exact-current first-launch PID-scoped log capture contained 1,168 lines and 31 completed
CFNetwork task summaries, all 2xx. It contained zero strict fatal/crash rows and zero React Native
JavaScript or bundle errors.

Classified startup warnings were:

- one future-required `UIScene` lifecycle warning;
- two UIKit warnings for background fetch/remote-notification completion callbacks without the
  matching `UIBackgroundModes`; and
- five `RCTScrollView` focus-cache warnings.

The source audit found no silent-push or background-fetch feature path. Adding background modes
only to silence the simulator warning would falsely declare capabilities and was not done.

## Dependencies, bundle, and lazy work

### Canonical final analysis export

| Budget item | Final | Limit | Headroom |
|---|---:|---:|---:|
| Exact Hermes HBC | 4,416,759 B | 4,500,000 B | 83,241 B |
| Gzip HBC | 1,826,789 B | — | — |
| Mapped Hermes HBC | 3,591,948 B | 3,700,000 B | 108,052 B |
| Metro modules | 1,827 | 1,850 | 23 |
| Mapped sources | 1,813 | 1,850 | 37 |
| Analysis map | 9,152,687 B | analysis only | not shipped |
| Assets | 23 / 23,136 B | 25 / 30,000 B | 2 / 6,864 B |
| Release source maps | 0 | 0 | pass |
| Expo Router routes | 8 | all expected | pass |

Hermes bytecode version is 98, and the exact export SHA-256 is
`223ea6381249c2835b3c0626714a177d45f84245728c1cee68aabdd91683100f`. The exact and mapped
limits pass, but the 83,241-byte, 23-module, 37-source, and two-asset headroom is tight enough that
every new mobile dependency should continue to require an export A/B.

An earlier, source-fingerprint-stable product-core subpath import A/B saved 8,714 exact HBC bytes,
3,149 gzip bytes, 7,168 mapped bytes, and three modules/sources versus the root barrel. That
artifact predates the late Markdown/accessibility delta, so its exact byte values are historical;
the direct subpaths it justified remain in the current source.

### Lazy-loading reality

Expo Router defers route evaluation, and focus ownership, conditional sheets, virtualized lists,
bounded snapshots, file-backed uploads, and bounded rich parsing avoid work until needed. However,
this native build ships one Hermes bytecode bundle. There are no independent `import()` route
chunks to omit from the IPA.

The composer still statically imports the image and document pickers. Rewriting those imports to a
JavaScript `import()` would not create a native bundle split in this configuration. It remains a
reasonable future evaluation target only if an upstream-supported Metro/native split or measured
initialization cost justifies it.

Markdown work is conditionally bounded rather than lazily split: rich rendering stops at 32,000
characters, 240 lines, 600 formatting markers, or 256 inline tokens. The fallback preview is at
most 2,000 characters and 16 lines, the outer accessibility summary is at most 400 characters and
four lines, and the full source remains available through the message Copy action. The 200 KB
native replay and focused tests cover that boundary.

### Dependency health

- `bun install --frozen-lockfile` passes without lockfile changes across 1,989 packages.
- `expo-doctor` is 19/21. Its two known classes are Bun isolated-link copies of the same Expo
  versions and checked-in `ios/` configuration not automatically syncing from `app.json`.
- The native config gate resolves 22 unique Expo packages and 23 pods.
- `bun audit` reports no critical advisory. Two high advisories affecting
  `image-size@1.2.1` are in Metro tooling; the moderate `uuid@7.0.3` path is tooling-only; the
  other moderate advisory, `decode-uri-component@0.2.2`, remains reachable at runtime through
  Expo Router/query-string.

The clean Release build exited successfully. Its direct warning output was truncated by the build
capture, so this report does not invent a current warning count. The visible diagnostics were
dependency/generated-bundle warnings, with no application-source error. A successful build does
not make third-party warning debt disappear; a production archive should retain a complete warning
log for classification.

### Remaining code-level performance risks

The audit did not find another simulator-blocking bottleneck, but these paths remain worth
profiling before the next large scale increase:

1. The broad global context can fan one update out to many consumers.
2. Sidebar/group derivations scan and index more of the snapshot than their visible window needs.
3. Authoritative message merging performs a global O(N log N) sort, followed by additional
   sort/trim work, and outgoing snapshots can re-sort the full message set.
4. Mounted rows are bounded, but repeatedly paging old messages leaves the active channel history
   unbounded in JavaScript memory; several chat derivations traverse that full retained history.
5. Search cache count is bounded but bytes are not, and cursor invalidation can create
   abort/refetch churn.
6. Fixture fallback search constructs every category before filtering; it is test/fallback code,
   but should not become a production path.
7. Picker modules remain statically reachable from the composer, and the single-HBC architecture
   provides no true native route chunking.

The primary paths behind these conclusions are
[search.tsx](../apps/mobile/app/search.tsx),
[search-service.ts](../apps/server/src/services/search-service.ts),
[openbot-context.tsx](../apps/mobile/src/state/openbot-context.tsx),
[message-bubble.tsx](../apps/mobile/src/components/message-bubble.tsx),
[mobile-markdown-core.ts](../apps/mobile/src/mobile-markdown-core.ts), and
[thread-sheet.tsx](../apps/mobile/src/components/thread-sheet.tsx).

## UI and usability parity

Final CUA screenshots showed the same OpenBot look and interaction hierarchy used before the
performance changes. The rich-card width repair restored the intended layout rather than
redesigning it. Search still uses the same tabs and result style; chat retains marks, reactions,
composer, and card hierarchy; group details retains its existing controls and Save placement.

Deliberate behavior differences are bounded and disclosed:

- pathological Markdown uses selectable source instead of attempting an enormous rich tree;
- long activity explicitly says that older server rows are omitted from the bounded mobile view;
- A2A is explicitly view-only and does not expose mutations unsupported by that exchange;
- offline search preserves cached Home state and presents retry guidance; and
- large native lists keep only a visible window mounted.

This pass found no obvious replayed usability or style regression. It is not pixel-perfect visual
diff evidence and does not substitute for VoiceOver, Dynamic Type, Reduce Motion, increased
contrast, or physical-device animation testing.

## CUA tooling caveat

Simulator accessibility indices occasionally arrived late or mapped to a previously visible
element. The audit mitigated this with separate state/action calls, repeated stable-state capture,
screenshots, and explicit deep-link route setup. This is a CUA/Simulator control limitation, not
an observed app performance defect, and its timing was excluded from latency claims.

Two cases have narrower evidence:

- the wide-thread UI reached all 250 replies with no loader, but the exact second-sheet tap was
  confounded by delayed element mapping; cursor behavior is additionally covered by source,
  focused tests, and API evidence; and
- native CUA scrolling in the 250-routine group was unreliable and caused an accidental disposable
  fixture action; the captured rendered state proved bounded mounting and reachable Save, while
  source/tests cover the full collection.

CUA also caused two harmless message/routine audit mutations in the disposable fixture. The report
therefore does not claim a pristine post-run database or zero plugin state.

## Final automated gates

| Gate | Result |
|---|---|
| Frozen install | Pass |
| Mobile TypeScript | Pass |
| Mobile test suite | 113/113 tests pass; 522 assertions across 25 files |
| Native config | Pass; 22 Expo packages and 23 pods |
| Architecture boundary | 3/3 checks pass |
| Mobile-only Biome | Pass across 75 current-source files |
| Product-core / client-core focused tests | 9/9 and 22/22 pass |
| `git diff --check` | Pass |
| Repository TypeScript | 12/12 tasks pass |
| Repository build | 13/13 tasks pass |
| Repository test/check aggregate | 873 pass, 1 fail |
| Canonical bundle budgets | Pass |
| Clean signed arm64 Xcode Release simulator build | Pass |
| Strict signature, plist, and privacy checks | Pass |

The sole repository test failure is outside iOS: the desktop
`group-lifecycle-ui-parity.test.ts` assertion still expects the literal text `Move to` in the
screen source, while concurrent desktop work now delegates that UI to `<MoveMenu>`. It is a stale
desktop source-shape assertion, not an iOS runtime or build failure. It should be corrected by the
desktop owner rather than hidden in this report.

The repository-wide counts came from the latest broad run before the late render-only delta. The
current mobile test/typecheck, canonical export, clean Xcode build, source freeze, and native replay
were all repeated after that delta. Repository-wide concurrent work remains outside the exact
mobile-source freeze.

A broader 92-file mobile-plus-shared Biome probe also surfaced two pre-existing shared-code errors
(client-core import order and product-core redaction formatting) plus seven non-null/test warnings.
The exact mobile source itself is clean. Those unrelated shared-format findings were recorded but
not mass-rewritten during this regression-sensitive pass.

## What is still not fully tested

These are required before claiming full iOS/device or store signoff:

1. **Physical performance:** App Launch to first frame/interactivity, Core Animation/Animation
   Hitches, Time Profiler, Allocations/Leaks, sustained FPS, memory pressure, power/energy, and
   thermal behavior on representative iPhones.
2. **Physical networking and lifecycle:** Wi-Fi/LAN privacy prompt, cellular, offline transitions,
   interruption recovery, foreground/background upload, background execution, and real
   notification callback behavior.
3. **APNs:** production/sandbox entitlement, token registration with a real Expo/EAS project,
   delivery, notification tap/deep link, and background notification behavior.
4. **Physical media and system integration:** camera capture, Photo Library permission, HEIC,
   iCloud-backed selection, maximum-size upload, haptics, and real share/download handoff.
5. **Security/provisioning:** physical-device Keychain persistence/accessibility, production
   signing identity, keychain groups, local-network entitlement behavior, and real OAuth/plugin
   redirect credentials.
6. **Accessibility:** VoiceOver traversal/actions, Dynamic Type at accessibility sizes, Reduce
   Motion, increased contrast, color/contrast review, Switch Control, and hardware-keyboard focus.
7. **Distribution archive:** a clean signed archive and exported IPA with provisioning, APNs
   environment, privacy-manifest aggregation, dSYMs/symbol upload, thinning, receipt behavior,
   build/version metadata, and final installed size.
8. **Real worker completion:** the fixture proves queued/running presentation and cancellation,
   but not an end-to-end routine transition through a production worker to a terminal result.
9. **Native CI automation:** there is no maintained XCTest/XCUITest application target that
   reproduces this manual CUA matrix.

## Release recommendation

Accept this tree for **the enumerated iOS simulator functional and performance matrix**. Do not
label it full iOS, physical-device, accessibility, or App Store acceptance yet. The highest-value
next step is a production-style archive installed on a physical iPhone and run through the
Instruments, APNs, media, backgrounding, Keychain, and accessibility matrix above. No final
simulator finding indicates a blocking functionality or UI-style regression.

## Live-agent acceptance addendum — 2026-09-01

This addendum records a later end-to-end pass against real Codex-backed agents. It used a clean,
isolated database and loopback stack so the main OpenBot database, running containers, and owner
credentials were not changed. The installed product was rebuilt from the current workspace as a
signed arm64 `Release-iphonesimulator` app, installed on `OpenBot Acceptance 0901`, and driven
through visible native UI.

### Live fixture

| Item | Value |
|---|---|
| Server | `openbot-ios-liveqa-server`, host ports 8877/8890, authentication disabled |
| Worker | `openbot-ios-liveqa-worker` |
| Computer | `openbot-ios-liveqa-computer`, authenticated with the existing Codex OAuth runtime |
| Database | clean `openbot_liveqa_0901` |
| Live QA Bot | `f7fcd846-20cf-4881-8411-60bc9d7a75d2` |
| Live Peer Bot | `b1907fe6-5ecb-4683-8b8c-33ca8eb06269` |
| Direct channel | `8273637a-2ffc-4105-b632-a142a4674ba1` |
| A2A channel | `14b2a822-69ac-44aa-81a0-80ba8809c96e` |
| Routine | `924eb502-028d-481c-bddd-79a7672ade84` |

The three isolated services remained healthy at the final acceptance point. The main server still
requires owner authentication, has no configured user row, and has signup disabled. Consequently,
the main UI cannot be used until its owner credentials are configured; this live pass does not
claim otherwise and did not create or change a main-stack credential.

### Live native UI results

| Flow | Result |
|---|---|
| Real Bot creation/onboarding | Pass with a real Codex-backed Bot |
| Routine creation | Pass through natural-language iOS chat; created `LIVE_IOS_ROUTINE_0901` with `17 9 * * *` in `America/New_York` |
| Routine Run now | Pass; execution moved queued → completed and the Bot sent `LIVE_ROUTINE_FIRED_0901` |
| Pause/resume | Pass; pause stored `enabled=false`, revision 2 and no next run; resume restored revision 3 and the next scheduled run |
| Routine search destination | Pass; tapping the live routine in Search opens its populated native editor with schedule, active state, Run now, and completed history; closing is one-shot and does not reopen |
| Live A2A | Pass; both real Bots replied once with `LIVE_A2A_FIX_QA` and `LIVE_A2A_FIX_PEER`; all four runs across two rounds completed and both bubbles remained visible at the live edge |
| Run activity | Pass; the native activity sheet exposed 12 live events |
| Photo Library | Pass through the native PHPicker; a 1024×1024 PNG (1,059,127 B) uploaded and rendered, and the real agent described it with `LIVE_IMAGE_OK` |
| File attachment | Pass; native file selection/preview and Quick Look rendered the retained README attachment |
| Attachment selector | Pass; iOS `ActionSheetIOS` displayed Photo Library, Choose File, Take Photo, and Cancel |
| Camera on Simulator | Correctly unavailable; Take Photo is disabled instead of crashing. Real camera capture remains a physical-device gate |
| Shared computer view | Pass after runtime repair; the 1280×800 frame rendered, Take Control enabled controls, iOS text transfer reached Chromium, a scaled screen tap navigated to Example Domain, and Return control restored watching state |

Final routine-search evidence:
[live routine editor](./evidence/openbot-ios-simulator-2026-09-01/cua-live-routine-search-final.png).

### Regressions found and fixed by the live pass

1. Concurrent `/client-bootstrap` requests could duplicate the same Prisma projection and hang;
   bootstrap is now shared while in flight and covered by an overlapping-request regression test.
2. A2A/group messages could append while the native list remained visually above the live edge;
   the chat now reasserts `scrollToEnd` when grouped round content/footer state changes.
3. Simulator Take Photo raised `NSInvalidArgumentException` because camera source type 1 is not
   available; the native module now reports camera availability and the native action sheet
   disables the unavailable action.
4. The shipped computer runtime called ImageMagick `import` but did not contain ImageMagick;
   the runtime image now installs it and the shared-computer screen endpoint returns real PNGs.
5. Opening a routine while replacing the native Search modal tried to present a second page sheet
   during the UIKit transition. The search-to-details handoff is durable and the editor waits for
   the stack transition to settle before presenting.
6. The performance exporter did not match the production no-splitting configuration for Expo 57
   DOM components. It now clears the first Metro export, uses the production export mode, and
   budgets the intentional offline Mermaid/KaTeX runtime and branded artwork.

### Final gates

| Gate | Result |
|---|---|
| Mobile automated tests | 123 pass, 0 fail, 621 assertions |
| Mobile TypeScript | Pass |
| Native configuration | Pass; 23 unique Expo packages, 24 unique pods, version 0.1.0 |
| Mobile performance export | Pass; 4,541,908 B HBC, 2,202 modules, 26 assets, 1,835 mapped sources |
| Snapshot/bootstrap focused tests | 10 pass, 0 fail, 63 assertions |
| Computer screen-broker focused tests | 2 pass, 0 fail, 3 assertions |
| Final Xcode build | `Release-iphonesimulator`, arm64, success |
| Bundle verification | strict codesign pass; `dev.openbot.mobile`, version 0.1.0 (1) |

This closes simulator-level real-agent acceptance for routines, A2A, photo/file attachments,
native selectors, live activity, search navigation, and shared computer control. It does not turn
simulator evidence into physical-camera, APNs, device-Keychain, accessibility, or App Store
distribution evidence; those physical/device gates above still stand.
