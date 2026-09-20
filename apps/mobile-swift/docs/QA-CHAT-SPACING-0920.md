# Message spacing against the supplied GrokBot recording

Reference: `ScreenRecording_09-20-2026 01-30-25_1.mov`. Measured decoded source frames at their original 1320 × 2868 resolution, dividing coordinates by three to obtain logical points. The matched app capture uses an optimized iPhone 16 Pro Max simulator build and inert copies of the same message text.

## Findings and corrections

| Measurement | GrokBot | OpenTeam before | OpenTeam corrected |
| --- | ---: | ---: | ---: |
| Different-speaker bubble gap | 12 pt | 12 pt | 12 pt |
| Consecutive same-bot bubble gap | 8 pt | 12 pt | 8 pt |
| Four-line prompt height | 106 pt | 104.33 pt | 106 pt |
| Single-line response height | 40 pt | 40 pt | 40 pt |
| Three-line response height | 84 pt | 82.33 pt | 84 pt |
| Message outer horizontal inset | 16 pt | 16 pt | 16 pt |
| Wrapped bubble width | 364 pt | 364 pt | 364 pt |

The reference consistently uses 12-point speaker changes across its two conversations, and an 8-point gap between the two consecutive memory responses. A uniform 12-point stack made that bot-message group 50% too widely spaced. The native text renderer also reserved its shorter natural first-line height inside multiline bubbles, rather than complete 22-point line boxes.

The presentation projection now identifies consecutive speakers without grouping across idle timestamps, different bots, or event/handoff rows. Pending outgoing messages use the same grouping as their acknowledged copies. The view applies 8/12-point gaps to those groups and reserves complete, Dynamic Type-scaled line boxes for plain text. Horizontal insets, bubble padding, and the existing arrival and loader transitions are preserved.

## Validation and evidence

- `output/chat-spacing-0920/spacing-before-after.jpg`: annotated reference, previous build, and corrected build. Only the first bubble's vertical position is aligned; each column preserves its measured internal spacing.
- `full-side-by-side.jpg`: uncropped viewports, showing the remaining device/keyboard and artwork differences.
- `spacing-comparison.json`: pixel-derived measurements. The retained source samples are at 17.443 seconds in GrokBot and 11.797 seconds in the previous app capture.
- `Spacing.xcresult`: matched scenario passes explicit assertions for the two gaps and all three bubble heights, plus keyboard clearance, sending, and receiving.
- `Regression.xcresult`: both-appearance touch-target checks and the keyboard/delayed-acknowledgment/multiline/activity/latest-message regression pass.
- `core-tests.log`: five message-presentation tests pass, including speaker/date/event separation and pending-to-acknowledged grouping stability.
- `spacing.mov` and `review/side-by-side-quarter-speed.mp4`: corrected capture and separately aligned send, loader expansion, reply, and loader collapse. Only captured frames are used. Minimum measured robot-to-incoming-reply clearance is 26 points in this capture; no overlap was detected.

The corrected history rests approximately one point lower relative to the screen than the source; keyboard geometry differs. This pass validates message spacing, not complete UI identity or physical-device frame pacing. The selected robot artwork and extra reference voice control still differ. No TestFlight upload was performed.
