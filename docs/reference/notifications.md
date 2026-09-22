# Message and reaction notifications

iOS and desktop consume the same persisted `ChannelNotification` activity. Each
user-visible agent message and each added reaction to a user's message has its own
identity. Completing the run reuses the message identity, so completion does not
produce a second alert. Agent-to-agent transcript projections stay excluded.
Bot notification settings and hidden or archived conversations control delivery.

The server sends native iOS alerts through APNs and retains Expo transport for older installed clients. Desktop displays native alerts from
the live activity projection, including when its macOS window is minimized or
closed into the background. Quitting desktop stops desktop alerts. Each client
suppresses alerts for its visible conversation; other conversations can alert.

Read receipts carry both a message sequence and a notification sequence. Reactions
use the latter because a new reaction can refer to a message read days earlier.
Both cursors advance monotonically. Clients acknowledge the activity they have
actually received; an older receipt cannot clear a newer message or reaction.

Queued pushes have a short grace period for read receipts and are checked again
under the push authorization lock before sending. Read, withdrawn, muted, and
resolved-approval alerts are skipped. Every delivered alert includes the sequences
needed for selective removal. Read synchronization updates badges and clears only
covered alerts on the other device.

iOS performs removal in the native Swift notification delegate, including when the
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
The checked-in iOS target enables `remote-notification` and embeds its notification service extension.
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
swift test --package-path apps/ios --filter NotificationReadTests
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
iOS embeds `OpenTeamNotifications`, which donates an incoming
`INSendMessageIntent` and updates the notification with its sender avatar. iOS
provides the small app badge and the system Notification Center layout. Both the
app and extension enable Communication Notifications and are signed by the native Xcode release job. The worker sends `mutableContent` and a
conversation `threadId`. An extension timeout or donation failure falls back to
the original alert, retaining message delivery and read-state metadata.

The extension draws the same artwork as the profile UI. Regenerate its bundled
artwork after editing design tokens:

```sh
bun apps/ios/NotificationService/generate-notification-artwork.ts
```

Desktop renders those same shapes into PNG icons before handing alerts to Electron,
and supplies the conversation group and durable notification ID. The OS controls
the final desktop placement; the iOS communication layout is platform specific.

Validation includes the production iOS Release simulator build, an isolated
XCTest app exercising the production extension entry point and displaying its
returned communication content, shared artwork/payload tests, and the database
cross-device integration test. `simctl push` checks plain delivery but does not
invoke notification service extensions; it cannot validate remote avatar decoration. Simulator pushes do not validate Expo/APNs production credentials or delivery
to a physical iPhone. Signing the new binary must provision the communication
capability for both `dev.openbot.mobile` and `dev.openbot.mobile.notifications`.
