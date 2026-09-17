# Native migration acceptance

Current status: see [September 17 triage](QA-STATUS-0917.md). Release builds now update the existing TestFlight app; Debug retains a separate bundle ID. The following implementation inventory and counts describe the September 16 acceptance pass. The functional implementation and error audit is in [FUNCTIONAL-PARITY.md](FUNCTIONAL-PARITY.md); the screenshot provenance and native design decisions are in [VISUAL-REFERENCE.md](VISUAL-REFERENCE.md).

**Latest audits: 22 original findings; QA-08 fixed, QA-01 implemented pending signed-device acceptance, 20 others unchanged.** See [native push acceptance](NATIVE-PUSH.md). See [QA-AUDIT-0916.md](QA-AUDIT-0916.md) for the original full-app findings and [SETTINGS-PLUGIN-AUDIT-0916.md](SETTINGS-PLUGIN-AUDIT-0916.md) for the ten-screen follow-up, three additional bugs, and reproduced OAuth-return failure. These findings qualify the historical implementation/coverage inventory below; native cutover is blocked.

## Current evidence

Artifacts live under `output/swift-functional-parity-0916/`. Successful runs, exact device names, screenshots and hashes are recorded in the review manifests and original `.xcresult` bundles. Failed exploratory bundles remain available for diagnosis and are excluded from the delivered gallery.

- Core: 24 tests pass, covering auth/URL/error handling, transport, persisted account-scoped drafts/outbox/sidebar, attachments, message reconciliation, thread ancestry, form validation and desktop robot projection.
- RN/shared client: 278 tests pass across 56 files. The Swift work does not change those production clients.
- Account/feature suite (`Acceptance-3.xcresult`, with three presentation checks refreshed in `Polish-1.xcresult`): 17 UI tests cover six sign-in/recovery cases, seven account/profile/memory/routine/plugin cases, and four rich-content/form/media/computer cases. Request schemas come from the production contracts, with persisted-state and action-receipt assertions.
- Compact suite (`Compact-final.xcresult` plus `Thread-4.xcresult`): five UI tests cover keyboard/send/lost acknowledgment, offline reconnect, approvals, settings/search/create, and successive offline thread replies.
- Visual suite (`Visual-2.xcresult`, with message actions refreshed in `Actions-final.xcresult`): six UI tests refresh all 21 supplied-reference comparisons, including native sheets, menus, message actions, keyboard states, replies and a 200-message scroll/type/navigation check.
- Five-photo follow-up (`output/swift-floating-reply-0916/Visual-5.xcresult`): eight UI tests pass with the final floating chrome, native scroll-edge fade, lifted conversation preview, visible software keyboards and inline-reply receipt/reconnect/quote-navigation checks. Its separate review contains all five newly supplied photos and 28 actual native captures. Exploratory failures are retained outside that gallery.
- The follow-up `Compact-3.xcresult` repeats visible keyboard and inline-reply/offline/navigation checks on iPhone 16e: two passes, no failures or skips. The final follow-up has ten passing test executions across the two phone sizes.
- The glass-transparency follow-up (`output/swift-glass-0916/Neutral-1.xcresult`, `Controls-1.xcresult`, `Compact-1.xcresult`) has eight passing UI test executions: six on iPhone 16 Pro Max and two on iPhone 16e, with no failures or skips. These cover floating controls in both appearances, visible keyboards, search/create, native message menus, swipe reply, inline receipts, offline recovery and quote navigation. Its review contains six reference/before/after comparisons plus refreshed comparisons for all five follow-up photos. Light glass uses a faint neutral tint; dark glass and the system scroll-edge effect are retained.
- `Reply-recorded.xcresult` also passes; `Reply-matched.mov` supplies the unretouched 0.2-second in-progress drag frame. The video capture begins after the test app launches.
- In the earlier directly comparable draft-chat scene (`Visual-2.xcresult`), both bubble fill bounds were within one point of the reference and background/header samples matched exactly. A hidden activity-row gap was removed; this is a scene measurement, not a whole-app pixel-perfect claim. The follow-up floating-chrome captures are recorded separately above.
- Robot provenance remains the earlier verified desktop pass: 720 browser CSS frames, 3,540 part poses, 720 flattened face matrices, all twelve identities, live-pose interrupted 320 ms transitions, reduced motion and backgrounding. See [BOT-MOTION.md](BOT-MOTION.md). The source export check still passes.

Use the result summaries to determine pass/fail for a particular run. Test counts describe coverage, not proof that every production scenario works. The visual review labels historical RN captures, repeated references, native system differences and app-owned mismatches. It does not claim whole-app pixel identity.

## Features available for acceptance

| Area | Native implementation | Remaining acceptance |
| --- | --- | --- |
| Authentication/account | Welcome, server, required credentials, Keychain, cancellation, typed errors, expiry/draft retention, safe server switching and sign-out | Real required-auth server, signed device restart and account switching |
| Roster/profile/sidebar | Bots/groups, create/edit/duplicate/hide/pin, robot selection, group membership, notifications, custom sections/order | Large rosters, multi-client ordering and custom photo refresh |
| Chat/delivery | Native history and composer, pages, durable text/attachments, nonce reconciliation, thread context, read state, search, reactions, approvals | App kill during upload/send, live worker streaming, huge histories and multi-client races |
| Content/cards | Native inline/code; offline tables/math/diagrams; authenticated media/Quick Look; form validation/prefill/vault/retries; review/secure/handoff actions | Every card action/stale conflict and live file formats/services |
| Routines | List/create/edit/run/pause/history, validation, conflict recovery, preserved event/composite schedules | Live scheduler, true concurrent revisions and composite/event execution |
| Plugins | Catalog/install, accounts/config/secrets/auth, access/tools, sources, private skills, custom MCP, package/draft workspace | Live OAuth, tools and package actions; full authoring UI matrix |
| Memory | Search/read/delete/clear with confirmations and retry | Live-memory service and concurrent edits |
| Computer | Authenticated frames, takeover/heartbeat, click/drag/trackpad/pinch, type/key/scroll/apps, handoff completion and lifecycle release | Real desktop/lease expiry, slow network and device gestures |
| Voice/attachments | Native recorder/selection insertion/retry, file/photo/camera staging and Quick Look | Signed device permissions, interruptions and real transcription |
| Accessibility | Appearance/accent, native navigation/alerts, labeled controls, larger-text authentication, reduced motion | Full VoiceOver, rotation, keyboard and accessibility-size matrix |
| Push | Native APNs registration/transport, robot notification extension, account-scoped read synchronization, two read cursors, badge reconciliation, foreground suppression and tap routing | Live APNs and background/locked delivery on a provisioned physical iPhone remain acceptance blockers; see NATIVE-PUSH.md |
| Android | Existing RN app | Swift targets iOS only |

## Cutover gates

1. Run both clients against the same isolated real backend with two accounts, real workers, connected services, scheduler and desktop. Reconcile server state as well as screenshots.
2. Close native APNs server/device transport and the outstanding card/plugin/search integration cases above.
3. Complete signed-device camera, microphone interruptions, haptics, Keychain, backgrounding, notification and sustained performance checks on large and small iPhones.
4. Trial the separate native bundle alongside RN, then decide TestFlight/bundle-ID migration. Keep the RN iOS rollback and Android app available.

## September 16 system and dark-reference QA

See [SYSTEM-QA.md](SYSTEM-QA.md) for the production API/worker/PostgreSQL run, real five-minute scheduled trigger with the app closed, real X11/Chromium input checks, connection recovery, and fixes to UUID route encoding and production message reply gestures. The follow-up main native suite passed all 26 checks. The ten additional dark references are compared in `output/swift-dark-reference-0916/review/index.html`; all native captures are exported from XCTest, and the recording source is explicitly labeled synthetic.

The computer is now fullscreen black with floating native controls; keyboard input resizes the desktop and shares the ordered action queue. Group selection starts with search and Next. Profiles retain all twelve desktop robot identities, instructions and routines. Voice uses elapsed-time/waveform pills while preserving stop/discard/transcription retry. Native Liquid Glass and system scroll-edge behavior are retained. Device APNs, provider accounts, physical microphone/camera, and accessibility acceptance remain open.
