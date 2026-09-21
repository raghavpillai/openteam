# Second visual QA pass — September 20, 2026

This pass implements and verifies a focused set of corrections from [the exhaustive audit](VISUAL-AUDIT-0920.md). **The app is closer to GrokBot, but full visual parity is not established.** The remaining menu, settings/plugin composition, artwork, and profile warning findings are still open.

Evidence: `output/visual-polish-0920/index.html`, original XCTest bundles and recordings, `test-ledger.json`, `receipt.json`, `widget-geometry.json`, `display-link-summary.json`, and `collapse-filmstrip.png`. The prior audit remains an unchanged baseline. Changes are local; this pass did not commit, push, or upload TestFlight.

## Corrections and measured results

| Area | Change | Verification |
|---|---|---|
| Plain-message Dynamic Type | Resolve `@ScaledMetric` in a View, pass its value into the Layout, and avoid rounding a slightly taller scaled line into two empty line boxes. Pending and delivered text use the same wrapper. | Normal 40/84/106-point bubbles and 8/12-point message gaps still pass. A single line grows at the largest accessibility size without the excess empty line. The DynamicTypeSize/CGFloat environment warnings are absent from the rechecked chat cases. |
| Large chat title | Let the centered header capsule grow vertically with text; retain a 44-point minimum. | Largest-size capture shows the title inside the capsule. Default-size message-reference assertions still pass. |
| Thinking collapse | Restore the previous bottom offset before animating a footer resize, cancel the table's implicit offset movement, and share timing constants between the footer and controller. | Diagnostic traces exposed UIKit clamping to the new bottom before the old animation began. The correction preserves 64-point travel; both short and long chat checks pass. See the timing limits below. |
| Thinking robot | Render the existing artwork at 36 points within the same 32-point layout slot, with optical positioning adjusted. The row still changes height by 64 points. | Visible teal area rises from **344 to 437 square points**, versus **477** in the reference. Its left edge now measures **18 points**, matching the reference. It is still a different silhouette: native **24 × 27 points**, reference **29 × 24**. This improves visual weight, not artwork identity. |
| Completed choice widget | Resolve server values to labels in option order, retain custom answers, and render checked inset rows. Match the inset, check shape, and muted green. | The supplied three-choice card measures **364 × 184 points**; native now measures **364 × 183**, previously **152 × 129**. Dark/light UI checks pass. Unit tests cover label/value differences, ordering, duplicates, omitted values, empty responses, and multiline single answers. |
| Markdown lists | Add a half-em gap between sibling list items in both generated offline renderers; let rich-document font scaling follow SwiftUI Dynamic Type. | Fresh list comparison shows the added 8.5-point gap at default size. Offline table/math/diagram rendering and the rich-history tests pass. This does not claim all code typography or line wrapping is identical. |
| Close icon | Reduce the common xmark font from 21 to 18 points while preserving the 44-point button. | Painted photo-viewer glyph measures **13.7 × 13.7 points**, matching the reference; previous build measured **16 × 16**. File preview, gallery, forwarding, zoom, and native sharing tests pass. |
| Latest/down control | Expand the tap frame from 36 to 44 points and compensate the surrounding padding. | The 36-point visible glass circle stays at the same center. Return-to-latest and keyboard/send/activity checks pass. |
| Accessible sign-in | Stack Back and Connect/Sign in at accessibility sizes, reserve their height, and allow labels to take their required vertical space. | Connect is fully readable in the new capture. Largest-size sign-in completes against the disposable HTTP fixture. Default dark/light auth presentation tests also pass. Long helper text remains scrollable. |

The solid page and existing glass palette were not retinted globally. The measured dark canvas remains `#141414`; the dedicated completed-choice check now uses an approximate reference green rather than the brighter system toggle green. The native check's strongest sampled RGB is **85/153/120**, versus **83/155/118** in the older JPEG. JPEG sampling is not an exact source-color specification.

## Animation evidence and limits

The tested geometry retains **96 points of history travel on send**, **52 on reply**, and **64 for the thinking footer**. One earlier recording in this pass (`MotionFinal.mov`) captured the send's middle 90% in **216.7 ms**, matching the reference. That measurement is tied to that recording, not every run.

Further comparison showed that matching collapse duration alone left the early movement too slow. The final controller now uses a fast initial collapse with a gradual finish, fitted to the reference's edge trace. Its interpolated 5–95% command interval is **154.5 ms**, versus approximately **152.6 ms** for the interpolated reference video edge. These are different measurement sources, explicitly labeled in the graph.

The last simulator recording (`MotionCurve.mov`) omits frames during parts of the movements, including a **310 ms capture gap** during expansion and a **126.7 ms gap** during collapse. These missing samples prevent precise final visual timing claims. The frame strip retains those gaps rather than inventing intermediate frames. Neither the gaps nor the controller measurements alone establish physical display smoothness.

To investigate, the optional Debug flag `--trace-chat-layout` records numeric display-link samples in the app's temporary `chat-motion-diagnostics.json`. Samples contain elapsed seconds, **commanded scroll offset**, and target offset. They are buffered until a transition ends, include no message content, and are absent from Release builds. The recording-reference UI test enables this flag for repeatable diagnostics.

| Controller movement | Commanded travel | Interpolated 5–95% interval | Largest interval between callbacks |
|---|---:|---:|---:|
| Footer expansion | 64 pt | 205.1 ms | 20.0 ms |
| Footer collapse | 64 pt | 154.5 ms | 16.7 ms |

There were 18 expansion callbacks and 20 collapse callbacks, and both reached completion. This establishes regular app callback timing in that simulator run. It **does not measure physical iPhone frame rate, GPU presentation, or every message-insertion frame**. The comparison graph labels controller commands and video edges separately.

## QA results

- **20 distinct targeted UI cases passed in their latest runs**, across **33 executions**. The set includes seven long-history cases, text scaling, completed widgets, auth, media, keyboard behavior, profile navigation, and short/long activity transitions.
- **89 core tests passed.** These include the added widget-answer cases and existing delivery, history, artwork, and state tests.
- **72 screenshots** are retained, including intermediate investigations and before/after states. The gallery distinguishes selected comparisons from raw test captures.
- The final native sources match the diagnostic build's saved source hashes. All owned loopback fixtures were stopped. Concurrent desktop work was left untouched.

Two initial assertion failures were corrected and rerun: accessibility exposed text bounds instead of the padded widget-row rectangle, and an inactive footer element remained queryable despite being invisible. The corrected checks wait for layout, compare actual row spacing, verify the inactive activity is not hittable, and confirm the short message returns to its original vertical position. The full execution ledger preserves both initial failures and successful reruns.

Long-history measurements used the first optimized Debug build of this pass, before the final footer-only animation correction and accessibility line-box refinement. The rich-message renderer change was included. Seven performance/navigation cases passed. Measured app-process averages were:

| Scenario | App CPU time per measured sequence | App physical memory metric |
|---|---:|---:|
| 1,000 plain messages | 4.066 s | 100,338 kB |
| Mixed rich documents | 4.692 s | 117,891 kB |

Both are below the existing 6-second CPU / 180,000-kB budgets. Measurements exclude WebKit subprocess memory and are not hardware FPS measurements. The final short/long motion and layout cases were rerun after the later changes.

## Still open

1. **Profile runtime warning:** `Invalid frame dimension (negative or non-finite)` still occurs during profile-related navigation. The profile remains usable in the tests. Replacing the character grid and the invisible toolbar title separately did not remove it; both experimental changes were reverted. No root cause or fix is claimed.
2. **Native menu material and anchoring:** the home and photo menus remain darker and differently positioned than the reference. Matching the message-bar tint does not solve these system-menu differences.
3. **Settings, profile, and plugin composition:** title treatment, card placement, catalog/detail presentation, and character-grid structure still differ from the supplied captures.
4. **Robot identity and choreography:** the thinking character's visual mass is closer, but the preserved desktop artwork and its loop are not GrokBot's blob.
5. **Remaining typography/state comparisons:** Markdown code metrics, some contextual action-row spacing, recording waveform shape, and the video-version send/microphone controls need further matched-state evidence.
6. **Device/service coverage:** this was simulator QA against disposable loopback servers. Physical push clearing, actual haptics, microphone/ASR quality, live Google OAuth, Tailscale access, and real VNC were not re-certified here.
