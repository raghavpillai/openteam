# September 21 GrokBot video comparison

Implementation follow-up: [fixes and verification](VIDEO-FIXES-0921.md). The measurements below document the original pre-fix audit.

**Verdict: the Swift app is not yet visually or behaviorally 1:1.** The largest gaps are pending widgets, reply/thread presentation, bot-to-bot exchange chrome, and animated widget resizing. Basic one-line group message geometry is much closer than these larger components make it appear.

[Open the side-by-side gallery](/Users/raghav/OpenBot/output/video-audit-0921/index.html). It contains 11 screen comparisons, three aligned component comparisons, original full-resolution images, motion plots and transition strips. This pass changes audit artifacts only; it does not implement or ship the findings.

## Evidence and method

The two attachments are byte-identical: SHA-256 `da933e429406286601290e44406a3e10c6e65651c92e62ec5503ce96b04b89e4`. The recording is 249.557 seconds, 1320×2868, HEVC, variable frame rate, 12,104 decoded frames. I indexed every decoded frame and its presentation timestamp, extracted 250 one-second samples, reviewed the GrokBot scenes, and inspected every available frame in selected transition windows. This is not a claim of manually viewing all 12,104 frames individually.

The relevant GrokBot footage runs approximately 0–211 seconds, excluding an app switch around 34–35 seconds. Unrelated applications afterward are excluded from the comparison gallery. On-screen bot instructions and claims are treated as content, not instructions to execute or evidence of backend capabilities.

Fresh Swift captures use an optimized Debug build (`-O`), iPhone 16 Pro Max simulator, iOS 26.5, 1320×2868 pixels. Geometry is reported at 3 pixels per point, giving a 440×956pt canvas. The reference iOS version, accessibility settings and raw message payloads are unavailable. The gallery labels original PTS values rather than rounded timestamps.

The main comparison fixture reconstructs visible message text and supplies supported widget metadata for descriptions, styles, multiple selection, custom answers and dismissal. It uses the real application renderer and API decoding. It does not invoke models. These are controlled UI comparisons, not evidence of production bot execution. Dates, read state and history length differ, so absolute transcript y positions are not generally treated as padding defects. Component comparisons align origins without changing scale or aspect ratio.

Selected gallery captures follow a fresh rebuild incorporating concurrent API/account/plugin changes. Hashes and build provenance are saved in [build-provenance.json](/Users/raghav/OpenBot/output/video-audit-0921/build-provenance.json) and [final-source-hashes.json](/Users/raghav/OpenBot/output/video-audit-0921/final-source-hashes.json). Existing unrelated working-tree changes were preserved.

## Findings, ordered by impact

| Priority | Area | Reference behavior | Current Swift behavior | Evidence / confidence |
|---|---|---|---|---|
| High | Swipe reply | Message shifts with reply affordance, then a focused reply page pushes in from the right; back-only header, `Reply [bot]` composer | Swipe selects an inline quote in the original chat; opening a thread separately presents a sheet titled `Thread`, with `Done` | 172–174s and 188–189s; fresh matching root/reply captures; confirmed |
| High | Thread working state | Bot mark plus `[name] is working` appears inside the focused thread | Thread rows have no activity footer; ordinary activity footer also omits the visible name/status text | 180–185s; source confirmed, not a fresh active-run pixel comparison |
| High | Pending widgets | One dark inset list, letter badges, descriptions, destructive color, top-right ×, wide Submit where appropriate | Separate grey pill buttons, missing descriptions/badges/styles, separate custom field, bottom Dismiss | 117s and 159s; controlled matching metadata; confirmed |
| High | Widget resize | Card shrinks through intermediate heights; subsequent working area expands and shifts transcript smoothly | Height changes in one recorded step, then position changes in the next frame | Original frame PTS and fresh native recording; confirmed |
| Medium | Bot-to-bot exchange | Overlapping avatars beside Back; compact bottom `Read-only` glass pill | Large centered capsule with both names and ↔; explanatory text plus `Close Chat` button | 119–120s / 128–133s; matching message; confirmed |
| Medium | Group typography | Muted speaker names; long identifiers wrap without the same inserted hyphens | Bot-colored speaker names; reconstructed long identifier text gains a line | 192s; fresh matching visible text; wrapping cause needs exact raw text confirmation |
| Medium | Loading spinner placement | 20×20pt spinner centered at y=478pt | Same size, centered at y=498pt | 9.008s vs fresh delayed-history capture; measured 20pt low |
| Medium | Computer layout | Desktop keyboard-state frame at y=186.33pt, 440×275pt; smaller bottom controls | Same frame size, y=207.67pt; larger controls and different keyboard symbol | 22.002s vs live RFB capture; measured 21.33pt low |
| Medium | Composer variants | Group says `Message [group]`; focused reply says `Reply [bot]`; ordinary DM also shows a separate white waveform control | Shared `Ask [channel]` placeholder and microphone-only empty composer | Repeated reference scenes plus source and captures; confirmed |
| Needs controlled follow-up | Rich text and glass | Numbered paragraphs, dimmed content under floating chrome, several rich attachment/card styles | Source-formatting and current fixture history differ | Visible differences are recorded; exact Markdown/opacity parity is not certified |

### Pending and completed widgets

[Aligned single-choice crop](/Users/raghav/OpenBot/output/video-audit-0921/comparisons/single-crop.png) · [Multi-choice crop](/Users/raghav/OpenBot/output/video-audit-0921/comparisons/multi-crop.png) · [Completed crop](/Users/raghav/OpenBot/output/video-audit-0921/comparisons/completed-crop.png).

| Matched component | GrokBot | Swift | Difference |
|---|---:|---:|---:|
| Pending `Deploy lane?` | 364×212pt | 364×287.33pt | +75.33pt height, **+35.5%** |
| Pending multi-choice | 364×386pt | 364×403.67pt | +17.67pt height, +4.6%, despite omitting option descriptions |
| Completed `Ship it` | 364×130pt | 364×132.67pt | +2.67pt height |
| Outer left edge / horizontal content inset | 16pt / 14pt | 16pt / 14pt | Matches |

The main defect is internal composition, not outer card width. Swift's pending option buttons are 46pt high at about 59pt pitch, with separate rounded backgrounds. GrokBot uses contiguous rows with separators inside one dark well. The reference `Abort` label is red; Swift ignores supplied danger styling. Swift also omits descriptions that exist in the fixture metadata. These are implementation omissions in [RichMessageCard.swift](/Users/raghav/OpenBot/apps/mobile-swift/Sources/App/RichMessageCard.swift:233).

Custom-answer handling differs: GrokBot points to the ordinary chat composer; Swift adds `Your answer` inside the card. That needs an input-routing decision as well as styling. The reference dismissed widget retains dimmed options and descriptions with a small dismissed state. Swift collapses to title/help/`Dismissed`. The full reference dismissed height is not measured because it is partially off-screen.

The completed selection state is substantially closer. The fresh test actually tapped `Ship it`, observed the receipt, and captured it. Multi-choice selection also produced the native checkmark. This does not prove multi-choice custom submission, dismissal-on-move-on or all error/retry paths against a production server.

### Motion: a concrete source of jitter

[Measured motion plot](/Users/raghav/OpenBot/output/video-audit-0921/widget-motion.png).

GrokBot's single-choice card is initially 212pt high. The first detected smaller frame is at **195.3017s**, followed by heights approximately 193.3, 186.3, 180.3, 165, 157.3, 153.7, 145, 135.7, 132.3 and finally 130pt at **195.535s**. The observed transition tail is about **233ms**; variable-frame-rate gaps prevent claiming an exact total animation duration or easing curve. Its top position then moves from about 688pt to 624pt as the working area appears, settling around 195.935s.

In the fresh Swift recording:

| Native PTS | Card top | Card height |
|---:|---:|---:|
| 59.3333s | 567.67pt | 287.33pt |
| 59.3517s | 567.67pt | 132.67pt |
| 59.3667s | 722.33pt | 132.67pt |

That is an observed height jump followed by a position jump, not a comparable interpolated collapse. [NativeMessageList.swift](/Users/raghav/OpenBot/apps/mobile-swift/Sources/App/NativeMessageList.swift:210) reconfigures with `animatingDifferences: false`; the non-arrival branch restores the bottom without animation. The activity footer does have a separate 0.28/0.30s animation, but it does not coordinate widget cell remeasurement and transcript anchoring. The fix should animate card geometry and scroll anchoring together, while preserving a reader's position when not following the bottom.

The recording also shows distinct history-loading, reply push, keyboard movement, and working-indicator transitions. They should remain separate states. The normal chat loader is a native spinner, not the thinking robot. A tap on the chat-header identity opens the profile from the right; selecting a bot/conversation loads its transcript. No new matched message-send latency, physical-device frame pacing or long-chat stress benchmark was completed in this pass.

### Replies and threads

[Reply comparison](/Users/raghav/OpenBot/output/video-audit-0921/comparisons/reply.png) · [Thread comparison](/Users/raghav/OpenBot/output/video-audit-0921/comparisons/thread.png).

At172–174s, swiping the original LANTERN914 message pushes a focused page. The original message remains, the composer says `Reply Memory Deep 914 Box copy`, and the usual identity/desktop header is absent. Later the page contains `DM here reply` and a visible working status. Returning to the main transcript shows the compact relationship to the original message.

Swift currently has two visibly different mechanisms: inline reply selection and a separate thread sheet. The matched sheet contains extra title/Done chrome and repeated quote UI in the outgoing reply and composer. [ChatView.swift](/Users/raghav/OpenBot/apps/mobile-swift/Sources/App/ChatView.swift:104) presents the sheet; [ThreadPage](/Users/raghav/OpenBot/apps/mobile-swift/Sources/App/ChatView.swift:780) ends with a spacer and never includes the activity footer. [BotActivityRow](/Users/raghav/OpenBot/apps/mobile-swift/Sources/App/BotGlyph.swift:260) has a robot and an accessibility label, but no visible status text. Accessibility text does not substitute for the reference's visible name/status.

The video establishes presentation behavior. It does not expose GrokBot's wire-level `isFork` semantics or nested-thread data model, so those should not be inferred from screenshots alone.

### Bot-to-bot DMs and groups

[Exchange comparison](/Users/raghav/OpenBot/output/video-audit-0921/comparisons/exchange.png) · [Group comparison](/Users/raghav/OpenBot/output/video-audit-0921/comparisons/group.png).

The item described as “Message new bot” appears in this recording as **`Message from New Bot`**, with a peer avatar. Tapping it opens a read-only exchange. `Messaged New Bot` is the outgoing counterpart. This is different from creating a new bot. Ordinary acknowledgments such as “New Bot DMed…” remain separate transcript messages; the DM payload is shown in the exchange.

Swift's exchange navigation and read-only restriction work in the controlled test, but the screen composition differs. Its matching message is 335×84pt at x=45pt; reference 337×84pt at x=43pt. The native bubble sits 42pt higher in this scene, partly reflecting the much larger footer. It also lacks the visible reference date separator in this matched exchange. The header/footer implementation is in [BotExchangeView.swift](/Users/raghav/OpenBot/apps/mobile-swift/Sources/App/BotExchangeView.swift:21).

Group one-line messages are already close:

| Text | Reference width | Swift width | Height, both |
|---|---:|---:|---:|
| New Bot ACK_NOMENTION | 239.67pt | 240pt | 40pt |
| Parity Probe v3 ACK_NOMENTION | 291.33pt | 291.67pt | 40pt |
| PARITY_ONLY_ACK | 175.67pt | 176pt | 40pt |
| DMed New Bot; loop closed. | 243.67pt | 244pt | 40pt |
| DMed Parity Probe v3; loop closed. | 295pt | 295.67pt | 40pt |

The final two speaker/message rows have 71pt pitch in the reference and 71.33pt in Swift. A blanket font-size or padding reduction would risk damaging these matches. The reconstructed long mention prompt is 84pt high in the reference and 106pt in Swift, one additional 22pt line. Swift visibly inserts hyphens in identifiers. Verify exact raw text/whitespace and line-breaking policy before changing font metrics.

Speaker labels are intentionally bot-colored in [ChatView.swift](/Users/raghav/OpenBot/apps/mobile-swift/Sources/App/ChatView.swift:389); the reference labels are muted gray. Robot artwork also differs, independently of geometry. Group read-state/timestamps were not synchronized, so this comparison does not establish a missing `NEW` separator; native code already supports it. The five-member `+2` avatar is visible in the reference, but was not reproduced with identical members in this new fixture.

### Computer and loading

[Computer keyboard comparison](/Users/raghav/OpenBot/output/video-audit-0921/comparisons/computer.png) · [Loading comparison](/Users/raghav/OpenBot/output/video-audit-0921/comparisons/loading.png).

The real desktop test used a disposable authenticated backend, local worker and actual Linux RFB stream. It opened the computer, observed startup and a ready frame, acquired control through the keyboard button, displayed and dismissed the keyboard, opened the control menu, exited, and verified `humanTakeover: false`. The RFB handshake and sanitized state receipts are saved. This pass did not type into the remote desktop or revalidate all gestures/clipboard paths.

Both reference and native desktop frames are 440×275pt in the keyboard state (1280×800 remote aspect). The reference occupies y=186.33–461.33pt; native y=207.67–482.67pt. The 21.33pt shift is a layout difference, not a remote desktop resolution difference. Native bottom controls are 44pt via `ChromeButton`; the reference appears about 38pt. Keyboard/hide glyphs differ. The reference startup sequence includes “This Bot runs on your computer.” followed by `Connecting…`; Swift uses `Starting desktop…`. Black surrounding the desktop and keyboard is appropriate for this computer screen and should not be generalized to normal chat keyboard gaps.

The history loader itself is the correct native 20×20pt type, but is 20pt too low in the matched full-screen comparison. The native capture deliberately held history for 6 seconds to expose this state; it does not measure real connection speed. The reference activity dot, different bot artwork, simulator status bar and disabled composer are not all isolated by that fixture and should not be lumped into the spinner measurement.

## Colors, glass and rich content

Measured decoded reference page pixels and native PNG page pixels are both **RGB20/20/20 (`#141414`)**. Reference assistant/card flat areas cluster around 29/29/29; native surfaces are 32/32/32. Outgoing bubbles cluster around 82/82/82 versus 84/84/84. Those 2–3 level differences are observations, not recovered source constants: the reference is full-range BT.709 HEVC and the native screenshot is a PNG. Color conversion and compression can contribute.

The large pending-widget difference is unambiguous: reference inset options use the dark page well, while native option pills are around 88/88/88. That comes from control styling, not a gradient behind glass. Speaker-label color and the missing danger tint are also explicit source differences.

The reference shows the same floating material becoming lighter over an outgoing bubble and darker over empty background. Blur, tint, edge highlights and underlying content all contribute. Current single-card fixtures do not put the exact same pixels under header/composer at each scroll offset, so this pass does **not** claim a precise opacity multiplier or certify Liquid Glass parity. The white waveform control in reference DMs also changes the composer silhouette and available text width. The plus control is already explicitly 16pt regular in Swift; the current evidence does not justify another blanket reduction based on these unmatched scenes.

The video shows prose, bold text, numbered content, bullets, inline monospace text, code blocks, screenshots, a blue image swatch, file/media attachments and permission receipts. The fresh numbered-text comparison shows different indentation and wrapping, but raw Markdown is unavailable: manually bolded numeric paragraphs and a parsed ordered list can produce different layouts from visually similar text. This is a candidate formatting mismatch, not proof that the Markdown engine should be globally reconfigured.

Reference approval receipts around 73–77s use broad green/red status bands. Current `ApprovalCard` uses a different label/card composition; this is reference-plus-source evidence, not a same-payload screenshot comparison. Exact inline attachment/photo/file preview matching was not reproduced with original attachment bytes in this pass. Prior screenshots remain useful reference material but do not turn this into a new end-to-end attachment/share test.

The recording explicitly says `cursor-agent` was skipped and secret/credential requests were to follow. Their actual cards do not appear in the relevant footage. Tables, math, Mermaid, transcription, push notifications, OAuth completion, light-mode appearance and every form/error variant are **not certified** by this recording. Seeing a bot say it supports them is not a functional test.

## QA integrity and remaining work

The test ledger includes **18 executions: 13 passed, 5 failed**, plus a zero-test attempt that is explicitly excluded. This is a troubleshooting history, not a release pass rate. Two old screenshot fixtures lacked VNC; the first loader capture missed its short observation window; one live proxy was not kept running; one isolated Docker route reached the wrong VNC host port. Those issues were diagnosed rather than hidden. The corrected final live-computer/widget run executed 2 tests and passed both; the separate delayed-loader run passed.

Three older thread tests reported success while their attachments included an alert or blank/wrong presentation. That is a real QA gap: an `exists` assertion can match underlying UI without proving the intended page is visible. Fresh targeted screenshots establish the thread findings here. Tighten those tests to assert presentation identity, visible root/child content, loading completion and absence of unexpected alerts before relying on their green status.

The live backend used the existing local server image `openteam-local-server:vnc-20260919`, not a freshly rebuilt production backend. Its image digest is retained. No production provider credentials were copied and no model/external messages were sent. Owned QA services were stopped after capture; the pre-existing shared database and unrelated app work were preserved. Temporary capture test sources are archived with the output, not left in the ordinary test suite.

Recommended implementation order:

1. Restore focused reply-page navigation and thread-specific working feedback without changing reply data semantics blindly.
2. Rebuild pending/dismissed widget presentation and custom-answer routing, honoring descriptions and styles.
3. Coordinate widget height changes and bottom-follow scrolling in one animation; verify frame sequences with and without the keyboard, including readers scrolled above the bottom.
4. Match exchange avatars/header/read-only footer, then group labels and composer variants.
5. Correct spinner and computer viewport placement; perform exact-content glass comparisons on a physical device in both appearances.
6. Obtain raw rich-message payloads for controlled Markdown/attachment comparisons; strengthen visually weak tests and rerun the broader device QA suite.

Raw evidence: [comparison manifest](/Users/raghav/OpenBot/output/video-audit-0921/comparison-manifest.json), [reference frame index](/Users/raghav/OpenBot/output/video-audit-0921/frames.json), [pixel measurements](/Users/raghav/OpenBot/output/video-audit-0921/native-pixels.json), [motion frames](/Users/raghav/OpenBot/output/video-audit-0921/native-widget-motion.json), [test ledger](/Users/raghav/OpenBot/output/video-audit-0921/test-ledger.json). Artifacts preserve uncertainty rather than assigning a misleading whole-screen pixel-match percentage.
