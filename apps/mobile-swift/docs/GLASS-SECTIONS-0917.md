# Glass, sections and details — September 17, 2026

Compared the five new Grok Bot screenshots in attachment set `633C7BA8-F901-43BB-BAA6-7D94B97E1D7B` with actual native iOS captures. Original files, pixel samples and before/after screenshots are preserved in `output/swift-glass-sections-0917/review/review.html`.

## Why the appearance differs

The reference background is a flat `#141414`, its assistant bubbles/cards are `#202020`, and its user bubbles are `#5C5C5C`. These already match the native palette. The latest screenshots do not establish a separate whole-page gradient. The top/bottom scroll-edge fade and the changing content behind each control alter the visible material color.

Our dark controls used `Glass.clear`, a faint white tint and an additional uniform white border. The extra border made the rim harder, while clear glass handled underlying text differently. Dark controls now use regular native Liquid Glass with a calibrated neutral tint and the system's rim. Light glass and its existing neutral edge are unchanged. Both modes retain `safeAreaBar` and the soft native scroll-edge effect; no painted header/composer slab was added.

The resting composer sample is RGB 51/51/51 in the JPEG reference and 52/52/52 in the final native capture. The page sample is exactly 20/20/20 in both. Solid palette matches are distinct from a claim of pixel-identical native materials. A tint parameter is not the total opacity of a glass control, and these screenshots cannot establish Grok Bot's exact material settings. Apple's [materials guidance](https://developer.apple.com/design/human-interface-guidelines/materials) describes how regular glass and scroll-edge effects adapt to underlying content.

## Behavior changes

- Home omits the Unassigned heading when no custom sections exist and ignores a stale collapsed flag in that state. Orphaned section assignments fall back into the visible list.
- Long-press a section heading for Collapse/Expand, Rename and Delete section. The full header is touchable. Deleting a section removes its grouping, not its conversations, and expands Unassigned so moved chats stay visible. Writes use the existing server sidebar endpoint and error handling.
- Tapping the chat avatar/title pushes details through the existing navigation stack, producing the native right-side transition and interactive left-edge back gesture. Instructions still open as a nested page and save successfully.
- Removed the mobile Memory management screen, its entry point and its obsolete editing test. Server memories and backend APIs are unchanged. Neither native nor legacy mobile source contains controls named “hype” or “confrontation”; clarification was requested rather than inventing a feature deletion.
- Reset to default uses the reference blue action color.

The new photos do not include a section context menu. Its actual actions are tested, without claiming a visual match to an unseen reference.

## Verification

Owned iPhone 16 Pro Max simulator, iOS 26.5; isolated HTTP fixture, no owner credentials or external messages:

- `Final-3.xcresult`: four behavior/capture tests pass, no failures or skips. Includes native edge-back, nested instruction editing and saved server state; no-section stale state; section rename/collapse/expand/delete; removed Memory entry point.
- `Final-Glass.xcresult`: final material calibration captured in both appearances at rest, while scrolled, and in details. One test passes, no failures or skips.
- `Gestures.xcresult`: two existing message regression tests pass, covering long-press actions, swipe reply, sending an inline reply and returning to its quoted original.
- Core package: 50 tests pass, including the shipped HTTP transport-policy regression.
- Earlier calibration runs are retained. Bulk XCTest typing dropped a character during the instruction test; the final test waits for the keyboard, sends individual key events, and verifies both the displayed text and server persistence. A test-only async sleep compile error was corrected. These intermediate failures are not included in passing counts.

The HTML comparison uses originals at equal display width. Chat content and scroll positions differ; it is a focused material review, not a whole-screen 1:1 claim. Physical-device appearance/accessibility and the broader [QA audit](QA-STATUS-0917.md) remain separate acceptance work.

TestFlight packaging and Apple receipts: `output/testflight-native-18/`.
