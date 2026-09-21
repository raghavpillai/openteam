# September 21 video audit — implementation and verification

This is the implementation follow-up to [VIDEO-AUDIT-0921.md](VIDEO-AUDIT-0921.md), covering the confirmed navigation, widget, exchange, typography, loader and computer-layout findings. It is not a certification that every feature of the app or every reference pixel matches.

The subsequent [moving-glass validation pass](GLASS-VALIDATION-0921.md) measures matching scroll positions, corrects the dark backdrop fades and records fresh regression results. Robot artwork is excluded from that comparison.

[Open the reference / before / fixed gallery](/Users/raghav/OpenBot/output/video-fixes-0921/index.html). Full-resolution screenshots, aligned crops and measured animation frames are included. Original reference images have not been painted over or reconstructed.

## Changes

| Area | Implemented behavior | Verification |
|---|---|---|
| Swipe / long-press Reply | Opens a focused page with a native rightward navigation push, Back, and `Reply [bot]` composer. Repeated quote and sheet title/Done chrome removed. | Swipe, long press, send, back, reopen, unsent draft restoration and incoming threaded response. |
| Thread semantics | New Reply actions use the existing server thread-send path. Bot responses inherit that context; old inline history is unchanged. Nested reply pages remain navigable. | Request payload, thread projection, branch isolation, offline reconciliation and lost acknowledgment checks. |
| Nested edge-back | Resigns the outgoing editor before interactive navigation. Returning pages do not automatically refocus a previously used editor. | Nested edge swipe, visible parent root, tappable composer and keyboard avoidance after refocus. Interior message swipes and canceled edge swipes remain functional. |
| Composer focus | Uses a stable bottom safe-area inset while preserving the native text editor and glass styling. The iOS 26 scroll-pocket bottom bar could drop focus immediately after opening the keyboard. | Ten cold launches across light/dark, first tap, padding refocus, outside dismissal, keyboard/send animation and nested navigation passed with the final inset. |
| Working feedback | Focused reply pages now show the animated activity footer, with visible bot name and working/needs-input text. | Active-to-idle fixtures in focused replies and after widget completion. Activity remains channel-scoped because the client run contract does not expose a thread ID. |
| Pending widgets | Contiguous inset option list, letter badges, descriptions, destructive tint, top-right dismiss, full-width Submit, ordinary-composer custom answers. | Single/multiple selection, disabled state, dismissal, custom answer and both appearances. |
| Widget receipts / retries | Answered options remain as checked receipts; dismissed options stay dimmed. Draft and request identity survive custom-answer failures. A matching durable receipt resolves a lost acknowledgment. Changing a single-choice answer after a failure gets a new request ID. | Failure before commit, lost response after commit, alternate choice after failure, unchanged retry identity, and draft clearing only after confirmation. |
| Widget motion | Explicit SwiftUI size interpolation, top-aligned hosting content and native list bottom-follow animation. Queued snapshot changes retain animation intent. Readers above the bottom retain their anchor. | Captured frame geometry, keyboard-open resize and reading-anchor assertion under 2pt. |
| Group messages | Muted speaker names, `Message [group]` placeholder and literal identifier wrapping without added hyphens. Rich formatting continues through its Markdown renderer. | Matched group text and rich-content regression tests. |
| Bot-to-bot exchanges | Overlapping avatars beside Back, timestamps, compact read-only glass footer; extra named capsule and Close Chat button removed. Removed the inherited negative bottom padding to align the footer 4pt higher. | Opening an incoming exchange, read-only state and matching bubble geometry. “Message from New Bot” opens an exchange, not bot creation. |
| History loading | Native 20×20pt spinner moved 20pt upward to the measured reference position. | Delayed-history fixture and observed transition to loaded messages. |
| Computer | Keyboard-state viewport moved to the reference position; compact native glass controls and matching keyboard symbol. Starting desktop / Connecting reflect different startup stages. | Authenticated disposable backend, actual Linux RFB stream, take-control keyboard, dismiss, menu, exit and takeover release. |
| Approval receipts | Body-sized heading/description and broad colored status band, while retaining Chrome profile/site selection and execution receipts. | Selection, completed and failed receipts. Exact reference approval payload was not available. |
| Empty direct composer | Added the separate waveform control; group and reply composers retain microphone-only presentation. | It opens the existing record/transcribe flow. No new live voice-call service is inferred from the recording. |

The reply transport choice is based on local server code, not inferred from screenshots: `channel-service.ts` forwards reply context to the bot delivery only for `isFork`; the messaging runtime then inherits that context for the response. Existing thread APIs supply the desired focused-page behavior. The widget receipt check also matches `rich-message-service.ts`: successful mutations return `accepted: true`; retries return `accepted: false` with the durable response/dismissal client ID in message metadata.

## Measured visual results

All values are points at 3 pixels per point on the same 440×956pt device canvas.

| Component | GrokBot reference | Swift before | Swift fixed |
|---|---:|---:|---:|
| Single-choice card | 364×212 | 364×287.33 | 364×211.67 |
| Multi-choice card | 364×386 | 364×403.67 | 364×386.33 |
| Completed single choice | 364×130 | 364×132.67 | 364×130.33 |
| Loader origin / size | x210, y468 / 20×20 | y488 / 20×20 | x210, y468 / 20×20 |
| Computer keyboard viewport | y186.33–461.33 | y207.67–482.67 | y186.33–461.33 |
| Exchange text bubble width | 337 | 335 | 337 |
| Long group identifier prompt height | 84 | 106 | 84 |

The page background was already RGB20/20/20 in both decoded reference and native captures. The obvious widget color mismatch came from gray standalone option pills; those are now a dark inset list. The smaller 2–3-channel-value differences between compressed HEVC reference bubbles and PNG screenshots do not establish different source color constants. No arbitrary global tint was applied to compensate for video encoding.

## Motion evidence

[Observed frame plot](/Users/raghav/OpenBot/output/video-fixes-0921/verified-motion.png) · [Frame strip](/Users/raghav/OpenBot/output/video-fixes-0921/verified-motion-strip.jpg) · [Measurements](/Users/raghav/OpenBot/output/video-fixes-0921/verified-motion.json).

[Combined completion / working / idle plot](/Users/raghav/OpenBot/output/video-fixes-0921/verified-combined-motion.png) · [Combined frame strip](/Users/raghav/OpenBot/output/video-fixes-0921/verified-combined-strip.jpg). The final combined recording also verifies the handoff between card resizing and activity-footer expansion, then the collapse to idle. It removes the earlier single-frame 64pt correction to the destination and back.

The final combined plot is refreshed from `InsetParity.mov` after the keyboard-container fix; its raw frame geometry is in [InsetParity-motion.json](/Users/raghav/OpenBot/output/video-fixes-0921/InsetParity-motion.json). The card top moves progressively from 643pt to 724.67pt as it contracts, then to 660.67pt as working space expands. It returns progressively to 724.67pt on idle. The retained bottom-inset change also passed all twelve video-parity UI cases together.

The original Swift capture changed card height from 287.33pt to 132.67pt in one frame, then changed its top position in the next frame. The corrected capture progresses through 211.67, 208.33, 194.67, 187.33, 177, 162.67, 151.33, 139.67 and 130.33pt, while its top moves progressively. The observed transition completes in roughly a quarter-second, close to the reference’s approximately 233ms observed tail. These are captured frames, not generated in-between images. Variable frame rates and different contents prevent claiming identical easing or a physical-device frame-rate guarantee.

Early implementations passed tap tests but still jumped on video. Those recordings remain in the evidence folder. The retained implementation also anchors widget content to the top of the self-sizing hosting cell; otherwise the native cell temporarily centers the shorter SwiftUI content and introduces an immediate half-height jump. Activity-footer scrolling uses a Core Animation presentation-layer animation, with the model at its final offset, to avoid repeated self-sizing/layout corrections during motion.

## Test evidence

The run ledger and latest verification results are recorded in [test-ledger.json](/Users/raghav/OpenBot/output/video-fixes-0921/test-ledger.json). Core tests: **95 passed**, including thread projection, drafts and matching widget mutation receipts. **All 29 selected UI cases have passing latest applicable results**, across the recorded runs. These cover the table above, navigation gestures, haptic event counts, Markdown/tables/math/diagrams, forms, paginated history, search context, and 1,000-message scrolling. The ledger retains failed intermediate attempts as well as the latest applicable result for each case; these are selected regression checks, not a full release certification.

The final 1,000-message simulator test passed three measured iterations: average scroll-drag/deceleration interval 2.506s, peak physical memory about 102,872kB, CPU time 3.987s. These are the test’s workload metrics, with no stored performance baseline; they do not prove 60/120fps or physical haptic quality.

The broader pass found real nested-keyboard navigation failure and several invalid tests. Search fixture responses lacked required context pagination fields; an older thread test targeted bot-to-bot event text that is intentionally not a normal message; old selectors expected `Queued · offline` and sheet `Done`. Fixtures/selectors were corrected, then stronger destination/hit-testing/no-alert assertions were added. A passing test is not treated as sufficient visual evidence.

The computer verification uses the existing `openteam-local-server:vnc-20260919` image, a disposable QA account and Linux desktop. Most remaining UI cases use loopback contract fixtures with reconstructed visible text. No model inference or messages to external people were needed. The two owned VNC containers and their harness/proxy were stopped afterward; the shared database and unrelated local servers were left running. This pass does not newly certify every live backend workflow.

## Limits and release state

- Exact glass opacity over identical moving content remains unverified; blur depends on the underlying transcript and OS settings. Reference keyboard language/settings and status bars differ.
- Robot artwork remains the app’s existing artwork. This is still a visible difference from GrokBot.
- Original raw Markdown and original attachment bytes were unavailable; source-formatting and every attachment/share variant cannot be declared pixel-identical from this recording.
- No new physical-iPhone validation of APNs dismissal, OAuth, live ASR, haptic feel, thermal behavior or sustained frame pacing was performed in this pass.
- No commit, push or TestFlight upload was requested in this turn. Existing unrelated work was preserved.
