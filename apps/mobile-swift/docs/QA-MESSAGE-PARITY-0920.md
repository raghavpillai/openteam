# Message parity and performance — September 20, 2026

This follow-up addresses the user's selected RN audit findings. It does not claim blanket physical-device or pixel-perfect app acceptance.

Released in [TestFlight 0.0.1 (32)](TESTFLIGHT-32.md), verified valid and assigned to Team (Expo) on September 20.

## Changes

| Audit item | Result |
| --- | --- |
| M1 — unsent content | Per-chat and per-thread Swift drafts persist when leaving a conversation and relaunching. Draft edits are independent of the observed transcript. Coalesced disk writes run on an ordered utility queue; leaving/backgrounding flushes, while sends and account transitions retain durable commits. Importing RN's old storage was not requested. |
| M2 — older context | Search/reply destinations install a contiguous history window, retain before/after flags and expose forward pagination. Latest replaces the context window. Live updates cannot silently splice a distant latest page onto an older search result. Thread roots remain available separately. |
| M3 — group speakers | Bot-colored author names and small avatars identify ordinary group replies. Both open the author's conversation; custom avatar images are retained. |
| M4 — queue | The internal durable outbox still handles retries and delivery reconciliation. Settings no longer exposes a user-managed queue. The offline bubble says “Waiting for connection”; the sending clock stays removed. |
| M5 — bot exchanges | Centered activity rows open a read-only exchange with both bot identities, attributed messages and a Close Chat footer. A focused exchange search/deep-link result opens this viewer too. |
| M6 — forms | “Do this on the computer” submits the escalation action and opens the computer only after acceptance. Receipts include field status and submission/domain/page-change outcomes, never the entered secret values. Recovery receipts can reopen the computer. |
| M7 — secrets | Reads canonical `secretRequest` metadata with the existing `secret` alias; shows supplied labels/instructions, personal/bot storage scope and provided-state receipts. |
| M8 — routines | Centered routine events open the referenced editor; deleted routine events remain noninteractive. |
| M9 — reactions | Emoji counts, the current user's selected state and spoken counts are retained when toggling a reaction. |
| M10 — old cards | Legacy cloud/template rendering was intentionally not restored. |

## Rendering and persistence

Chat and thread transcripts use reusable native table cells. UIKit's active row/accessibility window is bounded to 80 overlapping rows; backing message data remains available for contiguous navigation. The visible message and its pixel offset anchor page prepends and window changes. Window shifts follow the user's swipe direction, preventing overlapping thresholds from oscillating on short messages. Updates received during a diffable snapshot application are retained for the next application.

Inline attributed text, document measurements and idle document web views have bounded caches. Regular tables/math use a smaller offline renderer; Mermaid uses the full renderer. Reused web views reject stale height messages from previous leases. Session cleanup clears document/text caches. Message actions, computer screens and media previews are presented by their containing page so recycling a row cannot dismiss them during keyboard changes.

When prepending a page removes a timestamp prefix from the previous first message, the anchor follows that message's bottom edge. This preserves the bubble position while the prefix disappears. The composer explicitly focuses its padded input hit area; this corrects a light-mode glass tap that could fail to open the keyboard.

## Reference inspection

GrokBot was inspected through its native macOS app. General, Computer, Usage/Billing and Updates settings and the idle composer exposed no user-facing queue control. No message was sent during this inspection. This does not establish the absence of a queue action during an active run. Its group author labels and read-only bot exchange were used as the interaction reference.

## Validation record

Evidence directory: `output/mobile-parity-fixes-0920/`. Core suite: 88 passing tests. Focused production server history/context/form contract tests: 14 passing tests. The initial UI pass found a recycled-cell computer presentation regression, a missing environment in a context-menu preview, and overlapping history-window thresholds; these were corrected before acceptance.

The final regression bundle ran 36 distinct cases: 34 passed immediately. The two follow-ups were the light-mode input focus issue above, corrected in `ComposerFocus.xcresult`, and an XCTest activation-point query on a noninteractive text label. `FinalReadiness.xcresult` verifies the label is visible, retains its frame to within eight points after pagination, and returns to Latest; the before/after screenshots show the unchanged bubble position. All 36 distinct cases now have passing executions. The suite covers edge navigation, interior hold/swipe, keyboard dismissal, empty/short chats, drafts, history windows, rich rendering, media, computer handoff, forms, secrets, reactions, routines and native Settings navigation.

`FinalTouch.xcresult` adds a repeated rich-history/window-change → Latest → first-tap typing → keyboard-dismissal regression. It also reruns both composer appearances and attachment edge swipes with/without the keyboard after bounding native history hit testing to its viewport. These three checks pass; there are now 37 distinct passing functional UI cases.

`PerformanceAccepted.xcresult` passes both benchmarks and their post-scroll typing/Latest checks. The comparison uses the same M4 Pro, iPhone 16 Pro Max / iOS 26.5 simulator, optimized Debug (`-O`), six drags per sample, three recorded samples plus warm-up:

| Workload | CPU before → after | Peak app memory before → after |
| --- | --- | --- |
| 1,000 messages | 273.457 → 4.709 s (98.3% lower) | 642.85 → 97.08 MB (84.9% lower) |
| 200 mixed rich messages | 16.000 → 5.185 s (67.6% lower) | 298.75 → 117.10 MB (60.8% lower) |

Both pass the unchanged six-second CPU / 180 MB app-memory budgets. `performance-final.json` contains raw samples and the passing comparison; failed/intermediate runs are not acceptance samples. Some build activity overlapped the original baseline, which is one reason not to interpret the wall-clock reduction as display smoothness or FPS.

Three authenticated live-server scenarios pass across `LiveMessages.xcresult` and `LiveRepliesFinal.xcresult`: real model delivery with held/swiped replies, attachment preview/hold/reaction/swipe, and rich-message hold/swipe/cancel/vertical scrolling. The reply test reads the production API back, checks the parent message and exactly one accepted user send, then relaunches and verifies both replies. The harness runs the current production server, PostgreSQL, real computer service and configured `openai-codex/gpt-5.5` provider in an isolated QA account/database over HTTP; model inference is not stubbed. The first reply run stopped on XCTest's noninteractive container activation-point query; the rerun locates its visible frame and verifies the actual gesture and stored result.

The regular local server also returned ready on HTTP through both `127.0.0.1:8787` and `100.94.42.50:8787` without changing the user's account data. This health read is separate from the isolated authenticated UI scenarios.

`MotionFinal.xcresult` passes the recording scenario and exact 12/8-point bubble gaps, 106/40/84-point heights, keyboard spacing and final reply. Its first run exposed a composer tap consumed in the history controller’s safe-area bar region. Native history now excludes both bars using its safe-area layout guide; `FinalSafeArea.xcresult` passes both composer appearances, keyboard/attachment edge swipes and repeated rich-history → Latest → typing cycles. The performance acceptance run above was then repeated on that correction.

Frame review subsequently caught an instantaneous 64-point follow adjustment when the loader expanded. Native following now uses a short display-link animation that re-reads the destination while cells settle; dragging, navigation and a new message interrupt it cleanly. `LoaderFinal.xcresult` passes the reference recording, including a new assertion that the final reply stays above the composer after collapse. Pixel tracks show 16 position changes through expansion and 37 through collapse, replacing the single-step expansion. Final frames keep the user/reply bottoms at approximately 469/522 points. `FinalActivityInteraction.xcresult` then passes the keyboard/send/activity/Latest regression on this correction. The active-footer-only animation does not change the inactive benchmark workload.

There are 43 distinct passing selected UI scenarios including the two benchmarks, three live-server cases and recorded reference case. Current screenshots, raw recordings, per-frame tracks, and normal/quarter-speed event-aligned comparisons are in `output/mobile-parity-fixes-0920/` (`comparison/` contains the side-by-side artifacts). Events are aligned separately to compare animation, excluding server response delays; playback does not use optical-flow interpolation. Reference bubble geometry is checked exactly, but this report does not claim that different robot artwork or all OS-rendered material pixels are identical.

## Limits

CPU and memory benchmark results are comparative iOS simulator measurements, including XCTest accessibility work between gestures. App memory excludes WebKit subprocess memory. Neither wall time nor scrolling signpost duration is a physical-device frame-rate measurement. Physical iPhone display pacing, felt haptics, microphone/camera, real APNs background delivery and external OAuth consent remain separate hardware/provider acceptance checks.
