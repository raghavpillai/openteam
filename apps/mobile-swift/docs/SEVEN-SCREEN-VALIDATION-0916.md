# Seven-screen validation — September 16

**The Swift app is not a 1:1 match.** All seven states now have fresh simulator captures beside the supplied originals. Chat background, bubble colors and resting composer geometry are close; menus, settings, scroll behavior and the appearance of glass over content still differ.

[Open the seven comparisons](../../../output/swift-seven-reference-0916/review.html) · [Measurements](../../../output/swift-seven-reference-0916/measurements.json) · [Test results](../../../output/swift-seven-reference-0916/test-summary.json)

## Confirmed bug: QA-23 — Latest messages does not return to the bottom

**P2, reproduced in both complete runs.** Open the reference conversation, scroll toward older messages by about 60 points, then tap the floating down-arrow. The conversation does not move; the last message remains obscured by the composer and the arrow remains visible. A second tap has the same result.

The final run records the last message at `(16, 885, 131.33, 40)` before tapping, after the first tap and after the second tap. Opening the conversation at its actual bottom puts that message at `y=825`. Both taps therefore leave a 60-point offset, rather than merely failing to hide the button. The test waits five seconds after each tap. [Recorded coordinates](../../../output/swift-seven-reference-0916/evidence-SevenReference-Verified/C8AE2E0F-5009-42A6-8BCF-74DFA06413AB.txt), [after-tap screenshot](../../../output/swift-seven-reference-0916/evidence-SevenReference-Verified/7C0B2FEA-4902-42A8-B124-B6B5CCE6CA1B.png). The responsible path is the `Latest messages` overlay in `Sources/App/ChatView.swift`; the underlying cause remains undiagnosed.

## Comparison by screenshot

| Photo | Matches | Differences / limitations |
| --- | --- | --- |
| 1 — attachment menu | Native menu over the open keyboard; file action opens the system picker. | Reference has **Attach Image / Take Photo / Choose File**. Simulator shows **Record voice note / Files / Photo library**, in that visible order. Camera is conditionally available on supported hardware, so its absence here is not proof of a device bug. Menu is darker and differently anchored. Reference keyboard includes a Write with Siri row absent on this simulator. |
| 2 — recording | Actual 0:02 capture; three pills at essentially matching positions and heights. Stop and discard return to the composer. | Waveform differs because this is explicitly synthetic audio. Reference has a floating down-arrow; native capture at the bottom does not. Native arrow starts transcription, so this capture does not validate audio-message delivery or real microphone capture. |
| 3 — multiline composer | `Heheh` plus two newlines; native box is 350 × 80 points versus approximately 350 × 81 in the reference. Send remains enabled and above the keyboard. | Native top edge is approximately 3 points lower. Reference's underline, blue caret, prediction row and jump arrow differ. Chat positions and header backdrop differ; screenshots are not artificially registered to conceal these differences. |
| 4 — scrolled chat | Content continues behind the floating header/composer, with a down-arrow. | QA-23 prevents returning to the bottom. The native glass over message text has stronger bright edges and visible distortion; the reference is smoother. The scroll indicator is absent in the settled native capture, which by itself does not establish an indicator bug. |
| 5 — latest chat | Correct conversation text, alternating bubbles, empty composer, no keyboard or jump button on initial entry. | Vertical spacing/timestamp position differs, as do header blur and the computer glyph. The native latest bubble starts at y=825 versus roughly y=817 in the reference. |
| 6 — settings | Rounded sheet and close control, account entry, Plugins, dark appearance. | This is the largest structural gap: no usage percentage or update card; no equivalent Auto-review toggle, editable rules, automatic-time-zone switch or Bot Computer row. Rules are described as desktop-managed under More preferences; time zone is read-only there. Native instead shows bot notifications, hidden conversations, push settings and appearance. Cards are also lighter/warmer. Local owner/server information is deliberately real fixture information, not a fabricated copy of the reference account. |
| 7 — home plus menu | Correct New Bot and New Group Chat actions; group creation opens its search screen. Menu width is essentially identical. | Menu is about 10 points left and 5 points lower. Its interior is considerably darker. Home row positions and accessory glyphs differ slightly; the account mark lacks the reference's blue dot. Our desktop robot artwork intentionally remains ours. |

## Glass and geometry measurements

Measurements use original files, normalized to a 440-point-wide coordinate system. Approximate reference edges have a ±2-point tolerance. No images are recolored, composited or retouched.

| Element | Grok Bot | Native Swift |
| --- | --- | --- |
| Chat background | RGB 20,20,20 | RGB 20,20,20 |
| Resting empty-composer interior | RGB 51,51,51 | RGB 51,51,51 |
| Back-button interior, same sampled patch | RGB 56,56,56 | RGB 57,57,57 |
| Home menu interior | RGB 50,50,50 | RGB 30,30,30 |
| Settings card interior | RGB 32,32,32 | RGB 36,36,34 |
| Empty composer | About 326 × 44 pt, y=882 | 326 × 44 pt, y=882 |
| Recording controls | About 48 pt high, y=878 | 48 pt high, y=878 |

The rendered composer gray already matches on a quiet backdrop. Changing all glass opacity uniformly would not address the darker system menus or the different response over text. A flattened JPEG does not reveal a material's numeric alpha. The reference's exact iOS build, Liquid Glass preference, accessibility settings and keyboard configuration are unknown.

## Evidence and scope

Final `SevenReference-Verified.xcresult`: **7 tests, 6 passed, 1 failed, 0 skipped**. QA-23 is retained as a normal failing assertion. The initial full run also had six passes and the same failure. The second run corrected the capture setup to include the reference's additional blank line and capture recording at 0:02, and recorded a second tap for the scroll failure. It did not change application behavior.

This pass used the iPhone 16 Pro Max simulator on iOS 26.5, 1320 × 2868 captures and the seven supplied 589 × 1280 JPEGs from attachment directory `57935E3D-22A4-4D48-97E8-493BFDC2D278`. The isolated in-memory API on port 20026 provides inert conversation data; no model executes the instructions shown in the reference messages. Tests, fixture content, project scheme and review artifacts were added. **No application fixes were made during this validation.**

The pass validates visual states and the listed interactions. It does not re-establish live-server messaging, physical camera/microphone, OAuth or APNs acceptance. Those boundaries and existing findings remain in [live-server QA](LIVE-SERVER-QA.md), [VNC QA](VNC-QA-0916.md), [settings/plugins QA](SETTINGS-PLUGIN-AUDIT-0916.md) and [the broader audit](QA-AUDIT-0916.md).

## Repeat the capture

Start `SWIFT_PARITY_PORT=20026 bun apps/mobile-swift/scripts/parity-server.ts`. Generate the project with `python3 apps/mobile-swift/scripts/generate-project.py`, then run the `SevenReference` scheme against an owned iPhone 16 Pro Max simulator, with parallel testing disabled and a fresh result-bundle path. The scheme is excluded from the default test suite. Use `scripts/export-seven-review.py` with the output directory, `--reference-dir` and `--bundle` to rebuild the gallery.
