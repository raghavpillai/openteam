# Final critical pass — September 21, 2026

This follow-up uses the same supplied light-mode and dark-mode recordings. It challenges the previous pass's remaining differences and test assumptions. Robot artwork remains excluded. [Comparison gallery](/Users/raghav/OpenBot/output/hypercritical-0921/index.html).

## Findings and corrections

### The reply test did not match the server's real parent chain

The previous fixture attached both the user reply and the bot response directly to the original message. The live server's code instead passes the new user message ID into a forked delivery; the bot's response inherits that ID. See [channel-service.ts](/Users/raghav/OpenBot/apps/server/src/services/channel-service.ts:217) and [messaging implementation](/Users/raghav/OpenBot/packages/messaging/src/index.ts:2597).

With that real chain, the previous Swift grouping rule showed a redundant quote above the bot's response. A new core test reproduced the failure before the correction. Consecutive bot responses now remain grouped whether they point to the root, the triggering user reply, or the preceding response. Explicit user replies still have their own links; returning to a context after an unrelated message or timestamp break still exposes context.

The swipe/reply UI test now feeds the server-shaped parent ID into the bot response. The missing-root fixture was corrected too. The tests check that the bot response remains visible in both the main chat and focused reply page, without a repeated quote.

### A fixed timer made the reply destination briefly blank

Suppressing the spinner in the last pass hid one symptom. The cached reply list was still invisible during the first part of the native push because it waited another 120 ms after layout. The list now supports a reply-specific layout policy: reveal after the current layout settles, with a generation check that defers reveal again if sizing changes. Main history keeps its existing settling policy.

The captured transition now shows the original message during the push, at a horizontal progress where the previous destination was blank. [Recorded-frame comparison](/Users/raghav/OpenBot/output/hypercritical-0921/reply-progress.png). Reference, previous and current frames have incoming back-button x positions of 116, 110 and 107 points respectively; this is a near-matching stage of the push, not identical input timing. [Aligned motion clip](/Users/raghav/OpenBot/output/hypercritical-0921/reply-comparison.mp4) preserves real recorded frames, resampled for 60 fps playback.

A new rich-reply case uses a long Markdown table/code document. It checks that the latest reply stays anchored while the document self-sizes and that its draft survives leaving and reopening. Cold opening, native loading, pending sends, nested replies and edge gestures are also exercised.

### The light back-button treatment had regressed

The previous clear-glass change improved the header over dark content but made the back button's resting interior too pale. Back buttons in chat, replies and bot exchanges now use regular glass in light mode. This is evaluated separately from the title/computer controls and composer.

Across the same 19 registered scroll positions, the back-button interior's mean absolute contrast error decreased from **8.37 to 3.37 gray levels**. These are decoded 0–255 contrast measurements relative to each video's own canvas, not source opacity percentages. The recording encodings differ. [Full measurement data](/Users/raghav/OpenBot/output/hypercritical-0921/light-comparison.json) includes the unchanged-control measurements and their variation rather than reporting only the improved patch.

## What remains different

The native glass still has different refraction, edge highlights and glyph diffusion in some scrolling frames. The clear title/computer treatment and regular composer remain the closest measured variants from the prior experiments. This is not an exact shader match. Keyboard suggestion rows, status bars and the excluded robot artwork differ between the recordings and simulator. Unknown Markdown source markup also prevents treating every reconstructed line wrap as a pixel-equivalent fixture.

No new mismatch was found in the plus-icon sizing or existing send/working transitions during this pass. Their existing implementation is retained.

## Evidence and scope

**98 core tests and 15 distinct targeted UI cases passed in this follow-up.** The first motion run passed five cases; the final run passed 12, including two repeated cases. Those repetitions are counted once. The server-parent-chain test deliberately failed before the fix and passed afterward.

The 1,000-message workload passed three iterations. Dragging/deceleration duration averaged 2.500 seconds, and maximum measured peak physical memory was approximately 88.5 MB. The complete scripted workload averaged 18.439 seconds, including XCTest overhead. These numbers are observations, not a claim that this small visual/reply change improved performance or guarantees a particular device frame rate.

Final case results, the deliberately failing server-chain regression, source hashes, cleanup receipts and performance numbers are recorded in [test-ledger.json](/Users/raghav/OpenBot/output/hypercritical-0921/test-ledger.json). The earlier report's fixed-delay reply limitation and light back-button tradeoff are superseded by this pass; other qualifications remain applicable.

These are native simulator tests backed by stateful loopback HTTP fixtures. Checking the production server's reply metadata is not a claim that this pass exercised live bot inference, physical-device push delivery, OAuth, voice transcription or remote VNC. Performance recordings include simulator/XCTest overhead and are not an iPhone frame-rate certification.

Changes remain local. No commit, push or TestFlight upload was performed. Unrelated workspace changes are preserved.
