# Screen geometry and motion pass — 2026-09-22

This pass compares the supplied GrokBot screenshots and dark/light recordings with the Swift app on an iPhone 16 Pro Max simulator (iOS 26.5, 440 × 956 points, 3× captures). Robot artwork is excluded. This is not an all-screen pixel-perfect certification.

Evidence: `output/screen-metrics-0922/index.html`, full-resolution captures, source snapshots, XCTest results, recordings, reference-source mapping and frame measurements. The gallery labels the native run used for every pair.

## Changes

- Home creation and photo action menus use the same native glass menu presentation as attachments. Menu panels are 250 points wide, with 42-point action rows and 10-point vertical padding. Home and photo menus anchor eight points from the trailing edge instead of opening too low/too far left. Photo glass tint is tuned separately for its black canvas.
- Menus animate in over 0.22 seconds and dismiss over 0.16 seconds, honor Reduce Motion, and preserve outside-tap, Escape, background and source-removal cleanup. Still references establish geometry, not an exact original spring curve.
- Bot profile cards now use 24-point side margins. Routine rows lose six points of redundant vertical padding; one-line rows measure about 69 points instead of 77. Footer typography and notification row height are adjusted.
- Home empty-section spacing loses 12 points of excess height. Section labels use the faint palette color and corrected vertical placement.
- Search has corrected magnifier size, text inset, header/list spacing and blue insertion caret; group result kind is “Group Chat.”
- Plugins changes from large grouped cards and bottom search to compact catalog rows, package-provided icons, category headings, an installed-count control and top search. Installation/authentication/account-access behavior remains in the existing detail flow. The search bar participates in the native floating scroll edge so moving content can show through its glass.

## Measured comparisons

Coordinates below are logical points after consistent normalization. JPEG references and rescaling limit precision to roughly one point; video RGB decoding can shift near-black values by two levels.

| Component | Reference | Native result | Assessment |
| --- | --- | --- | --- |
| Single-choice widget | 364 × 212 | 364 × 211.67 | Within 0.34 point |
| Multi-choice widget | 364 × 386 | 364 × 386.33 | Within 0.34 point |
| Completed choice card | 364 × 130 | 364 × 130.33 | Within 0.34 point |
| Home menu | about 250 × 104, x≈182, y≈63 | 250 × 104, x182, y63 | Corrected anchor |
| Photo menu | about 250 × 146, x≈182, y≈63 | 250 × 146, x182, y63 | Corrected anchor and darker tint |
| Profile section margins | 24 | 24 (previously 20) | Corrected |
| One-line routine row | about 69 | about 69.3 (previously 77.3) | Corrected |

Widget dimensions come from this pass’s Baseline capture; their production rendering was not changed afterward. Menu/profile geometry was measured after the corresponding changes, with final screenshots retained separately.

## Motion

The single-choice card finishes at 130 points in both recordings. From the first observed changed frame to within 0.5 point of its final height, the reference takes 200 ms and native takes 220 ms. Reference settles exactly near 233 ms; native near 232 ms. These are sampled observations, not proof of identical curves. Reference has a recording gap after 195.6017 seconds; native recording also contains duplicate presentation states. No device FPS claim is made.

The reference and native clips have different transcript offsets and subsequent scrolling, so absolute Y-position is not a valid isolated measure of the card’s resizing. `motion/collapse-comparison.png` plots component height; raw timestamps and bounds are in `motion-data.json`.

## Remaining differences / evidence limits

- Root Settings still differs in title placement, grouping and corner treatment. Account/server fields also intentionally differ for the self-hosted product. These must not all be dismissed as intentional visual differences.
- Profile group corners, clock symbol, some toolbar placement, and natural-language schedule wording (“On weekdays” versus “Weekdays”) remain different. Scroll offset and fixture data are not padding errors.
- Light-mode glass rims and toolbar button treatment are still visibly softer than the reference in some screens. The scrolled Plugins capture confirms backdrop visibility, but does not establish pixel-identical blur kernels.
- The plugin detail screen has functional coverage but lacks a matching supplied reference state for a 1:1 visual claim.
- Exact animation timing for photo/home menus cannot be established from still screenshots alone.
- Reference and simulator keyboard suggestions, status bars, account data, text length and bot art differ. Whole-screen pixel subtraction would conflate those with real geometry defects.
- Live production OAuth, physical-device haptics, APNs and real VNC are outside this visual pass. Tests use running local HTTP fixtures, not the user’s production server.

## Validation

Final run results and cleanup are recorded with the artifact bundle. Build failures during iteration (private-type visibility, SwiftUI type-check complexity and an iOS availability guard) were fixed before successful testing. A catalog retry test exposed a changed button label; the explicit Retry action was restored and rerun.

The first final authorization test also exposed a stale fixture: its OAuth connection omitted `oauthCallbackMode`, which now correctly selects the desktop-only path. The fixture was changed to `server` for the existing inert local browser-handoff scenario; production authorization code was unchanged.

### Final result ledger

| Run | Passed | Failed |
| --- | ---: | ---: |
| Baseline | 10 | 0 |
| Broader | 2 | 0 |
| Candidate2 | 5 | 0 |
| Catalog | 4 | 1 |
| FinalUI3 | 9 | 1 |
| FinalGlass | 5 | 0 |
| FinalSizing | 2 | 0 |

Across these runs, 21 distinct selected test cases have final recorded status: {'passed': 21}. Earlier failed runs remain in the evidence; they are not presented as successful runs. FinalGlass covers dismissal/keyboard/background cleanup and corrected OAuth handoff. FinalSizing repeats both-theme catalog capture and installed-list/search navigation after the last row-height change.

Final source snapshot differences: []. `git diff --check` was also run. No commit, push or TestFlight upload was performed in this pass.

The audit simulator was shut down; all seven owned fixture ports were verified free. All gallery links resolve.
