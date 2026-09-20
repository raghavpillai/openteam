# Plus icon comparison — September 20, 2026

The home New conversation symbol was visibly larger than GrokBot's, and the attachment symbol was too heavy. The home symbol now uses a 20-point regular SwiftUI font; the UIKit attachment symbol retains its 16-point symbol size but uses regular weight. These APIs have different rendered metrics. Both buttons retain their 44 × 44 point touch areas and existing actions, materials and haptics.

Compared the user's `633C7BA8…/1-Photo-1.jpg` and `2-Photo-2.jpg` with actual iPhone 16 Pro Max simulator captures, normalized to a 440-point screen width. Estimated bright-pixel bounds and arm thickness:

| Control | GrokBot | Before | Updated |
| --- | --- | --- | --- |
| Home glyph width | 16.4 pt | 18.3 pt | 16.0 pt |
| Home stroke | 1.5 pt | 2.0 pt | 1.7 pt |
| Chat glyph width | 16.4 pt | 16.7 pt | 16.3 pt |
| Chat stroke | 1.5 pt | 2.3 pt | 1.7 pt |

The reference JPEGs are downsampled: one reference pixel represents about 0.75 points. These estimates establish the size/weight correction, not exact pixel equality. The glass itself was not changed. There is no light-mode reference in this set; light mode was checked for rendering and interaction.

Two existing UI tests passed with zero failures: `GroupAvatarUITests/testListAndHeaderInBothAppearances` and `ChatMotionUITests/testComposerHitAreasInBothAppearances`. They capture both appearances, check centered headers and 44-point composer hit targets, send from the edge of the send hit target, and dismiss the keyboard. No new test was added for a font constant.

Evidence: `output/plus-icon-0920/Home.xcresult`, `FinalComposer.xcresult`, `measurements-final.json`, and `plus-comparison.png`. `Composer.xcresult` captured a rejected oversized UIKit font experiment; its screenshots are not the final result. This focused pass does not certify full-app or physical-device QA.
