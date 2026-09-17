# React Native haptic parity — 16 September 2026

The Swift app now routes app-generated haptics through `NativeHaptics`. The source audit covered 91 React Native call sites, including wrapper functions and duplicate native/fallback branches. React Native source remains unchanged.

## Behavior retained

| Interaction | Feedback |
| --- | --- |
| Message/conversation long press, including pinned conversations | Medium impact |
| Send, resend, reply action, copy, attachment menu, share, inbox swipe action | Light impact |
| Reply swipe | Light impact at 52 points; 40-point hysteresis; one pulse per gesture; fast release supported |
| Reactions, mention selection, changed robot/color/member/filter choices | Selection |
| Latest-message button / deliberate user scroll back to the live edge | One selection pulse; passive layout and streaming stay quiet |
| Create/profile/routine saves, plugin commands, approvals, secret submission | Success after acceptance; error for failed actions |
| Routine Run now | Light impact after accepted receipt; history polling stays quiet |
| Computer handoff | Light after takeover acceptance; success/error when returning control |
| Sign-in | Light on submit, one success/error outcome; cancellation and stale responses stay quiet |
| Voice-note cancellation and input/upload failures | Light cancellation cue; error for failures |

App feedback respects the persisted **App haptics** setting and requires the app to be active at the instant feedback is requested. Native switches, system keyboards, notification alerts and OS-owned menu feedback remain controlled by iOS, as in the React Native app.

Success feedback is opt-in for shared mutations. Passive form loading, reconnects, history polling, outbox reconciliation and cancelled operations do not produce success pulses. Button and keyboard message submission share the same send cue.

## Bugs found and corrected

- The new-bot robot picker had no hittable shape around its UIKit artwork. Taps could leave both selection and feedback unchanged. Its complete button rectangle is now interactive.
- SwiftUI Menu consumed the attachment label's tap recognizer. The menu opened without an app haptic. The native attachment button now observes UIKit's `menuActionTriggered` event; image selection still uses the system photo picker.
- Inbox swipe actions and pinned-conversation context menus were missing. Pin/Hide and their feedback are now present.
- Reply swipes used selection feedback at 100 points instead of the React Native light impact at 52 points.
- Feedback attached only to the composer send button missed other send entry points. It now belongs to the shared enqueue operation.
- The Latest messages button lacked a complete touch target. It now receives taps and produces one selection cue.
- Scroll-edge feedback double-counted the floating bars' safe-area insets. SwiftUI's offset is now normalized to React Native's zero-at-top coordinates; a measured-inset regression test covers the error.
- File sharing now invokes feedback from the actual Share action, with cancellation quiet and share errors handled.
- Plugin sign-in suppresses the intermediate configuration-save success cue while retaining configuration and authorization errors.
- Plugin category choices now use the shared marketplace category rules and selection feedback only when the value changes.

## Evidence and limits

The simulator checks use a running local HTTP fixture with real app networking, delayed responses, server failures and accepted receipts. Debug-only dispatch instrumentation records effect, source, enabled/active state and whether UIKit was called. It requires both UI-testing flags and a loopback server. No message content, account data or credentials are recorded.

`emitted: true` in a trace means the UIKit feedback method was invoked. It does **not** measure physical Taptic Engine output. No physical iPhone was connected; intensity, timing and system-level haptic restrictions still require a device check.

Voice capture/cancellation, approval and secret-card feedback were audited in source and compiled. The automated interaction coverage is listed in `Tests/UITests/HapticsUITests.swift`; it does not claim a device test of every source call site.

- Swift core suite: **36 passed**.
- React Native haptic/preference/reply/scroll test run: **63 passed**, including imported test cases.
- Native UI suite: **14 passed, 0 failed, 0 skipped** (`Haptics-Verified.xcresult`).
- Additional plugin sign-in error check: **1 passed** (`Haptics-PluginAuth-Verified.xcresult`). Both configuration-save and authorization failures produce one error cue, with no premature success. Total native UI coverage: **15 passing checks**.

Artifacts are in `output/swift-haptics-0916/` at the repository root. `rn-inventory.json` contains the source inventory. XCTest bundles retain the dispatch traces, screenshots and screen recordings.

Run the fixture with `SWIFT_PARITY_PORT=20030 bun apps/mobile-swift/scripts/parity-server.ts`, then run the `Haptics` Xcode scheme on an iPhone simulator. The scheme is opt-in and excluded from the default test suite.
