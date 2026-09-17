# Native push notifications and desktop read synchronization

**September 17 update:** Signed native TestFlight builds now use `dev.openbot.mobile` and extension `dev.openbot.mobile.notifications`; Debug retains the separate Swift bundle IDs. Release entitlements and signatures are verified. The running main worker still has no APNs credentials configured. See [current QA/deployment status](QA-STATUS-0917.md). The September 16 evidence and environment limitations below are historical.

The Swift client now has an APNs path alongside the existing Expo path. This is implemented and locally tested; **live APNs delivery and background clearing on a signed iPhone still require acceptance**. This workspace has no configured APNs signing key, no valid Apple code-signing identity, and no connected physical device. No production database or deployment was changed.

## Behavior

- iOS asks for notification permission after connecting. Settings offers an on/off switch, an iPhone Settings link after denial, and retry after registration errors. Per-bot notification preferences continue to apply on the server.
- The app registers its native device token, app bundle ID, APNs environment, installation ID and server/account scope. Credentials stay in Keychain. Logout/server switching await outstanding registration before retiring that server's device, and retain the connection if retirement fails.
- The worker signs APNs HTTP/2 requests with ES256, uses the correct sandbox/production host, bounds payloads, retries transient failures, and retires invalid/unregistered tokens. An Expo outage does not retry already accepted native deliveries.
- Message, reaction, approval and completion alerts use the existing notification policies. The embedded native notification extension reuses our robot artwork and communication-notification renderer. It has no Expo/React Native runtime dependency.
- Desktop reads already advance two server cursors and enqueue a silent `badge-sync`. The native receiver merges those cursors, fetches `/api/v0/notification-state`, removes matching delivered notifications, and refreshes the badge. Fetching all cursors handles coalesced wakes across multiple conversations.
- Message and reaction cursors stay separate. Reading an older message cannot dismiss a newer message or a new reaction to that old message. Account scope, monotonic merges and snapshot ordering prevent stale/wrong-account updates from clearing unrelated alerts.
- Foreground refresh reconciles missed background reads. Viewing a conversation acknowledges both `throughSequence` and `throughNotificationSequence` (QA-08). A notification tap routes to its conversation after startup/session restoration; a removed conversation shows an error. Notifications for the currently visible conversation do not show another banner.

Apple controls background execution. Silent pushes are low priority, may be coalesced or delayed, and do not provide an immediate-clearing guarantee when the app is force-quit or background execution is unavailable. Foreground reconciliation supplies the catch-up path. See [Apple's background push guidance](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app).

## Deployment prerequisites

1. Apply the updated Prisma schema using the project's normal database deployment. New `PushDevice` columns are `provider` (defaults to `expo` for existing clients), `apnsEnvironment`, `apnsTopic`, and `notificationScope`.
2. Configure the worker with `OPENTEAM_APNS_KEY_ID`, `OPENTEAM_APNS_TEAM_ID`, `OPENTEAM_APNS_TOPIC=dev.openbot.mobile` for TestFlight, and `OPENTEAM_APNS_PRIVATE_KEY`. Use `dev.openteam.mobile.swift` only for the separate Debug app. A private-key file via `OPENTEAM_APNS_PRIVATE_KEY_FILE` is also supported for a directly managed worker. Keep the .p8 key in your secret manager; do not commit it. Docker Compose passes the environment-based settings through to the worker.
3. Set the Apple Developer signing team for **both** `OpenTeamNative` and `OpenTeamNotifications`. Provision the app's Push Notifications and Communication Notifications entitlements and the extension's Communication Notifications entitlement. The app also declares the Remote notifications background mode. The extension ID is `dev.openteam.mobile.swift.notifications`.
4. Debug registers against APNs development; Release/TestFlight registers against production. The `APNS_ENVIRONMENT` build setting supplies both the entitlement and the registration value. Override them together for a custom distribution setup.
5. Deploy the compatible server/worker and install the signed app. Permission granted and registration accepted alone do not establish that APNs credentials are configured correctly.

## Verification and limits

Evidence is in `output/swift-native-push-0916/`.

The later [live-server follow-up](LIVE-SERVER-QA.md) also passes real native registration, desktop read API/event-stream reconciliation and selective Notification Center removal against current production services and PostgreSQL. Two delivered alerts become one and then zero while the iOS app stays open. Simulator injection replaces only Apple delivery; signed-device/background acceptance remains open. Its evidence is in `output/swift-live-gestures-0916/LiveReadSync-Acceptance.xcresult`.

- **31 Swift core tests passed**, including six cursor/scope/coalescing/ordering tests.
- **35 backend and legacy-client tests passed**, plus **1 production-service/worker/PostgreSQL integration test** covering mixed Expo/APNs fan-out and desktop read synchronization.
- **5 focused native UI tests passed; 1 background-only test skipped**. Verified the real delivered-notification list changing from four alerts to three on a partial read, then zero on full reads; badges changed 4 → 3 → 0. Also verified missed-wake foreground recovery, registration error/retry, off/on and disconnect, active-chat suppression, and a real notification tap launching the terminated app into the correct conversation. The tap test observed the actual Swift read request carrying `throughNotificationSequence=123`.
- **3 existing login/chat/settings UI regression checks passed** (`Regression.xcresult`), covering expired login with draft retention, failed logout, send acknowledgment recovery, appearance, search and creation.
- Worker/server TypeScript checks, the simulator build, and the unsigned Release iPhone build passed. The Release bundle contains the extension/artwork, `APNsEnvironment=production`, and the remote-notification background mode.

The focused UI result is `NativePush-Acceptance.xcresult`; the skipped callback has an attached receipt and is preserved in `simulator-summary.json`. Screenshots and real notification-center observations are exported under `evidence/`. The checks include Swift read-policy tests, APNs JWT/header/payload/retry tests, legacy Expo tests, a production-service/worker/PostgreSQL integration test, and simulator checks against the actual `UNUserNotificationCenter` delivered list. No message model or real account/provider is used in the fixtures.

The optional `NativePush` scheme uses a synthetic native token and independent loopback fixtures at ports 20015/20016. Normal UI tests do not ask for push permission. The cold-launch fixture restores a one-use, credential-free loopback session because SpringBoard does not preserve XCTest launch arguments; it never writes a real Keychain session. All app-side QA hooks are compiled out of Release.

This iOS simulator runtime inconsistently invokes background callbacks for injected notifications and rejects some content-available-only wakes. The fixture adds a badge to simulator wake probes; the production transport is separately asserted to send **only** `content-available` in the background push's `aps`. The background-only test reports a skip when the simulator does not execute the callback. That skip is not signed-device acceptance.

Run the simulator fixtures in separate terminals:

```sh
SWIFT_PARITY_PORT=20015 bun apps/mobile-swift/scripts/parity-server.ts
SWIFT_PUSH_QA_SIMULATOR=<simulator-udid> bun apps/mobile-swift/scripts/native-push-fixture.ts
xcodebuild -project apps/mobile-swift/OpenTeamNative.xcodeproj -scheme NativePush \
  -destination 'platform=iOS Simulator,id=<simulator-udid>' \
  -derivedDataPath apps/mobile-swift/.build-ios -parallel-testing-enabled NO \
  -resultBundlePath output/native-push-new-run.xcresult CODE_SIGNING_ALLOWED=NO test
```

Physical-device acceptance must cover an actual reply/routine notification while locked, desktop read removal with the app backgrounded, partial reads preserving newer alerts/reactions, multi-conversation coalescing, missed-wake foreground catch-up, denied permission, token rotation/reinstall, expired login, notification taps after termination, and sign-out/server-switch retirement. Keep QA-01 open until those delivery checks pass; the implementation gap itself is addressed.
