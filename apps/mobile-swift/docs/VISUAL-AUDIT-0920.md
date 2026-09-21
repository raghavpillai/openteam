# OpenTeam iPhone vs GrokBot — visual and motion audit

Audit date: September 20, 2026. **The app is not yet visually one-to-one.** Basic chat geometry is close; the largest remaining differences are the thinking robot’s optical size, loader collapse timing, native menu appearance, Markdown list spacing, completed widgets, and settings/profile layout.

This is an analysis pass, not an implementation or release. Native application sources were held unchanged. Fresh captures use the current source on an iPhone 16 Pro Max simulator running iOS 26.5, at 440 × 956 points / 1320 × 2868 pixels, with Swift optimization enabled. Tests use disposable HTTP loopback fixtures. They do not establish live Google authorization, physical microphone quality, push delivery, Tailscale reachability, or hardware frame rate.

The accompanying evidence lives in `output/visual-audit-0920/`: `index.html`, `references.json`, `capture-manifest.json`, `pairs.json`, original recordings, XCTest result bundles, geometry measurements, motion curves, and frame strips. The HTML gallery is the easiest way to inspect it.

## How the comparison was made

- Inventoried **60 distinct reference files by hash**. This includes repeated states, crops, and resized copies; it is not 60 different screens. Some historical originals are unavailable, so their preserved comparison copies are explicitly identified.
- Decoded all **1,961 frames** of the supplied GrokBot recording at their original presentation timestamps. Inspected the full sequence: typing, sends, thinking, replies, keyboard changes, navigation, voice recording, transcription, and profile entry. Matched the second send/thinking/reply cycle to a fresh native recording using the same message content.
- Captured fresh dark/light states for chat, menus, attachments, settings, plugins, profile, creation, search, groups, launch, authentication, and routines. Tests establish behavior; screenshot inspection establishes visual findings. One does not substitute for the other.
- Compared complete frames at a common 440-point width without repainting status bars, changing colors, stretching aspect ratios, or aligning unrelated content. Some pairs intentionally compare the same component with different conversation data; those are not full-frame pixel comparisons.
- Measured solid-color interiors separately from native materials. Older 589-pixel JPEGs carry roughly ±1 point of edge uncertainty and JPEG/color-encoding error. Menu bounds inspected manually have approximately ±2-point uncertainty.
- Measured motion using an **already-visible bubble’s edge**, rather than the newly appearing bubble’s changing opacity. Charts and comparison clips align each event at 5% of its travel and preserve real elapsed time. There is no time stretching.
- Kept OpenTeam’s existing robot artwork as a separate issue from placement. Matching its optical occupancy does not require silently replacing its character system with GrokBot’s artwork.

## Highest-priority findings

| Priority | Finding | Evidence and implication |
|---|---|---|
| High | Message layout emits Dynamic Type warnings | Fresh XCTest reports say DynamicTypeSize and CGFloat environment values are read outside an installed view and will remain at defaults. `BubbleTextLayout` declares `@ScaledMetric` inside a `Layout`; it is a strong source candidate. Default-size screenshots can pass while accessibility sizing is wrong. |
| High | The thinking robot reads smaller | Visible teal artwork is about **22 × 23 pt** in OpenTeam versus **29 × 24 pt** in the reference; median colored area is **344 vs 477 square points**, about 28% less. Native has a 32-point layout frame, but the artwork leaves more empty space inside it. Normalize visible bounds and baseline by character before changing the footer height. |
| High | Thinking collapse is slower | The middle 90% of the 64-point collapse takes **208 ms vs 150 ms**. This is the strongest measured motion mismatch. Expansion is much closer. Tune collapse separately from appearance and message arrival. |
| High | Dark menus do not look like the reference | The home creation menu is visibly darker and displaced; a blank interior patch is approximately **RGB 30 vs 49**. Its position is about **21 pt left and 20 pt down**. The photo menu is also darker and displaced. These differences persist beyond simply having different text behind glass. |
| High | Completed choice widgets lose their visual structure | GrokBot retains the Alpha/Beta/Gamma rows and green checks. Native renders the raw answer text (`alpha`, `beta`, `Gamma`) in a much smaller card. Confirmed with a fresh matched-prompt fixture and the `respondedValue` branch in `RichMessageCard.swift`. |
| High | Markdown lists have different vertical rhythm | Native tight-list items have little separation; the reference has more breathing room between bullets. Inline-code metrics and wrapping also differ. Plain-message spacing passing does not establish Markdown parity. |
| High | Settings and plugins remain structurally different | Native forms are usable but are not the reference compositions. Settings adds a title and rearranges controls; plugins uses generic grouped rows and long detail forms instead of the branded catalog and compact connection sheet. |
| Medium | Character picker colors differ | The mismatch is in the actual swatches, not just glass. Blue, green, brown, orange, pink, gray, and the first neutral choice differ. See the color table below. |
| Medium | Close symbols are too large | Photo viewer close artwork paints **16 × 16 pt vs about 13.7 × 13.7 pt**, roughly 17% larger. Keep the 44-point hit target while correcting the symbol. |
| Medium | Creation/profile spacing and grids differ | Native creation has 12 character choices in three rows; the reference has eight in two. Profile uses a different column count and swatch spacing. These change the whole page’s rhythm. |
| Medium | Large-text authentication is reachable but cramped | At the tested accessibility text size, “Connect” truncates during the server stage and the credentials card requires scrolling to read all helper text. Reachability assertions pass; visual polish does not. |

## Measured chat motion

The table reports the interval from 5% to 95% of the recorded displacement, not total request latency or the duration literal in source code.

| Event | GrokBot travel | Native travel | GrokBot 5–95% | Native 5–95% | Assessment |
|---|---:|---:|---:|---:|---|
| Send lifts existing history | 96 pt | 96 pt | 216.7 ms | 228.3 ms | Close, not numerically identical |
| Thinking area expands | 64 pt | 64 pt | 200.0 ms | 196.7 ms | Close |
| Reply lifts existing history | 52 pt | 52 pt | 200.0 ms | 221.7 ms | Slightly longer native movement |
| Thinking area collapses | 64 pt | 64 pt | 150.0 ms | 208.3 ms | Clear mismatch; approximately 39% longer |

The native recording has a **132 ms bracket between the last unchanged frame and the first changed frame at reply insertion**. That does not prove a 132 ms app stall: the recorder can omit unchanged frames. It prevents a precise claim about insertion onset. The 5–95% measurements occur after that bracket. Likewise, a static 500 ms gap in the reference recording is not a dropped-frame diagnosis.

The corrected frame strips are aligned by movement phase. A prior-onset alignment would falsely make the native reply appear to pause before moving; it is not used for the comparison conclusion.

| Motion/state | What is established | Remaining difference or limit |
|---|---|---|
| Outgoing bubble entrance | Native fades and moves a new bubble upward; the animation has not disappeared. Source uses opacity, 12 pt offset, and 0.94 initial scale. | The precise bubble/composer-control exchange is not identical. An opacity-sensitive bounding box is unsuitable for judging the first frames. Compare the event-aligned video visually. |
| Loading expansion | Height movement is approximately the same amount and duration. | Small step patterns in a quantized edge trace are not by themselves evidence of visible jank. |
| Thinking character loop | Both references and native animate a character. | Native uses its own face/part motion and silhouette; optical size and choreography are not a copy of the GrokBot blob. |
| Reply insertion | Existing history moves 52 pt in both recordings. | Exact appearance onset is limited by the capture bracket above. Native movement’s middle 90% is about 22 ms longer. |
| Loading disappearance | Footer collapses rather than disappearing without resizing. | Native has a longer tail. Source coordinates footer resize and a display-link scroll; changing one duration alone may not synchronize both. |
| Latest/down control | Fresh tests show appearance, return to latest, and disappearance; source applies opacity, scale, and 8 pt offset over 220 ms. | No directly matched GrokBot onset/exit clip exists for this particular control. Its 36-point visible/frame size should have a separately expanded hit target. |
| Keyboard open/close | Fresh transitions exercise taps in the composer and outside it, short and multiline drafts, and movement back to the latest message. | OS keyboard height, prediction state, and language must be held constant before attributing a 1–3 pt offset to the app. |
| Multiline composer | Native expands and collapses; the four-line send is exercised in the transition recording. | A newline uses a different vertical padding branch. Line-wrap, explicit-newline, attachment, and reply transitions should share a continuous height policy. |
| Profile entry | Native navigation pushes from the right and supports interactive edge back. Fresh Glass tests pass. | The reference clip shows the same direction, but no exact velocity/easing equivalence is claimed. |
| Section and chat menus | Native menus open; rename/collapse/delete section behavior is exercised. | Lifted preview placement, backdrop dimming, menu size, and menu items differ. |
| Photo/file presentation | Native full-screen gallery and file sheet work; paging, zoom, forwarding, and native sharing are exercised. | There is no supplied clip of the opening/closing transition. Source has no explicit thumbnail-to-viewer matched-geometry transition; still images cannot establish what GrokBot does in between. |
| Recording | Fresh synthetic voice flow covers recording, stop, failed transcription, retry, and draft population. Three-pill geometry is close. | Native waveform varies across bars; the supplied still has a flatter band. Real microphone input and ASR latency are not measured by the synthetic fixture. |
| Launch | Robot and shadow fade to the app; foregrounding does not replay the overlay. | The launch tests deliberately delay bootstrap. Their long spinner dwell is not a production startup measurement. A light system launch frame before a forced dark QA appearance is also not automatically a production flash. |
| Auth background | Floating bots and stage transitions are present in dark/light captures. | This restores the old React Native composition; no GrokBot sign-in recording was supplied. It must not be called verified GrokBot auth parity. |

## Sizing, padding, typography, and controls

| Component | Reference / native observation | Result |
|---|---|---|
| Chat outer message inset | 16 pt in the matched fixture | Close |
| Wrapped plain bubble width | 364 pt in the matched 440-point viewport | Close |
| Plain bubble heights | Four-line prompt 106 pt; single-line reply 40 pt; three-line reply 84 pt | Close |
| Plain-message spacing | Approximately 12 pt between speakers and 8 pt between successive bot messages | Close; do not use Markdown differences as a reason to enlarge every gap |
| Plain body text | Native system body text; line geometry matches the controlled plain-message example | Close at tested text size; not all Dynamic Type sizes |
| Resting composer | Reference approximately `[84, 881.3, 326, 45]`; native `[84, 882, 326, 44]` | Within older-image uncertainty |
| Two-line explicit-newline composer | Reference approximately `[72, 510, 350, 82]`; native `[72, 513, 350, 80]` | Small vertical difference; native keyboard boundary is also lower |
| Plus symbol | Existing calibration is approximately 16–16.3 pt painted width | Not currently the oversized control it was previously; do not shrink its hit area |
| Chat back symbol | Reference about 8.3 × 15 pt; native 8.7 × 15.3 pt | Close within JPEG/edge uncertainty |
| Send control | Native 36 × 28 pt visible pill inside a 44 × 44 target; arrow 16 pt semibold | Shape close to still references; fill/pressed-state and exchange with the microphone need further matching |
| Empty composer actions | Older stills show the microphone; the later video includes a second white waveform control | Reference-version/state difference. Native has the microphone, not the two-control video composition |
| Header centering | Fresh short, long, two-member, five-member, and 12-member group cases remain centered in both themes | Verified behavior; artwork is still different |
| Long title | Native truncates within space reserved between the side controls | Correct approach; not a guarantee for every localized title |
| Header and composer backdrop | Both allow scrolled content behind them | Same concept, different rim, tint, and fade response in some states |
| Latest control | 36 × 36 pt source frame; 16 pt chevron | Visual size approximately reference-like; expand hit area independently |
| Recording stop pill | Reference about 106.3 × 49 pt; native 107.3 × 48 pt | Close |
| Recording timer pill | Reference about 148 × 49 pt; native 145.7 × 48 pt | Native approximately 2 pt narrower |
| Recording submit pill | Reference about 107.3 × 49 pt; native 107 × 48 pt | Close; native arrow reads heavier/larger |
| Contextual reaction sheet | Both use a native-looking bottom sheet with two emoji rows and action groups | Native action rows start higher, use different icon shapes, and lack the reference’s exact row padding/inset separator treatment |
| Reaction choices | The emoji set largely matches the supplied action sheet | Do not treat emoji glyph rasterization across OS builds as app padding |
| File cards | Both show archive icon, filename with muted extension, size below, rounded dark card | Filename type metrics produce different widths across filenames. Compare intrinsic content width, not a single fixed card width |
| Inline photos | Native max 260 pt width, proportional height, 16 pt corners; the supplied landscape example fits that scale | Close for the supplied aspect ratio; portrait/very tall images are not covered by that reference |
| Photo viewer | Black canvas, centered image, bottom caption, thumbnail filmstrip, selected thumbnail, close and menu controls are present | Large geometry is close; close glyph and menu remain different |
| File preview | Filename in top bar, close/share, centered unsupported-file icon and explanation | Close overall; share symbol and close weight differ; native file-type capabilities are not inferred from the ZIP example |
| Search | Row label inset and approximately 80-point row rhythm are close in the paired light screen | Toolbar shadow/material, filter glyph, avatar occupancy, and a few points of top offset differ |
| New group | Same search-and-select structure, keyboard, and Next action | Native field is slightly lower; icon occupancy, selection row ordering/data, and header spacing differ |

## Color and Liquid Glass analysis

**A gradient behind a control is only part of the explanation.** The rendered result combines the page color, actual scrolled content, top/bottom fade overlays, blur/refraction, tint, adaptive rim/shadow, and the system’s accessibility settings. A tint alpha in code is not the overall opacity of Liquid Glass.

The solid dark page is **#141414 in both** measured samples. Native dark cards/assistant bubbles use **#202020**, and the gallery uses **#000000**, which matches the reference’s black viewer. The light palette uses **#FCFCFC** canvas and **#F2F2F2** cards. Native dark outgoing bubbles use **#545454**, following the later recording. Some older screenshots are closer to **#5C5C5C**; treating both generations as one exact target would create contradictory changes.

In the same-content draft frames, a lower blank composer patch measures RGB 47 in the reference and 45 in native, but their encoded page backgrounds measure 20 and 18 respectively: both patches are 27 levels above their page. That sample is close after accounting for the recording-level offset, not evidence for a large opacity change. The single-frame send fill is much farther apart (approximately 202 vs 253); pressed/typing state needs to be held constant before changing its default fill.

Native chat controls use clear glass with a neutral tint; other chrome uses regular glass, and SwiftUI menus use the system menu material. This explains why matching the message bar does not automatically fix the account button, context menu, file close button, or plugin sheet. The same material configuration is not currently used everywhere.

| Surface/state | Finding |
|---|---|
| Empty dark chat canvas | The background itself is no longer the main mismatch. |
| Chat glass over no content | Close in broad fill and size; compare rim and lower gradient separately. |
| Chat glass over messages | Backdrop changes are expected. Pairs with different message positions cannot produce a meaningful global opacity score. Use the same-content motion frames for this judgment. |
| Home creation menu | Reference interior about RGB 49; native about RGB 30 in documented blank patches. This is a visible material difference, not just a different word behind the menu. |
| Photo menu | Native is darker on an already black canvas. Its position is about 10 pt left / 6 pt down; width and three-row structure are similar. |
| Held-chat backdrop | Reference darkens much of the page and lifts a compact row; native leaves a different surrounding treatment and positions a shorter menu nearer the center. |
| Light chrome | Native button shadows and edges appear more pronounced in search and settings. The photos do not reveal the reference’s Reduce Transparency or contrast settings. |
| Muted labels | Chat uses translucent semantic labels, while generic forms use fixed palette colors. A matching RGB value on one background need not match on another. |
| Destructive actions | Native Re-auth is red as requested; native held-chat “Hide” is neutral in the captured menu, while the reference shows red. |
| Keyboard side/corner gutters | Fresh dark/light captures of sign-in, search, creation, and profile extend the app backdrop behind the keyboard. A uniformly black gap is not reproduced here. VNC and the photo viewer intentionally use black. |

The character picker swatches below are sampled from flat interiors in the paired profile screen. Older JPEG values are approximate; the native values are not merely JPEG noise away from the reference.

| Swatch | GrokBot sample | Native sample |
|---|---|---|
| First neutral | #FFFFFF | #242424 |
| Brown | #91643A | #A47952 |
| Red | #FF243D | #F23D52 |
| Orange | #FC6902 | #FF7A1A |
| Yellow | #FF9800 | #FF9E12 |
| Green | #01C971 | #10B972 |
| Teal | #00BBA6 | #27BAAE |
| Blue | #1084FF | #4B8EFB |
| Purple | #9259FE | #925DF2 |
| Pink | #FF309C | #EF479B |
| Gray | #777777 | #878787 |

These are the desktop-shared artwork choices. Changing them globally is a product decision; it should not be hidden inside an opacity adjustment. Existing selected bots in fixtures can also have colors different from the picker defaults.

## Inbox, sections, and groups

| Area | Finding |
|---|---|
| Unsectioned inbox | The “Unassigned” heading is absent when no sections exist. Fresh tests include stale collapsed state and orphan section assignments. |
| Section long press | Rename, collapse/expand, and delete section work in the fixture; deleting the section preserves conversations. No supplied full section-menu reference proves exact menu-item or padding parity. |
| Empty section | Native uses low-key “No chats” text. It is no longer a dominant empty illustration in this state. |
| Home creation menu | Same two actions, but native menu position and dark fill differ. Approximate bounds: reference `[182,62,250,104]`; native `[161,82,250,104]`. |
| Held conversation | Reference shows Mark Unread, Pin, Move to, Share as Template, Hide, More, and an OS Ask Siri row. Native capture shows Mark unread, Pin, Move to, Hide. Some capabilities exist elsewhere, but the contextual UI is not identical. Ask Siri depends on the OS and is not an app-owned feature to counterfeit. |
| Group list cluster | Native has the diagonal pair / three-member cluster and +N overflow with contour cutouts. Its own robot artwork leaves different visual gaps. |
| Group header strip | Native shows up to three members with +N and stays centered. Separate checks cover +2 and +9 in light/dark. |
| Custom avatar handling | Source loads member photos and cuts around circular photos separately from drawn robots. Fresh default-artwork captures do not validate every custom-photo mixture. |
| Unread marker | Both have a small blue indicator. Exact position varies with row data and grouping; it should be compared per matched row. |
| Group desktop destination | Source selects the most recent responding bot and preserves an already-open desktop session. The source path is reviewed, but this audit does not re-certify an actual remote desktop. |

## Settings, profile, plugins, routines, and authentication

| Area | Finding |
|---|---|
| Settings presentation | Native sheet and navigation are real native UI. Account and Plugins are reachable in fresh tests. Being native does not make the composition the same. |
| Settings title | Native adds “Settings”; the supplied reference top is untitled. |
| Settings card geometry | Account card starts about 15 pt lower in the dark reference pair; native form cards are approximately 5 pt more inset. Cards are now on the shared surface palette. |
| Settings hierarchy | Reference places Usage/update and Auto-review/time zone/computer prominently. Native places bot notifications, hidden conversations, appearance/haptics, and More preferences differently. Email/org versus server/self-hosted labels also reflect different product data. |
| Account/Re-auth | Fresh account capture shows stored owner information and red Re-auth. The separate Sign-in/Change server actions are absent as requested. Destructive clearing behavior is outside this visual-only revalidation. |
| Haptics preference | Toggling and persistence passed when the test targeted the switch thumb. This says nothing about physical vibration strength. |
| Character creation | Native’s 12 shapes occupy three rows, versus eight in two in the reference. Native name field sits slightly higher; color rows sit lower due to the added shape row. |
| Bot profile | Native profile art appears smaller; character grid has a different column count; corners are rounder in several cards. Instructions, routines, notifications, and template share are present. |
| Removed mobile features | The captured profile has no Memory entry and no extra personality controls. Source still having a model/helper does not mean it appears in the mobile navigation. |
| Routine list | Native rows are taller (roughly 78 vs 70 pt for one-line schedule rows), and the clock glyph differs. The reference’s mixed schedule strings are not reproduced by a fixture that deliberately assigns identical weekday schedules to all rows; that is not proof of a formatter bug. |
| Routine editor | Native dropdowns and natural-language summaries are exercised for weekly, monthly, hourly, and interval cases, including retry/reopen. The supplied reference only shows the routine list, so exact editor parity is unknown. |
| Plugin catalog | Native grouped Installed/Discover rows lack the reference catalog’s branded row composition, Featured/Team structure, and installed badge placement. Large remaining visual gap. |
| Plugin details | Reference shows a compact icon/title/summary/connectors panel and bottom Retry button. Native shows a longer connection/configuration form with additional metadata and actions. Large remaining visual gap. |
| Plugin error recovery | Installation failure/retry, repeated-connect deduplication, auth return, and uninstall cancel/failure/retry are exercised on fixtures. A failed uninstall expands inline error content and moves the retry farther down; it remains usable after scrolling. |
| Real OAuth prompt | The supplied Google/iOS consent prompt is not recreated by a synthetic fixture. Current Google authorization and expiry are not asserted by this visual audit. |
| Welcome/server/credentials | The animated bot background is restored and dark/light fields are usable. The requested “Digital workers…” copy is present and the redundant “Server address” label is absent. |
| Authentication parity target | Available old RN composition is the appropriate reference; GrokBot authentication was not supplied. Current HTTP helper copy and server-specific identity are product differences. |
| Large accessibility text | Buttons remain reachable, but the Connect label truncates in the recording, and the card/helper content is cramped. Add a stacked action layout and verify scrolling/readability rather than relying only on hittability tests. |

## Rich messages, media, and computer coverage

| Area | Finding |
|---|---|
| Plain Markdown paragraphs | Bold, inline code, links, and lists render; body typography and wrapping are not identical for the same long Markdown passage. |
| Markdown lists | Native CSS uses tight list spacing and a different inline-code treatment. The reference’s bullet rhythm needs its own calibration. |
| Tables, math, Mermaid, code | Fresh dark/light document captures exercise the offline renderer. No equivalent supplied GrokBot examples establish exact output parity for these formats. |
| Pending choice widget | Native uses separate bordered options, custom-answer input, Submit, and Dismiss. The reference screenshot is a completed widget, so pending layout cannot be called a direct match. |
| Completed choice widget | Definite mismatch: reference preserves labeled rows/checks, native displays raw values and shrinks the card. |
| Forms, approvals, credentials, external drafts | Native has dedicated cards and receipts in source. Their typography, loading/error states, and transition behavior need matching GrokBot reference states before one-to-one claims are possible. |
| Message action sheet | Reply, start thread, unread, copy, and reactions are available. Icons, group insets, dividers, and top spacing still differ. |
| Swipe reply / edge back | Native reserves the left edge for back navigation; inside-message swipes produce replies. Fresh message tests exercise reply behavior and Glass tests exercise interactive profile back. A still screenshot does not establish velocity thresholds or haptic timing equivalence. |
| Attachment menu | Reference says Attach Image, Take Photo, Choose File. Native captured menu says Record voice note, Files, Photo library. Camera availability is hardware-conditional, so simulator absence is not proof of missing camera support. |
| File preview/share | ZIP fallback and native share sheet work in both themes. Filename centering, close weight, and share symbol need final calibration. |
| Photo viewer actions | Forward, Share, Save are present. Paging, zoom, and forwarding preserve the existing draft in the fixture. Actual Photos permission/save success is not asserted by showing a menu. |
| Photo menu location | Reference approximately `[182,62,250,146]`; native `[172,68,250,146]`. Material and anchoring both differ. |
| Computer startup | Source uses an Apple spinner plus “Starting desktop…” on black, matching the supplied state concept. |
| Computer canvas/keyboard | Source preserves remote aspect ratio, centers the framebuffer, and places clipboard/keyboard controls below it. Header/control dimensions can be reviewed, but this pass did not run a new live VNC desktop. |
| Computer gestures/reconnection | No new claim: click, drag, pinch, two-finger scrolling, keyboard events, takeover expiry, and reconnect need the actual RFB/live-server test environment. Old HTTP screenshot fixtures are not valid substitutes for that path. |

## Performance and accessibility assessment

Native history uses reusable `UITableView` cells, a diffable data source, an 80-item display window, and measured row heights. This is a substantially better basis for long chats than constructing every SwiftUI/Markdown view in the transcript. It does not prove smoothness on its own: asynchronous WebKit sizing and window recentering can still affect anchors.

All four fresh long-history cases passed. The measured three-sample averages were:

| Workload | CPU time per six-drag workload | App peak physical memory | Existing targets |
|---|---:|---:|---|
| 1,000 text messages | 4.644 s | 87,427 kB | CPU ≤6 s; app memory ≤180,000 kB |
| Mixed rich documents | 5.271 s | 117,263 kB | CPU ≤6 s; app memory ≤180,000 kB |

Both were under the numerical repository budgets. This run uses optimized Debug and was not on a dedicated idle hardware lab, so it is not a controlled before/after improvement claim. App memory excludes WebKit subprocesses. Details are in `performance-metrics.json`, `Performance-summary.json`, and the result bundle. The cases cover 1,000 text messages, mixed rich documents, composer taps after window changes, and arrival while reading earlier history. Simulator XCTest duration includes automation waits and cannot be reported as iPhone scroll FPS. No physical 60/120 Hz, thermal, battery, memory-pressure, or network-stall guarantee is made.

Additional limits and review items:

- Repeat the strongest scenarios on a physical iPhone with Instruments and the actual release build. Keep screen recording off during hardware hitch measurements, then record a separate visual run.
- Test narrow phones, landscape, long localized labels, right-to-left text, custom keyboards, and portrait/large attachments. The supplied 440-point reference does not establish these layouts.
- Reduce Motion handling exists in message arrival, loader/robot, launch, and auth code. It is not a substitute for a fresh system-level accessibility pass. Reduce Transparency and Increase Contrast also affect native material appearance.
- Expand small hit targets without enlarging the artwork: the Latest control and small reply-dismiss controls deserve particular attention.
- Test VoiceOver reading order, reaction labels, changing status announcements, and form errors. A screenshot cannot validate them.
- Physical haptics, push notification dismissal, live transcription accuracy, remote VNC input, and real authentication remain separate functional checks; visual similarity cannot certify them.

## Validation receipt

**49 unique UI test cases passed in their final runs**, across 51 executed cases including two corrected retries. The initial incorrect group scheme executed no tests and is tracked separately. There are 43 comparison images and more than 160 native screenshot states, plus raw video and accessibility trees. This count is coverage evidence, not a claim that every app feature or every pixel passed.

**Runtime warnings remain despite passing tests.** Chat/mixed-document cases report environment values being read outside an installed view. In particular, the DynamicTypeSize/CGFloat warnings state that defaults will be used and will not update. The `@ScaledMetric` inside `BubbleTextLayout` needs investigation and a targeted large-text line-height test; passing fixed-size screenshots does not clear it. A separate “Invalid frame dimension (negative or non-finite)” warning appears in seven profile/routine-related cases. The exact source is not yet isolated; it is not cleared by a successful screenshot. See `runtime-warnings.json`.

## Test issues distinguished from app issues

The initial group run used the nonexistent `GroupAvatar` scheme; rerunning the correct `GroupAvatars` scheme passed. No group app failure occurred there.

Two original settings tests failed. The haptics test tapped the middle of a form row rather than the switch thumb and still looked for a removed `sign-out` control. The uninstall test asserted a lazily mounted button existed after the error had pushed it below the fold. Both passed with corrected interactions, and the widget capture also passed. The temporary test/fixture edits were saved as `audit-test-support.patch` and restored afterward; they are not product changes.

The fixture endpoints and simulator belonged to this audit. The local server on port 8787 and unrelated desktop work were not modified. Source hashes and fixture cleanup receipts are retained with the evidence.

## Recommended implementation order

1. Resolve the message-layout environment warnings and verify Dynamic Type. Normalize optical robot bounds and tune the loader’s collapse/scroll synchronization. Keep the already-close 64-point expansion and ordinary message spacing.
2. Match same-content glass and menu states: creation menu, photo menu, held row, settings close, and reaction sheet. Separate material, backdrop fade, placement, and symbol weight.
3. Preserve completed widget options/checks; calibrate Markdown list spacing and code metrics with identical content.
4. Bring settings, plugins, profile, and creation grids into the chosen reference layout. Make the artwork palette decision explicitly because it is shared with desktop.
5. Finish accessibility sizing and large-text layouts, then perform a physical-device performance/interaction pass and the separate live-service checks.

Do not spend the next iteration randomly changing all chat padding or shrinking the plus again. The evidence points to specific component and state differences, not a uniform scale error across the app.
