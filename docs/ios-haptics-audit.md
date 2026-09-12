# iOS haptics audit

Reviewed September 12, 2026. This pass audits the mobile interaction code and fills missing feedback; physical iPhone feel testing remains outstanding.

The subsequent [iOS haptic design research](/Users/raghav/OpenBot/docs/ios-haptic-design-research.md) refines this initial pass: reply swipes use one consistent light impact, ordinary navigation stays quiet, and a saved App haptics switch controls custom feedback. See that report for the current implementation, research sources, and verification results. The 151-test result below records the initial audit.

## Feedback policy

- Selection feedback acknowledges changes to custom selections, such as reactions, appearance, avatar choices, and group membership. Selecting the current value or pressing a disabled control stays quiet.
- Light impact feedback acknowledges discrete actions such as sending a message. Long-press menus and reply gestures retain their existing tactile cues.
- Success feedback follows confirmed saves and completed actions. Error feedback accompanies visible, actionable failures. Rejecting an approval successfully uses success feedback: the user's decision was recorded.
- Native switches keep their built-in feedback without an additional custom selection or success pulse. This follows [Apple's guidance on native controls](https://developer.apple.com/design/human-interface-guidelines/playing-haptics).
- Background loads, polling, streaming text, typing, scrolling, and continuous computer input stay quiet. Haptics remain supplemental to visible feedback.

## Coverage reviewed

| Area | Result |
| --- | --- |
| Welcome, connection, sign-in | Existing action and error feedback retained; welcome softened to Light. Connection success now waits for local persistence when authentication is disabled. Stale auth requests remain silent. |
| Chat composer | Existing single send impact retained; send failures and attachment selection failures now have error feedback. Mention selection gets selection feedback. |
| Messages and conversations | Existing reply threshold and message menu feedback retained. Added conversation long-press feedback, actual reaction selection, resend acknowledgement, clipboard result feedback, and errors for failed contextual actions. |
| Approvals | Both accepted and declined decisions acknowledge successful completion; failed decisions produce error feedback. |
| Appearance and Bot profiles | Actual appearance, accent, avatar shape, and color changes get selection feedback. Failed persistence gets error feedback alongside the existing or newly added error message. |
| Bot and group setup | Mode and member choices get selection feedback; bounded or unchanged selections cannot trigger a false selection pulse. Creation and explicit saves acknowledge success or failure. |
| Text and routine editors | Saves and routine deletion acknowledge outcomes. Run Now acknowledges the accepted request with a light impact, without claiming the routine has finished. |
| Settings | Server saves and notification-update failures have feedback. The initial “System” status was subsequently replaced by a saved App haptics switch. |
| Plugin configuration and marketplace | Custom choices and filters get selection feedback; interactive mutation failures and confirmed saves get outcome feedback. Automatic refreshes stay quiet. Opening OAuth authorization does not claim successful authentication. |
| Rich message questions and secrets | Answer selection/submission gets feedback; rejected answers, dismissals, and secret submissions show an error. Successful secret submission gets success feedback. |
| Computer handoffs | Starting or finishing a handoff checks the server's accepted result before updating the UI or leaving the screen. Rejection produces a retryable error and error feedback. |
| Images | Existing dismissal and share feedback retained; sharing failures get error feedback. |

## Shared native adapter

All mobile haptic calls now use the [shared adapter](/Users/raghav/OpenBot/apps/mobile/src/haptics.ts). It skips calls when app haptics are disabled or the app is not known to be active, and absorbs synchronous native errors and rejected promises so a haptic failure cannot break the user's action.

The adapter delegates to Expo and leaves system restrictions intact. iOS can suppress haptics when system settings disable them, Low Power Mode is enabled, the camera is active, or dictation is active; see the [Expo Haptics documentation](https://docs.expo.dev/versions/latest/sdk/haptics/). Voice input continues to rely on native behavior instead of adding feedback from its shared event subscriptions, which could duplicate pulses across mounted composers.

## Verification

- Mobile unit and regression suite: 151 tests passed, 925 assertions across 32 files.
- Four new behavior tests cover foreground execution, background suppression, rejected native calls, and synchronous native failures.
- Mobile TypeScript check passed.
- Native configuration check passed: 23 unique Expo packages, 24 unique pods.
- Production iOS export passed.

Logs and the exported bundle are under the ignored `output/haptics-0912/` directory. The unit suite includes existing source-level regression checks; it does not simulate every screen's haptic behavior.

## Physical iPhone checks still required

1. With system haptics enabled, feel welcome, connection, valid and invalid sign-in, send/retry, and approval outcomes. Each cue should be distinct but restrained.
2. Change a reaction, appearance, avatar, and group member. Check one cue per actual change, silence for unchanged or disabled selections, and no doubled cue on native switches.
3. Trigger failed saves, attachment errors, plugin errors, and rejected handoffs. Check that the error is visible, retry works, and success never precedes rejection.
4. Start a delayed action, then leave the app before it completes. Confirm no background pulse. Repeat with Low Power Mode or system haptics disabled; the action and visible feedback must still work.
5. Exercise camera and dictation, long-press menus, reply swipes, and rapid interactions. Check the feel on hardware, including after returning from a system picker.

Simulator and build checks cannot establish tactile strength, latency, or comfort. Those remain a hardware QA step.
