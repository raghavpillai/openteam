# Fresh iPhone QA and reference comparison — September 18, 2026

This pass starts from `e9402bf`, the product source used for native TestFlight **0.0.1 (25)**. It uses a newly created iPhone 16 simulator and the existing iPhone 16 Pro Max QA simulator, both on iOS 26.5. The narrower, clean simulator deliberately exercises first-run permissions and a smaller logical viewport. No physical iPhone is connected.

Evidence: `output/swift-qa-pass2-0918/`. The [comparison report](../../../output/swift-qa-pass2-0918/review.html) includes all **32 supplied reference photos**, unchanged, beside fresh native captures. Seven chat/home states also have wider-phone captures. Nine additional light-mode captures have no supplied light-mode reference and are not presented as a visual match.

## New findings and corrections

**Plugin authorization could stop refreshing on a smaller iPhone.** Two previously passing lifecycle tests failed on the fresh iPhone 16: authorization completion did not refresh after returning from Safari, and an expired session did not change to “Sign-in expired.” `PluginConnectionActions` attached its polling task to a zero-height footer inside a lazy `Form`. Adding authorization controls pushed that footer offscreen, removing the task. The task is now attached to the visible status row. All **10 plugin/settings follow-up cases and two targeted plugin haptic cases passed**. The original failed screenshots/logs are retained; follow-up results are recorded separately.

**Two tests assumed permissions were already granted.** The photo-save test expected the old “Allow Access to Add Photos” button, while iOS 26 displayed “Allow.” The microphone-unavailable test waited for the app error while the first system permission prompt was still open. Both tests now handle the specific system prompt. Both follow-ups passed after resetting the respective permission, so an already-authorized simulator cannot hide this gap. These are test corrections, not two additional product fixes.

The live harness now optionally runs its server in the tested Linux Docker image through `SWIFT_REAL_QA_SERVER_IMAGE`. This avoids the previously observed macOS Bun server hang while retaining an isolated database, real worker/model, and disposable computer. Credentials are passed through the child environment, not command-line values or report files.

## Visual findings

Passing a screenshot test proves that the interaction reached its asserted state. It does not establish pixel parity.

- Flat dark colors match the supplied chat reference: **background `#141414`, assistant/card surface `#202020`, user bubble `#5C5C5C`**. Fresh sRGB histogram measurements are in `flat-colors.json`.
- Translucent menus still differ. In the home-menu captures, the reference's prominent menu gray is approximately `#323232`; the native capture's is `#1E1E1E`. These are rendered colors, not measurements of opacity. Backdrop content, tint/material, OS version and accessibility settings can all affect the result.
- Settings and plugin pages have different row organization, labels and navigation geometry. The native plugin detail exposes connection/configuration rows where the reference uses a compact branded detail sheet. These remain clear visual-parity gaps.
- Attachment menus use different wording and include a voice-recording action. The camera action is conditionally omitted because this simulator has no camera; that is not evidence that it is missing from a physical iPhone. File previews and the photo viewer expose the expected controls, but menu material, caption wrapping and title truncation still need visual review.
- Light-mode timestamps are very faint, and dark message content behind the transparent status area can reduce the visibility of the dark system icons. This is a visual accessibility concern in `palette-chat-light`, not a measured contrast-compliance result.
- A 393-point iPhone 16 and 440-point iPhone 16 Pro Max produce different text density at equal screenshot width. The reference photos were downscaled to 589 pixels wide and do not establish their original logical device width. The report offers both fresh native chat widths rather than treating all wrapping differences as app defects.
- The unsectioned inbox omits “Unassigned.” The section-menu and section-deletion interaction checks are separate from the fixture's conversation contents.
- OpenTeam robot artwork intentionally differs from Grok Bot's artwork. Screenshot status bars, keyboard suggestions and clocks are not repainted.

The OAuth comparison is explicitly a related-state comparison: the supplied screenshot is Google's system consent prompt, while the fixture capture is the authorization return. The completed-widget capture likewise uses a different form fixture. The live desktop has an instrumentation page rather than the reference wallpaper. None of these are represented as exact 1:1 content matches.

## React Native sign-in and server/IP comparison

The [eight-pair auth comparison](../../../output/swift-qa-pass2-0918/auth-comparison/review.html) directly runs the original React Native `AuthGate` and Swift `SignInView` on the **same iPhone 16 simulator and iOS 26.5**, in both appearances. It covers the welcome screen, server/IP form, server keyboard and account keyboard. The RN app uses the existing September 15 debug native shell with the current workspace auth source loaded through Metro. Its “Onboarding QA” label and appearance switch are test-wrapper controls, not product differences. Its status bar is also controlled by that wrapper; clocks, caret and decorative animation phases are not synchronized. Original captures and source hashes are retained.

**The design is restored, but the screens are not identical.** The nine bots, backgrounds (`#F5F5F3` / `#101010`), hero/tagline, HTTP notices and three-stage flow are preserved. Direct remaining differences:

- Swift displays a **Passwords accessory row on the server/IP keyboard**, absent in the RN server captures. This reduces available height and moves the form upward. The root cause of the accessory row has not been isolated; it is not evidence that HTTP is unsupported.
- The **disabled Sign In button has different contrast** in both appearances: Swift is more faded. The source tint values match, so renderer/disabled-state handling needs investigation rather than changing the background token blindly.
- **Card height, internal spacing, border and shadow rendering differ**, especially in light mode. The source uses explicit RN line heights and native Swift text metrics; there is no pixel-parity sign-off.
- Swift adds **clear-address and password-reveal controls** and uses “Sign in” instead of RN's “Sign In.” These are functional additions/copy differences, not failed login behavior.

The focused Swift auth presentation/navigation test passed for both themes on this same device, including keyboard reachability and clearing the password on Back. Its first supplementary attempt failed before app interaction because the loopback auth fixture had stopped; restarting that fixture resolved the harness failure. Both attempts remain in the ledger. The broader auth/error/re-auth cases had already passed in the main run. RN was exercised through server discovery into credentials; no real credentials were entered in this visual comparison.

## Scope and limits

The pass covers account/sign-in/re-auth, inbox/chat, edge-back and swipe replies, holds/actions, threads/search, queue recovery, Markdown/documents/forms, attachments/photos, plugin lifecycle/access, approvals/rules, routines, launch animation, appearance/keyboard backgrounds, haptic dispatch, notification state, real-server delivery, desktop controls and message-history performance.

The real-server flow uses a separate Postgres database and disposable QA bots. The main installation is only exercised by read-only discovery and an invalid-account authentication response check. Live asset authorization passed **29 assertions**. Swift core tests passed **59 cases**; the explicitly scoped current-workspace contracts/client suite passed **134**, notification/APNs service tests **29**, and asset semantics **9**. Initial broad Bun selectors also discovered archived source copies under `output/`; those logs are retained as `*-unscoped.log` and excluded from current-source acceptance.

Physical APNs delivery/background clearing after a desktop read, actual haptic feel, physical microphone recording, and real Google/provider OAuth consent remain unverified. Simulator notification reconciliation and controlled OAuth lifecycle tests do not substitute for these device/provider checks. Large-text/VoiceOver coverage is not comprehensive.

## Final results

**145 unique UI cases passed, one failed, and one was skipped. Full acceptance remains open.** The six message-history cases passed their functional assertions, but both measured workloads failed the separate performance budgets.

The final per-case ledger is `final-ui-manifest.json` in the evidence directory. Original failures are kept and follow-up passes are identified by run name; repeat device runs do not inflate the unique-case count.

### Live delivery, push and desktop

All **four isolated real-server UI cases passed**: real model delivery and persistence; attachment actions, hold/reaction/swipe reply; rich-message gesture cancellation and vertical scrolling; and selective notification clearing from desktop read events while the app is active. The separate main-installation HTTP and HTTPS discovery/authentication-response cases both passed. This is stronger than fixture-only validation, but it does not verify background APNs delivery on a physical iPhone.

The notification suite passed **six cases and skipped one**: the background desktop-read case requires physical-device delivery. Foreground reconciliation, selective Notification Center cleanup, cold-launch routing, registration retry and re-auth cleanup passed on the simulator. All **15 haptic-dispatch cases passed**; a simulator cannot establish the physical feel.

Native live-desktop validation passed **six of seven cases**. **Trackpad tap-then-drag remains broken:** the expected pressed-button move did not reach the actual remote desktop. Direct-touch drag, pointer movement, repeated holds, zoom, right-click, keyboard/clipboard, lease return and foreground recovery passed their assertions. The first attempt never registered a takeover request and stalled in XCTest teardown; it was interrupted. Both takeover API preflights returned 200, and the strengthened rerun asserts “You have control” before testing gestures. The evidence does not establish a new server regression from that interrupted attempt.

The independent authenticated RFB/WebSocket probe passed **eight of nine checks**. It observed only **two distinct frames in three seconds**, below the probe's four-frame threshold. Keyboard/right-click input, authentication rejection, view-only restrictions and both reconnect paths passed. This separate noVNC transport probe must not be confused with the native Swift viewer, which still retrieves roughly one PNG per second. Smooth live desktop streaming is not signed off.

### Message performance

| Workload | Previous app peak | Fresh app peak | Previous CPU / six drags | Fresh CPU / six drags |
| --- | ---: | ---: | ---: | ---: |
| 1,000 text messages | 625.9 MB | **626.4 MB** | 149.7 s | **149.8 s** |
| 200 mixed document messages | 296.2 MB | **295.7 MB** | 13.0 s | **12.9 s** |

Neither workload meets the **180 MB app-memory / 6 CPU-second** targets. The fresh results are effectively unchanged from the preceding accepted measurements. Fresh wall-time means were 152.2 seconds and 28.4 seconds respectively. Three recorded samples and the excluded prior failed mixed-workload sample are preserved in `performance-final.json`.

The performance suite runs after this pass's other UI queues finish and its disposable live services stop. Other user-managed simulators and work remain active on the shared Mac. Timing comparisons are therefore approximate; this is not an idle-host microbenchmark or a physical-iPhone FPS measurement.

The CPU and wall measurements include expensive XCTest accessibility queries around the six drags. App memory excludes separate WebKit processes. The scrolling/deceleration signpost duration is not an FPS or hitch-rate measurement. CPU/memory budgets remain acceptance targets, not a previously achieved baseline.

### Remaining acceptance work

1. Correct trackpad tap-then-drag delivery and validate native live-frame cadence.
2. Reduce large-history memory and CPU cost; profile release builds on a physical iPhone before claiming smooth 60/120 Hz scrolling.
3. Match the remaining glass/menu, settings/plugin and RN auth layout differences, including the extra server-keyboard accessory row and disabled-action contrast; resolve the faint light-mode timestamp/status-area contrast concern.
4. Complete physical push/background clearing, microphone/camera, haptic feel and real provider OAuth checks.

The plugin refresh fix is a source change from this pass. **No new TestFlight build was uploaded; TestFlight 25 is unchanged.**

## Server and cleanup

The main installation returned **200 / ready** over both `http://100.94.42.50:8787` and `https://office-mac-mini.tail658346.ts.net:10000` at the final check. The phone must be connected to the same Tailscale network to reach these addresses. `main-server-final.json` records the response time and service readiness.

The disposable live server, worker and computer are stopped, their database is dropped, and the QA database container is restored to stopped. All fixture/Metro/review ports from this pass are closed. The newly created comparison simulator is deleted and the existing QA simulator is restored to Shutdown. The three other user-managed simulators remain booted. Receipts are in `live-cleanup.json` and `cleanup-final.json`.
