# Message and reaction notifications

iOS and desktop consume the same persisted `ChannelNotification` activity. Each
user-visible agent message and each added reaction to a user's message has its own
identity. Completing the run reuses the message identity, so completion does not
produce a second alert. Agent-to-agent transcript projections stay excluded.
Bot notification settings and hidden or archived conversations control delivery.

The server sends mobile alerts through Expo. Desktop displays native alerts from
the live activity projection, including when its macOS window is minimized or
closed into the background. Quitting desktop stops desktop alerts. Each client
suppresses alerts for its visible conversation; other conversations can alert.

Outbox claims have a two-minute lease so a worker crash cannot strand a delivery.
Expired final attempts become failed jobs. Claim and retry schedules use UTC even
when PostgreSQL's session time zone differs. Each alert uses a collapse identifier
for its individual activity: retrying that activity replaces its existing entry;
different messages and reactions are not collapsed together. Read synchronization
pushes have no shared collapse identifier because they carry individual channel reads.

Push receipts are tied to the exact token and registration timestamp used to send
the alert. A late `DeviceNotRegistered` error cannot disable a replacement token or
a subsequently renewed registration. Legacy receipts without that identity record
their error but do not disable a potentially newer registration.

Read receipts carry both a message sequence and a notification sequence. Reactions
use the latter because a new reaction can refer to a message read days earlier.
Both cursors advance monotonically. Clients acknowledge the activity they have
actually received; an older receipt cannot clear a newer message or reaction.

Queued pushes have a short grace period for read receipts and are checked again
under the push authorization lock before sending. Read, withdrawn, muted, and
resolved-approval alerts are skipped. Every delivered alert includes the sequences
needed for selective removal. Read synchronization updates badges and clears only
covered alerts on the other device.

Mobile previews also have an encoded byte budget, including JSON escaping, so
long joined emoji and combining characters cannot exceed APNs' 4 KiB limit.
The visible alert and custom data use the same bounded text. Renderer-only avatar
PNGs are never included in the push payload.

iOS performs removal in a native Expo app delegate subscriber, including when the
system wakes the app for a background notification. Read cursors persist locally
and tolerate reordered pushes. The app also reconciles on foreground sync. Apple
can delay or discard background pushes and does not wake a force-quit app; therefore
immediate cross-device removal in those states is best effort. A visible push
already accepted by APNs cannot be recalled by the server. See Apple's
[background notification delivery guidance](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app)
and [Expo's push delivery documentation](https://docs.expo.dev/push-notifications/sending-notifications/).

## Rollout

Deploy the database schema before the updated server and worker (`bun run db:deploy`).
Rebuild desktop and the iOS native app. The native iOS change requires a new binary;
JavaScript-only updates cannot install the background subscriber. Expo's notification
config enables `remote-notification`, and CocoaPods autolinking registers the subscriber.
Older clients can still mark messages read; they cannot acknowledge new reaction activity.

## Verification

`apps/worker/test/cross-device-notifications.integration.test.ts` exercises the
actual SendToUser and reaction paths, PostgreSQL, two registered device destinations,
the push dispatcher, and desktop delivery/dismissal. Expo HTTP is replaced by a
recording transport, so this test never sends notifications to real devices.
Run it against a dedicated migrated database using `OPENTEAM_TEST_DATABASE_URL`.

Client tests cover unchanged-message reaction reads, partial reads, monotonic
cursors, late foreground alerts, and retrying failed native cleanup. The Swift
policy can also be checked directly on macOS:

```sh
swiftc apps/mobile/modules/openteam-native/ios/OpenTeamNotificationSubscriber.swift \
  apps/mobile/test/notification-read-policy.swift -o /tmp/openteam-notification-policy-test
/tmp/openteam-notification-policy-test
```

Physical-device acceptance checks: enable notifications on both apps, receive a
message and a reaction with neither conversation visible, read on each device in
turn, and verify the other device's badge and Notification Center. Repeat while
iOS is suspended, offline, and force-quit, allowing foreground reconciliation in
states where Apple declines to wake the app.

## Sender presentation

Alerts use the bot name as the title for messages, reactions, and requests for
input. Attachment previews include the filename when there is one attachment.
The push carries the bot's robot shape and color, without an authenticated image
URL or an image download. Uploaded custom photos currently fall back to that robot.

Following [Apple’s communication notification API](https://developer.apple.com/documentation/usernotifications/implementing-communication-notifications),
iOS embeds `OpenTeamNotificationService`, which donates an incoming
`INSendMessageIntent` and updates the notification with its sender avatar. iOS
provides the small app badge and the system Notification Center layout. Both the
app and extension enable Communication Notifications; the Expo config plugin also
registers the extension for EAS signing. The worker sends `mutableContent` and a
conversation `threadId`. An extension timeout or donation failure falls back to
the original alert, retaining message delivery and read-state metadata.

The extension draws the same artwork as the profile UI. Regenerate its bundled
artwork after editing design tokens:

```sh
bun apps/mobile/notification-service/generate-notification-artwork.ts
```

Desktop renders those same shapes into PNG icons before handing alerts to Electron,
and supplies the conversation group and durable notification ID. The OS controls
the final desktop placement; the iOS communication layout is platform specific.
Electron 43.4.1 implements the macOS `icon` option as a notification image attachment,
not an Apple communication sender avatar. The iOS avatar treatment in the reference
image comes from the communication extension; macOS does not have identical placement.
The ID includes the message/activity read identity. On macOS startup, surviving
Notification Center entries are restored and reconciled against the first server
snapshot, even if they fall outside its bounded notification history. Removal uses
the OS identifier and does not depend on an in-memory notification handle.

Validation includes the production iOS Release simulator build, an isolated
XCTest app exercising the production extension entry point and displaying its
returned communication content, shared artwork/payload tests, and the database
cross-device integration test. `simctl push` checks plain delivery but does not
invoke notification service extensions; it cannot validate remote avatar decoration. Simulator pushes do not validate Expo/APNs production credentials or delivery
to a physical iPhone. Signing the new binary must provision the communication
capability for both `dev.openbot.mobile` and `dev.openbot.mobile.notifications`.

### Revalidation on September 14, 2026

- 77 focused tests passed against an isolated PostgreSQL database, including two
  push destinations, partial reads, reactions to older messages, stale queued
  alert cancellation, desktop history restoration, and encoded payload limits.
  The Expo transport was recorded locally; these were not real APNs sends.
- A separate iOS XCTest host compiled the production communication extension and
  native read reconciler. Notification Center delivery, partial message removal,
  reaction removal, preservation of a newer unread message, reordered reads,
  and persisted cleanup after process relaunch all passed.
- Actual macOS delivery remains unverified: the isolated ad-hoc Electron test app
  received `Notifications are not allowed for this application`. No valid Apple
  signing identity was available locally. Desktop manager tests and typechecking
  passed; that is not evidence of OS delivery.
- The inspected local deployment was still running older server/worker images
  and had zero registered push devices. No physical iPhone was connected.
  The new binaries, schema/server/worker rollout, token registration, and a real
  two-device acceptance test are still required before declaring the installed
  setup ready. Even then, immediate iOS background clearing is subject to Apple's
  delivery policy described above.

### Research and release checks later on September 14

The follow-up audit passed **80 focused tests** and worker typechecking. Added database
cases exercise token replacement, same-token renewal, late legacy receipts, expired
worker claims, exhausted retries, and UTC scheduling with PostgreSQL sessions in UTC,
America/New_York, and Asia/Tokyo. Payload tests verify that retries share an activity
collapse ID, distinct activities keep distinct IDs, and IDs fit APNs' 64-byte limit.

Expo reports build **0.0.1 (7)** finished. Inspection of the saved distribution IPA
confirmed valid app and extension signatures, production `aps-environment` on the
host, Communication Notifications in both provisioning profiles and signed
entitlements, `INSendMessageIntent` activity declarations, the embedded service
extension, `remote-notification` background mode, and native/JavaScript read-sync
code. The provisioning profiles expire on September 2, 2027. Expo has a push key
configured for the host app, matching the binary's Apple signing team. The extension
does not need its own push key. These
checks establish binary/configuration readiness, not successful delivery to a phone.

The local server and worker still use `openteam-memory-*:20260913.2`; its database
does not yet have `ChannelNotification` and has zero registered push devices. No
physical iPhone or local Apple signing identity is available for the final
two-device test. This feature branch remains separate from `main`.

The reviewed primary sources support the design and its limits:

- [Apple background updates](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app):
  background execution is not guaranteed, updates may be throttled, and an older
  held update can be discarded. A missed channel-read push is repaired by the
  app's next foreground synchronization; clearing while suspended is best effort.
- [Expo delivery and receipts](https://docs.expo.dev/push-notifications/sending-notifications/):
  tickets/receipts report provider acceptance, not proof that a user saw an alert;
  invalid tokens must be retired, payloads are limited to 4 KiB, and `collapseId`
  replaces matching iOS notifications. The legacy `_contentAvailable` spelling
  remains supported by Expo.
- [Apple communication notifications](https://developer.apple.com/documentation/usernotifications/implementing-communication-notifications):
  sender avatars require the communication capability, intent declarations, and
  notification content updated from the donated communication intent.
- [Electron's macOS notification implementation at 43.4.1](https://github.com/electron/electron/blob/v43.4.1/shell/browser/notifications/mac/cocoa_notification.mm):
  notification icons become image attachments. Native placement and authorization
  remain OS-controlled; read cleanup uses delivered notification identifiers.
