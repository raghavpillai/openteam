# Critical chat comparison against the September 20 recording

This follow-up corrects controls and colors that the earlier motion pass did not match. It does **not** certify complete one-to-one parity. The selected bot artwork, empty-composer controls, system keyboard, and some material diffusion still differ.

## Reference and method

Reference: `ScreenRecording_09-20-2026 01-30-25_1.mov`, supplied by the user. Compared actual decoded frames at the same 1320 × 2868 resolution / 440 × 956 logical points with an optimized iPhone 16 Pro Max simulator build. The conversation fixture is inert. Nothing in the recorded messages was executed.

Evidence: `output/chat-parity-0920/`. The comparison videos align each send, loader expansion, bot reply, and loader collapse separately. They do not compare server latency or synthesize intermediate frames.

## Corrected discrepancies

| Element | Before | Retained correction |
| --- | --- | --- |
| Attachment plus | 24-point regular SF symbol; visibly oversized | 16-point semibold symbol; measured visible glyph matches the reference's 16 × 16 points |
| Send control | 28 × 28 circle | 36 × 28 capsule with the reference-sized upward arrow |
| Send/voice touch area | Limited to the small visible control | Separate 44 × 44 hit target, preserving the visible inset |
| Chat glass | Shared regular material; matched flat fill but hid scrolling text differently | Chat-specific clear material with white tint 0.042, calibrated on captured output |
| Chrome fade | System soft scroll-edge effect | Canvas-colored gradient restored from the previous React Native chat; safe-area bars still handle keyboard resizing |
| Placeholder/timestamps | Opaque gray on every backdrop | Translucent chat labels, so their brightness follows the backdrop |
| Header symbols | Oversized computer/back controls, then an undersized intermediate port | Measured 16-point back/display symbols; 44-point controls remain unchanged |

The old React Native wrapper's clear tint was 0.056. Copying that number into SwiftUI produced a brighter result, so the retained SwiftUI value is calibrated rather than assumed equivalent. A regular-material comparison suppressed too much underlying text. A partially transparent regular-material experiment changed the focused composer's spacing and was rejected. None of those discarded material variants should be mistaken for the final build.

The light appearance retains the established regular material and subtle outline: the clear trial made black header labels too difficult to read over outgoing black bubbles. There is no light-mode GrokBot recording in this request, so light mode was checked for readability and behavior, not declared a pixel match.

## Colors

The retained page and bubble colors remain `#141414` (dark canvas), `#202020` (assistant), and `#545454` (outgoing). In the matched videos, the outgoing bubble is approximately RGB 82 and the resting glass sample approximately RGB 45 in both. Native PNGs and encoded videos differ by roughly two gray levels; the simulator's native canvas is RGB 20 but its H.264 capture is RGB 18. The reference video canvas is RGB 20. Do not tune solid app colors to cancel a recording conversion difference.

| Matched decoded-video sample | Reference | Retained build |
| --- | ---: | ---: |
| Resting composer glass | 45 | 45 |
| Outgoing bubble | 82 | 82 |
| Assistant bubble | 29 | 30 |
| Empty canvas | 20 | 18 |

Glass cannot be validated by a single flat RGB sample. The retained material is closer over moving text, but its refraction and rim are not proven identical to the reference device/OS. The side-by-side preserves that difference.

## Thinking robot: an actual remaining identity mismatch

The reference uses the legacy cloud-shaped mark with two slanted eyes. The comparison fixture substitutes the newer desktop `owl` artwork. At the same 32-point view size, the reference paints roughly 28 × 23 points while the owl paints roughly 22 × 24 points. The difference is visible in both the header and the thinking indicator; it is not an opacity bug.

The shared twelve-robot artwork replaced the legacy marks in commit `b7438e5`. The Swift renderer uses that newer artwork and the shared desktop keyframes. The five robot-motion tests pass, including all twelve identities, face transforms, mode transitions, and Reduce Motion. This verifies the selected artwork's implementation, not parity with the cloud animation.

The user was asked whether to restore the cloud or keep the selected bot artwork. Pending that preference, selected identities were preserved. The comparison must therefore not be labeled a one-to-one robot match.

## Other remaining differences

- GrokBot's empty composer has a microphone plus a white waveform pill. OpenTeam retains its functional recording control and, during a run, its Stop action. Only the draft's Send action has been matched in this change; no dummy voice feature was added.
- The reference and simulator have different keyboard suggestion/dictation controls and approximately two points of keyboard-height difference. The app keeps the same spacing relative to its actual keyboard.
- Earlier captures contained gaps on this shared simulator host. The final retained capture has better frame spacing, but one simulator recording does not certify smooth physical-device frame pacing. No physical iPhone was available in `devicectl`.

## Checks

- `Final.xcresult`: all three `ChatMotionUITests` passed—both appearances and edge-of-hit-target sends, keyboard/delayed acknowledgment/multiline/reply/latest behavior, and the matched reference scenario.
- `LightVerify.xcresult`: both-appearance hit-target test passed again after restoring the light material.
- `Verified.xcresult`: final matched scenario passed, including the new keyboard-clearance assertion; `verified.mov` is the retained dark capture.
- `robot-motion-tests.log`: five core robot-motion tests passed.
- The final reference test additionally requires at least 12 points of keyboard clearance for the focused attachment control. This catches the rejected material experiment's spacing regression.

Build logs, intermediate experiments, raw recordings, XCTest attachments, color samples, enlarged control crops, and the final side-by-side are retained under the evidence directory. Intermediate passes are not proof of visual parity: the blended-material scenario delivered messages successfully but its screenshot exposed a layout error.

Review `controls-before-after.jpg`, `final-send-side-by-side.jpg`, `final-loading-side-by-side.jpg`, and `review/side-by-side-quarter-speed.mp4`. The light capture is `composer-light-final.png`. `material-final-probe.jpg` and `material-blend-probe.jpg` contain discarded candidates, not the shipped selection. This pass does not upload a TestFlight build.
