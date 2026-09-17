# Live server, message gestures and read synchronization

September 16, 2026. This follow-up uses real model inference, not the earlier deterministic `LiveBackend` fixture. It does not certify the whole migration: the other findings in [the full-app audit](QA-AUDIT-0916.md) remain open.

## Environment

The Swift app ran on an iPhone 16 Pro Max simulator, iOS 26.5, against a disposable authenticated server at `127.0.0.1:20020`. The server, worker and computer gateway were built from the current workspace. PostgreSQL and all conversations/workspaces were isolated from the user's main installation. The computer used the existing local Linux runtime image with the current gateway bundle mounted into it. Its existing provider login was passed into temporary container memory; it was not written to this repository.

The selected model was `openai-codex/gpt-5.5`, with low reasoning. Bot replies came from the real model through the worker and `SendToUser`. The app signed in through its native login screen and connected directly to the product API. A separate loopback control process only created QA data and inspected persisted records.

## Bugs fixed

- **QA-02: attachment and rich-message gestures were disabled.** A long press now takes priority over an attachment's preview tap. A directional native pan handles reply swipes across text, attachments and rich Markdown. It rejects vertical and leftward gestures immediately, resets on cancellation, and requires a full rightward swipe before selecting a reply. Ordinary taps still open Quick Look; reactions and quoted replies remain interactive.
- **Embedded forms retain native input behavior.** Reply gestures are scoped to message text and attachments. Form cards expose Reply through a native context menu, while their fields and switches retain editing, selection and control gestures. The form regression verifies both switches, a failed submission, retained input, successful retry, the persisted receipt, and the card's reply menu. Its earlier failure was a test targeting the surrounding switch label; the corrected test taps the actual native control.
- **Live model catalog appeared empty despite valid authentication.** The subscription model-list request used `client_version=0.99.0`. The live endpoint returned HTTP 200 with only a hidden review model for that version. Updating it to `1.0.0` restored five visible chat models and allowed the real test conversations to run. Hidden models remain filtered out.

An older deployed computer image also lacked the current authenticated health endpoint. The disposable test now mounts current computer source as well as current server/worker source. This is a deployment compatibility requirement, not a reason to fake a healthy response. The main installation was not upgraded during this QA pass.

## Verified behavior

All four live scenarios pass on the final application code: three in `LiveFinal.xcresult`, plus the corrected rich-message scenario in `RichScroll-Acceptance.xcresult` (**1 passed, 0 failed, 0 skipped**). No application code changed between those two runs.

`LiveFinal.xcresult` records **3 passed and 1 failed** because the original scroll test dragged upward at the newest-message boundary of a short conversation. The corrected check creates older history and drags toward it, retaining the assertion that the message moves by more than 20 points. The failure and screenshots remain in the evidence; this was a test precondition error, not a suppressed assertion. An earlier run, `RealServer-Gestures.xcresult`, also passed all three gesture scenarios.

- Native login, send, live model response and event-driven message updates.
- Hold a real assistant message, open its actions, choose Reply, and send it inline.
- Swipe that message, send another inline reply, and verify the correct parent ID, same channel, no branch flag, and one persisted copy of each reply.
- Relaunch and sign in again: both stored quote controls remain present.
- Upload an image to the real server, open its native preview with a tap, hold it for actions, persist a reaction, and send both held and swiped attachment replies.
- Hold formatted WebKit content, cancel a selected reply, swipe it and send a persisted inline reply. Short, leftward and vertical gestures do not select a reply. The check also asserts that vertical dragging actually moves history.

The original two attachment audit checks also pass in `AttachmentGestures-Fixed.xcresult`. **31 Swift core tests** and **37 provider-registry tests** pass; the computer TypeScript check passes.

Fixture regressions also passed for rejected-login retry, offline queued-message recovery, lost-send-acknowledgment recovery and successive queued thread replies. `FormControls-Acceptance.xcresult` passes the embedded-form regression described above. These failure paths use deterministic fault injection, separately from the live-model checks.

`LiveReadSync-Acceptance.xcresult`: **1 passed, 0 failed, 0 skipped**, then passed again in `LiveFinal.xcresult` with freshly reset observations. Native device registration returned HTTP 201 from the actual server. The real desktop read API and live event stream removed delivered notifications selectively: **2 → 1 → 0**, without relaunching or manually refreshing the open app. The final run’s badge matched the server’s **8 → 7 → 6** unread conversations; six other QA conversations remained unread. The remaining alert was preserved after the first read.

This uses real authentication, device-registration, notification-state and desktop read APIs. Only delivery into the simulator is injected with `simctl`; observations come from the actual `UNUserNotificationCenter`. It does not establish signed-device APNs delivery, background wake behavior, or interaction through the desktop UI. See [native push acceptance](NATIVE-PUSH.md).

## Evidence and limits

[Screenshots and test evidence](../../../output/swift-live-gestures-0916/review.html) include the held-message menu, saved quotes after relaunch, attachment preview and rich-message actions. The output directory also contains Xcode result bundles, database receipts, health/model configuration and test logs. Earlier failed runs preserve harness corrections separately from the final results; incorrect test sender labels or setup routes are not counted as product bugs.

One visual limitation remains visible in the captured short conversation: dismissing the keyboard to present message actions can move the selected bubble underneath the sheet. Reply selection and sending work, but keeping the selected message visible during this transition still needs polish. This pass does not claim pixel-perfect completion or close the unrelated thread/plugin/outbox findings.

No physical iPhone, Apple signing identity or configured APNs key was available. Actual Apple delivery, locked/background removal and physical haptics still need device acceptance. The existing main server was only inspected for health; these changes were not deployed there.

## Repeat the live checks

This local harness expects the existing `openteam-swift-fullqa-db-0916` disposable database container and `openteam-memory-computer:20260913` runtime image. It creates a fresh QA database and owner per run, never resets the main owner's credentials, and removes its temporary computer on exit.

Run the services in separate terminals:

```sh
bun apps/mobile-swift/scripts/real-server-qa.ts
SWIFT_PUSH_QA_SIMULATOR=<simulator-udid> bun apps/mobile-swift/scripts/live-notification-proxy.ts
```

Then run the opt-in suite:

```sh
python3 apps/mobile-swift/scripts/generate-project.py
xcodebuild -project apps/mobile-swift/OpenTeamNative.xcodeproj -scheme RealServer \
  -destination 'platform=iOS Simulator,id=<simulator-udid>' \
  -derivedDataPath apps/mobile-swift/.build-ios -parallel-testing-enabled NO \
  -resultBundlePath output/real-server-new-run.xcresult CODE_SIGNING_ALLOWED=NO test
```

`RealServerUITests` is excluded from normal fixture verification. Stop both helper processes after the run and stop the disposable database if it was started only for this QA pass.
