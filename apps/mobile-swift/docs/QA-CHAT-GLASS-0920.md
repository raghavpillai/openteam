# Chat glass and color matching — September 20 follow-up

This pass compares the supplied GrokBot recording and preserved screenshot originals with fresh native iPhone 16 Pro Max / iOS 26.5 simulator captures. The target is the rendered appearance at rest and with messages behind the controls. It is not a claim that an opacity number recovers GrokBot's private material implementation.

## Retained changes

- Dark chat controls retain native clear Liquid Glass, with a neutral RGB 55 tint at 0.5 tint alpha. The previous faint white tint exaggerated bright content behind the header. This applies to the chat header, message bar, attachment control, latest-message control and read-only bot-exchange chrome. Tint alpha is not total material opacity.
- The dark top fade now follows the sampled reference profile. Its middle opacity changes from 0.25 to 0.56 and adds a 0.10 stop at 85% of its height. The fade remains separate from the material; the light and bottom fades retain their previous appearance.
- The send arrow is smaller, while its visible 36 × 28 capsule and 44-point touch area remain. A press dims the whole send label immediately and release restores it over 80 ms; Reduce Motion disables that release animation. The surrounding glass is not faded.
- The back chevron uses a lighter stroke and a slightly larger nominal font to match the actual painted bounds. The attachment plus already matches the supplied samples and is unchanged.
- The composer now has its own blue insertion/selection tint. It previously inherited the app's monochrome accent and rendered a white cursor in dark mode. The dark tint is sampled from stable typing frames; the light tint uses the established blue action color.

## Reference selection and measurements

The recording is `ScreenRecording_09-20-2026 01-30-25_1.mov`. Its 17.26-second frame is an idle send state. The earlier 17.45-second comparison caught the button while pressed: that gray fill is not the resting color. Frames before and after it confirm the resting button is white. Consequently, the permanent button fill remains white.

The later video is the authority for the current dark chat appearance. Older JPEGs show a brighter outgoing bubble and resting glass. They remain useful for additional states, menus, sheets and light-mode colors; inconsistent captures are not treated as one set of exact constants. The solid outgoing fill remains `#545454`, matching the later video after accounting for the recorded two-level grayscale conversion. No app color was changed to cancel that video-encoding difference.

Samples use original decoded/reference pixels and original XCTest PNGs at equal logical coordinates. Cropped comparisons preserve aspect ratio, colors and status content. The header-over-content samples are scene observations, not an image-wide similarity score; native keyboard height differs by two points and changes the message position relative to the glass.

| Sample, neutral RGB value | GrokBot | Before | Updated |
| --- | ---: | ---: | ---: |
| Dark page | 20 | 20 | 20 |
| Resting message-bar interior | 46 | 47 | 47 |
| Upper header interior over content | 50 | 90 | 62 |
| Lower header interior over content | 88 | 139 | 82 |
| Mean absolute difference across 11 top-fade samples | — | 10.41 | 0.36 |

| Painted glyph bounds, points | GrokBot | Before | Updated |
| --- | --- | --- | --- |
| Send arrow | 12 × 14 | 13 × 15.67 | 12.33 × 14.67 |
| Attachment plus | 16 × 16 | 16.33 × 16.33 | 16.33 × 16.33 |
| Back chevron | 8 × 15.33 | 8 × 14 | 8.33 × 15 |

Fresh theme-switch captures confirm exact sampled sheet/card fills against the preserved originals: light `#FCFCFC` / `#F2F2F2`; dark `#141414` / `#202020`. The available light references cover home/settings/creation, not an equivalent scrolling-chat video. Light chat is checked for rendering, keyboard behavior, hit areas and legibility.

## Experiments and remaining visual differences

The evidence directory preserves the initial white-tint baseline, corrected fade, a UIKit clear-glass probe, six material/tint alternatives, and two calibrated neutral candidates. The UIKit wrapper did not improve the optical match and was removed. Untinted regular glass was too dark and suppressed the backdrop. The retained neutral tint gives a closer result over content without moving the resting fill. All temporary probe code and launch flags were removed.

Native glass still has different fine refraction and rim details, including the 12-gray-level upper-header residual above. The source device's exact OS/material preferences are unknown. No private material APIs or partially transparent visual-effect-view workarounds were used; Apple documents that lowering a visual-effect view's alpha can break its composition ([UIVisualEffectView](https://developer.apple.com/documentation/uikit/uivisualeffectview)).

OpenTeam's selected robot identities, the system keyboard, and the previously documented extra GrokBot waveform control remain visible differences. Settings have OpenTeam's actual self-hosted controls. The broader screenshot gallery validates colors and reference states; it does not certify identical settings content or every app screen.

## Verification and evidence

Evidence is in `output/glass-match-0920/`. `review/side-by-side.png` is the full current/reference chat comparison; `review/controls-before-after.png` shows the changed controls. The gallery includes multiline, scrolled chat, settings, file preview and both appearances. Source image hashes, sample coordinates and measured values are in `review/measurements.json`; theme samples are in `palette-measurements.json`.

Interaction checks exposed an intermittent first-tap failure in both the multiline and keyboard scenarios. Waiting for completed history loading is necessary, but did not by itself eliminate it. A temporary trace captured focus changing to true and immediately back to false with no chat-history keyboard-dismiss gesture. A noninteractive-glass probe also reproduced the failure, so that material change was rejected.

The field now owns native taps on its text. Separate transparent targets cover only the top, bottom and leading input padding; the trailing send/voice target stays above them. This replaces the simultaneous focus gesture across the entire field. A new regression exercises first-tap typing, tap-outside dismissal, tapping above the text inside the message bar, and typing again across three fresh launches per appearance. Capture setup checks the existing loading indicator and enabled state. Text-injection tests wait for the real keyboard before typing, rather than relying on XCTest’s tap-idle heuristic during keyboard presentation. Temporary probes and traces are not retained in the app.

Targeted verification covers the recorded send/loader/reply scenario; composer focus and 44-point controls in both appearances; keyboard dismissal, delayed send acceptance, activity and Latest; dark/light glass over resting and scrolled content; multiline, latest/scrolled history, settings and the creation menu; real file preview/native sharing; and in-place appearance switching on home/settings/account/creation. The loopback fixtures are inert and do not invoke a live model or provider.

All 12 targeted cases have passing results for this pass. The final clean `ReadyComposer.xcresult` run passed all three interaction cases, including six fresh launch/focus cycles. Fresh `VerifiedMotion.xcresult` and `VerifiedMultiline.xcresult` captures also passed after removing the traces. The remaining seven cases cover unchanged settings, file-preview and palette paths from the same visual pass. `review/qa-results.json` records each result, evidence bundle, log hash and final changed-source hashes. Earlier failed runs are preserved alongside the probe results; they are not counted as passes.

This is a local visual/interaction update, not a new TestFlight release, live-provider acceptance run or physical-device performance certification.

Reproduce the matched-pixel review with Pillow:

```sh
python3 apps/mobile-swift/scripts/compare-chat-glass.py \
  --reference output/glass-match-0920/exact-ref-17.25.png \
  --before output/glass-match-0920/baseline-reference-before-send.png \
  --after output/glass-match-0920/verified-reference-before-send.png \
  --output output/glass-match-0920/review
```
