# September 21 — moving-glass validation follow-up

A fresh validation pass after [VIDEO-FIXES-0921.md](VIDEO-FIXES-0921.md), focused on the reference recording's scrolling glass. Robot artwork is excluded from the assessment and was not changed.

[Open the comparison gallery](/Users/raghav/OpenBot/output/glass-validation-0921/index.html). It includes original frame timestamps, close-ups, a position-matched frame picker and measured backdrop profiles. The picker compares matching scroll positions; it is not a comparison of gesture timing.

## What changed

The mismatch was partly outside the glass material. The dark transcript fade began too low at the composer, leaving moving glyphs brighter behind the field, while the upper fade dimmed messages somewhat more than the reference.

- Adjusted the dark header fade's middle and trailing stops.
- Extended the dark bottom fade above the composer and aligned it with the reference. Its height also follows an expanded multiline composer.
- Continued the fade's opaque endpoint through the bottom safe area. An intermediate explicit-height version exposed content beneath the gradient; the final version covers that region.
- Kept the existing clear glass and tint. A regular-glass probe worsened the comparison and was removed. Light-mode material and fade values were retained.
- Added a matched-transcript scroll test for both appearances, including fixed chrome position, actual transcript movement, return to latest, keyboard focus/dismissal, six-line drafts and a pixel assertion that content does not reappear below the dark fade.

## How the comparison was made

The original September 21 recording supplies 126 actual frames from 9.6–11.7 seconds. A loopback fixture reconstructs the visible conversation text so the same glyphs and bubble geometry move behind our controls. This is inert text; no instructions from the recording are executed and no real bots are contacted.

Both recordings use a 440×956pt canvas. Two text templates register message position, with at most 1pt displacement difference for accepted pairs. Keyboard frames, low-confidence matches and avatar pixels are excluded. Source frames are cropped for the gallery without repainting, warping, synthetic interpolation or color correction. Different dates and status bars remain visible in the full screenshots.

The blank user-bubble strip beside each control measures the **backdrop fade**, separately from the glass. Samples inside the controls measure **rendered brightness above each recording's own canvas**, which combines tint, blur, refraction and the faded backdrop. Those measurements are not a recoverable source opacity: multiple material configurations can produce similar compressed pixels.

The native PNG canvas remains `#141414`, matching the decoded reference's 20/20/20 page. The native H.264 recording encodes that canvas near 18/18/18, while both recordings put the unfaded user bubble near 82/82/82. Small encoded-color differences must not be mistaken for a change to every source color.

## Evidence and remaining differences

[Backdrop profiles](/Users/raghav/OpenBot/output/glass-validation-0921/fade-profiles.json) and [common-position measurements](/Users/raghav/OpenBot/output/glass-validation-0921/common-position-metrics.json) preserve the numeric evidence. The latter uses only reference positions available in all compared variants, avoiding a favorable change in sample selection.

The corrected fade is substantially closer over the sampled transcript. The header's refracted highlights and some interior glass patches still differ. This pass therefore does not certify identical glass shaders, overall opacity or all colored/image backdrops. The reference device's precise OS/material/accessibility settings are unavailable; the test simulator is iOS 26.5 with Reduce Motion disabled. There is no supplied matched light-mode motion recording to establish light-mode pixel parity.

| Measurement | Before | Corrected |
|---|---:|---:|
| Bottom backdrop profile, mean absolute decoded-gray error | 15.39 | 1.32 |
| Header backdrop profile, mean absolute decoded-gray error | 3.70 | 0.97 |
| Lower composer glass patch, mean absolute contrast error across 14 common positions | 5.29 | 1.50 |
| Header glass patch, same common positions | 14.00 | 12.64 |
| Central composer glass patch, same common positions | 1.68 | 4.18 |

These are 8-bit gray-level differences, not opacity percentages. The profile measurements use the matched 11.010s reference position: x320–368pt/y95–160pt for the header and x414–416pt/y855–910pt for the bottom. The interior-glass comparison exposes a tradeoff: correcting the backdrop improves the lower ghosted-text region but makes the central composer patch a little darker than the reference. A global tint adjustment would also change resting controls and other backdrops, so it was not used to conceal this residual difference. The regular-material probe was worse at both composer patches and the header.

The exact old React Native setting was also tested: `chat-appearance.ts` supplies white at 0.056 alpha to interactive clear glass. Using that value in Swift increased the lower-composer error to **8.21**, the center error to **5.71**, and the blank back-button error to **4.43**, across the same 14 positions. It was rejected and the validated neutral tint restored. [Probe measurements](/Users/raghav/OpenBot/output/glass-validation-0921/react-native-tint-result.json). Copying the tint number between these two native implementations did not reproduce the same rendered result.

## Validation

See [test-ledger.json](/Users/raghav/OpenBot/output/glass-validation-0921/test-ledger.json) for the final results. **95 core tests and all 29 selected UI cases passed** in their latest applicable runs. This includes 13 video-parity cases and 16 navigation, keyboard, rich-content and long-history cases, with moving glass/widget layout rerun after making the fade follow the composer height. The earlier real VNC verification is documented in the preceding report; this pass does not repeat physical-device APNs, OAuth or live transcription certification.

The 1,000-message workload passed all three measured iterations. Scroll-drag/deceleration duration averaged 2.484s (previous pass: 2.506s), peak physical memory 102,916kB and CPU time 4.078s. The larger 18.400s wall-clock metric includes XCTest's gesture/hierarchy overhead. There is no stored performance baseline or physical-device frame-rate measurement; these figures are workload observations, not a 60/120fps guarantee.

The initial glass test assumed the return-to-latest button would remain visible after every drag; the last drag had already reached the bottom. That test assumption was corrected. The regular-material probe and overly dark first fade adjustment remain in the evidence folder so their rejection is reviewable.

All owned fixture processes are stopped after each run. Unrelated servers, devices, source changes and robot artwork are preserved. No release upload is part of this validation pass.
