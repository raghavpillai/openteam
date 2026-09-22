# Light, dark and reply validation — September 21, 2026

Follow-up: [the final critical pass](/Users/raghav/OpenBot/apps/mobile-swift/docs/HYPERCRITICAL-0921.md) corrects the light back-button tradeoff, replaces the cached-reply delay, and adds regression coverage for the production server's reply-parent chain. The measurements below describe this earlier pass.

This pass uses the supplied 18:19 light-mode recording and the earlier 01:08 dark-mode recording. [Open the comparison gallery](/Users/raghav/OpenBot/output/light-dark-reply-0921/index.html) for matching scroll positions, source timestamps, reply-transition frames and native-screen captures. Robot artwork is excluded and unchanged.

## Corrections

**Replies were being hidden from the main conversation.** The dark reference shows the user's reply and the bot's response in the main timeline, with a small, one-line link to the original message. The Swift client instead filtered out branched messages and exposed a reply-count button. The main timeline now includes those messages and pending sends. The compact link opens the focused reply page; consecutive bot responses do not repeat the same quote. Explicit replies, interrupted exchanges and new contexts remain identifiable.

Opening a reply whose original message is outside loaded history fetches its context without replacing the main history window. The return-position test checks that the visible reply stays within two points of its original position. Thread drafts, nested navigation, server reply metadata and retry identity are preserved. The previous tests that required replies to disappear from the main timeline were updated to assert the reference behavior, including reopening a reply after reconciliation.

Pending reply links now open the same focused context before delivery. Existing ordinary inline replies retain their original reply mode when reopened, so their already-posted responses are included rather than opening an empty fork page.

**Cached reply navigation briefly flashed a spinner.** Every actual recorded transition frame was inspected. The native page still slides in from the right and presents the keyboard after the push finishes. A 200 ms delay now suppresses the spinner for a reply page that finishes its initial layout immediately; slower loading retains the native indicator. Main-chat loading still uses an immediately visible, centered native spinner. Initial history remains hidden until positioned, preserving the earlier fix for jumping to the bottom after opening.

**The light header and transcript fade differed.** The light header now uses calibrated clear native glass over scrolling dark bubbles. The composer retains regular light glass: the experiment applying clear glass everywhere made its ghosted text and brightness less accurate. The full-width upper fade is stronger near the controls and falls away sooner. The bottom fade now begins above the composer, follows its changing height and continues through the home-indicator area in light mode as well as dark mode.

**Light user bubbles and Markdown markers differed.** The light user-bubble fill is now `#0E0E0E`, matching the new reference sample more closely than `#0A0A0A`. List markers are smaller and muted in both appearances; list indentation is now 1.5 em. These changes are shared by message and document rendering. The existing light page and assistant-surface source colors remain `#FCFCFC` and `#F2F2F2`; dark source colors are retained.

## Comparison method

The new video contains 2,127 decoded frames over about 47.4 seconds. Actual presentation timestamps were used: the median frame interval is about 16.7 ms, and some frames are held much longer. The file's nominal 120 fps metadata is not evidence of either app sustaining 120 fps.

The video covers launch/home, settings, plugins, search/keyboard presentation, a long direct-chat transcript scrolling under glass, computer entry and group chats. It does **not** show a new reply being composed. Reply creation, push/pop motion and main-timeline tracking were therefore checked against the earlier dark recording, including actual frames around 172.6–174.2 seconds and the main conversation around 186 seconds.

A loopback HTTP fixture reconstructs the visible light transcript. Its text is inert screenshot data; no instructions or workflows quoted in the recording are executed. The identical final line of the user message registers scroll displacement on a 440×956 point canvas. Matching positions are accepted within one point. Avatar pixels, status bars and dates are not scored. The report's Markdown was reconstructed from the rendered recording, so differences in unknown inline-code markup and line wrapping are not treated as a pixel-identical source fixture.

The fade is sampled on a blank bubble strip beside the header, outside the glass. Interior samples measure the combined material, tint, refraction and faded backdrop. They cannot recover a unique source opacity. Measurements compare contrast against each recording's own canvas because the HEVC reference and native H.264 recording use different range/transfer metadata. Native PNGs retain source colors; a roughly two-level video-encoding difference is not a reason to alter every palette color.

The gallery shows raw decoded frames, with uniform scaling/cropping only. The scroll-position explorer is not a comparison of gesture speed. The short reply comparison clip aligns transition onset and resamples playback to 60 fps; measurements and frame sheets retain original timestamps.

## Remaining visual differences

This is a closer implementation, **not a certification of identical Liquid Glass shaders**. The reference has different edge highlights and refraction, and some moving glyphs look less diffused. Native clear-glass and UIKit `UIGlassEffect` probes did not eliminate those differences; the less accurate variants were rejected and retained in the evidence folder. A lighter overall tint improved one region while worsening resting buttons or the composer, which is why the final treatment is evaluated per component.

The quantitative table and all candidate results are in [light-comparison.json](/Users/raghav/OpenBot/output/light-dark-reply-0921/light-comparison.json). They include unfavorable samples, rather than reporting only the best matching frame. The header backdrop profile improves independently of the remaining glass-refraction differences. Dark material and fade parameters are unchanged; a new matched-motion capture verifies their continued appearance.

Across 19 matched scroll positions, the mean absolute error in decoded contrast relative to each recording's canvas was as follows. Lower is closer; units are gray levels on a 0–255 scale, **not opacity percentages**.

| Sample | Before | Corrected |
| --- | ---: | ---: |
| Header interior | 23.21 | 19.05 |
| Computer-button interior | 25.47 | 10.32 |
| Back-button interior | 3.37 | 8.37 |
| Composer interior | 1.01 | 1.78 |
| Composer lower strip | 2.30 | 1.74 |

The separate header-fade profile error fell from 9.19 to 2.74 gray levels at the registered frame. The clear header improves the dark-content response, but the back button's pale resting fill is less accurate than before. That tradeoff and the remaining rim/refraction mismatch are visible in the gallery. These measurements do not justify claiming every component is now an exact match.

The original reply becomes visible slightly into the native push while the list finishes its initial layout. The spinner flash is removed, but this is not claimed to be frame-for-frame identical to the reference's already-visible root. Keyboard suggestion/Siri rows also differ between the reference device and simulator. The changes retain system navigation, keyboard transitions and accessibility behavior instead of replacing them with prerecorded motion.

## Validation and reproducibility

**97 core tests and 38 distinct selected UI cases passed** in their latest applicable runs. Repeated appearance loops and reruns are not counted as separate cases. The final palette run passed all five selected cases, including ordinary inline-reply context in both themes.

See [test-ledger.json](/Users/raghav/OpenBot/output/light-dark-reply-0921/test-ledger.json) for final applicable runs and case counts. Tests cover both appearances, moving glass, multiline composers, first-tap focus and outside dismissal, reply drafts, missing-root navigation, nested replies, edge-back gestures, reliable sending, widget resizing, Markdown/forms, group headers, theme changes across native forms, and a 1,000-message scrolling workload. Tests assert real destinations and persisted request metadata, not just a successful build. Haptic assertions verify emitted cues; simulator testing cannot verify physical feel.

The 1,000-message workload passed all three iterations. The dragging/deceleration signpost averaged 2.489 seconds; maximum measured peak physical memory was about 101.8 MB. The complete scripted workload averaged 18.415 seconds including XCTest interaction overhead. There is no stored performance baseline and these measurements are not a physical-device frame-rate guarantee.

The fresh tests use stateful local HTTP fixtures and a native simulator build. This pass does not renew physical-device APNs, real OAuth, live transcription or remote VNC certification. The computer surface in the light recording intentionally remains black; the existing computer view likewise forces its dark desktop presentation. Earlier live-computer evidence remains in the preceding audit.

One early clear-material run was interrupted by a full disk and is excluded from success counts. Only disposable DerivedData from completed releases with retained archives and IPAs was removed; the interrupted cases were rerun. A test selector that selected zero cases is also excluded. Rejected material probes are experiments, not accepted visual results.

Two cases in the initial regression run failed because raw-text selectors now matched both the original message and its new quote. They were changed to stable message/link identifiers and both retests passed. Investigating the pending-reply case also exposed the real link-routing gap described above; its fix was covered by the retry and reconciliation test.

The workspace contained unrelated changes, including plugin work committed during this audit. [Source provenance](/Users/raghav/OpenBot/output/light-dark-reply-0921/source-provenance.json) records the starting revision, final revision and hashes of files changed by this pass. Original reference hashes, every test result bundle, capture manifests and fixture cleanup receipts are under `output/light-dark-reply-0921/`. Owned fixture processes and the dedicated simulator are restored after testing. This validation pass does not commit, push or upload a new TestFlight build.
