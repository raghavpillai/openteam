# Chat motion and dark-color audit — September 19, 2026

Reference: the supplied `ScreenRecording_09-20-2026 01-30-25_1.mov`, a 39.120-second GrokBot screen recording at 1320 × 2868. The recording is evidence only; its chat text was copied into an inert local fixture, never executed by an agent.

## Method

Decoded 1,961 actual frames and retained their original presentation timestamps. Inspected the send/reply sequences frame by frame (515 frames across four critical windows), tracked bubble edges and loader occupancy, and compared the same conversation on an iPhone 16 Pro Max simulator at 440 × 956 points. No interpolated frames were used to infer movement. Slow-motion review repeats captured frames.

All local evidence is under `output/chat-controls-0919/`. The review videos align each send, loader expansion, reply, and loader collapse independently. They compare UI motion, not server response latency. Final motion capture uses `SWIFT_OPTIMIZATION_LEVEL=-O` with QA instrumentation; it is not a physical-device FPS benchmark.

## Findings and changes

1. **History snapped while the new bubble faded.** Applying an animation only to the inner stack did not animate the scroll view's bottom-anchor adjustment. Arrival layout now animates at the scroll view, with a 320 ms ease-in/ease-out curve. The bubble separately rises 12 points, scales from 0.94, and fades in. Removed a compounded implicit insertion fade.
2. **Acknowledgment replaced the pending row.** Pending and accepted messages now share a client-based presentation identity. Loading initial/older history does not trigger entrance effects. Confirmed-plus-pending copies are deduplicated.
3. **Text-only pending messages had an invisible attachment gap.** An empty attachment stack reserved six points, then disappeared on acknowledgment. It is now omitted. Pending text uses the same wrapping, Markdown, accent color, and padding as accepted text.
4. **Loader height changed abruptly.** Its visibility state now belongs to the chat scroll layout. A 64-point region expands over 280 ms and collapses over 240 ms; the robot scales/fades with it, finishing its fade before the final height collapse. Completion still lets the existing thinking-to-rest pose finish, and a restarted run cancels the pending dismissal.
5. **Date-separator spacing was 14 points short.** This caused the first send after a time gap to move history less than the reference. Added the missing top space and preserved the same timestamp while a send is pending.
6. **Keyboard focus caused competing repositioning.** Removed repeated imperative scroll-to-bottom calls on viewport/content-size changes. Bottom anchoring now follows native size changes; composer focus and multiline collapse animate. A tap in history dismisses the keyboard, including in threads.
7. **Latest control popped and flashed during automatic sends.** It fades/scales/slides for real user scrolling and stays hidden during automatic following. Normal online sends no longer show a clock/“Sending…” label; offline and failed-delivery controls remain available.
8. **Dark outgoing bubbles and glass were too bright.** Dark outgoing fill changed from `#5C5C5C` to `#545454`. Shared dark glass tint changed from 0.127 to 0.11. The page background stays `#141414`; light colors and the photo viewer's intentional lower tint are unchanged.

## Reference measurements

These are observed ranges from captured frames, not recovered private implementation constants. Detection near glass fades has approximately one-frame/one-point uncertainty.

| Motion | Reference interval | Approximate displacement |
|---|---|---:|
| Send after date gap | 17.577–17.877 s | 96 pt upward |
| Loader expansion | 18.043–18.293 s | 64 pt upward |
| Bot reply insertion | 21.952–22.235 s | 52 pt upward |
| Loader collapse | 23.635–23.852 s | 64 pt downward |

The send and loader are separate movements. Making them one fade, or hiding the loader instantly on completion, does not match this recording.

## Color interpretation

The difference was both the base bubble fill and the glass tint. Glass also changes with the content underneath it, so it cannot be assessed from one flat opacity value. Compared resting glass over empty canvas and scrolling glass over message content.

| Sample, decoded video RGB gray | GrokBot | Revised OpenTeam |
|---|---:|---:|
| Outgoing bubble | 82 | 82 |
| Resting composer glass | 46 | 46 |
| Assistant bubble | 29 | 30 |
| Empty canvas | 20 | 18 |

The simulator's native PNG canvas is 20; encoding its recording produces 18. The recordings also carry different transfer-function tags. Therefore the remaining one/two-level differences do not justify changing the shared page or assistant palette based on this video alone. These values are samples of rendered media, not claims about GrokBot's source hex values.

## Validation and limits

Validation results and final event alignment are recorded with the review artifacts. Core coverage includes pending-to-accepted identity, deduplication, timestamp stability, initial/history pagination behavior. UI coverage includes keyboard open/close, outside dismissal, delayed acknowledgment, multiline sends, loader/reply transitions, latest navigation, history anchors, pagination, edge navigation, and interior reply/hold gestures.

A first geometry assertion compared accessibility hit rectangles: accepted messages include bubble padding in those rectangles, while pending text does not. The corrected regression compares text centers and an unchanged preceding message; frame captures independently verify that the pixels do not jump.

This is a focused chat-motion/color pass, not a claim that every mobile feature has been retested. The recording contains no light-mode reference. Native keyboard suggestions, voice controls, system status indicators, and the chosen bot artwork differ between the two apps. Physical-device frame pacing and live-server latency still need device verification. No TestFlight upload is part of this pass.

### Recorded check results

- Core suite: 69 tests passed in the shared workspace, including the three new message-presentation cases. The concurrent computer-stream tests are outside this change.
- `ChatMotionUITests.testKeyboardSendAndActivityTransitions`: passed on the optimized build, including unchanged text centers and history position across delayed acknowledgment.
- `ChatMotionUITests.testRecordingReference`: passed; same conversation and screen size as the supplied recording.
- Rich history while reading, tall-message keyboard scrolling, and earlier-page anchor retention: all three passed. Pagination passed again after the final timestamp-spacing change.
- Exact left-edge back and interior swipes/holds across text, photos, and files: both tests passed.

The raw XCTest bundles and logs include failed intermediate attempts as well as the final passes. Those intermediate failures are retained rather than presented as successful runs.

### Remaining performance evidence

The optimized recording still has gaps of roughly 150–200 ms around some reply frames. A second run without a screenshot call near the reply also showed gaps. That does **not** establish their source: another simulator app was using a full CPU core and other builds/VM workloads were active on this shared host. It also does **not** justify calling the result hitch-free. No physical device was available (`devicectl list devices`: no devices). Keep device frame-pacing verification open; the side-by-side preserves these gaps instead of synthesizing smooth intermediate frames.

### Final side-by-side assessment

The revised capture moves the prior history by 96 points on the first send, reserves 64 points for the loader, and adds 52 points for the short reply. Settled bubble edges in the matched loading/reply states are within approximately one point of the reference. The reference's two-stage send is preserved, and acknowledgment no longer causes a reverse step.

The header's backdrop diffusion still differs over scrolling text. A `Glass.clear` trial showed more of that text but raised the resting fill to about RGB 62 in native screenshots, versus 48 with the corrected regular material and about 46 in the reference video. The trial was rejected and regular glass restored. Do not describe this as pixel-perfect glass parity: matching device/OS appearance and the top-edge fade remains open.

Review artifacts:

- `output/chat-controls-0919/review/side-by-side-normal-speed.mp4`
- `output/chat-controls-0919/review/side-by-side-quarter-speed.mp4`
- `output/chat-controls-0919/review/frames-0-send.jpg` through `frames-3-loading-indicator-collapses.jpg`
- `output/chat-controls-0919/review/loading-comparison.jpg`
- `output/chat-controls-0919/review/glass-over-content.jpg`
- `output/chat-controls-0919/review/glass-material-probe.jpg`
- `output/chat-controls-0919/review/alignment.json`
