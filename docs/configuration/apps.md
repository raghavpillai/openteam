# Settings and notifications

Use app settings for your device, bot settings for a particular bot, and server settings for behavior shared across the installation.

## Change app settings

| Where | What to change |
| --- | --- |
| Desktop: Settings → General | Appearance, microphone settings, auto-review, and review rules |
| Desktop: Settings → Computer | Local execution permission, computer connections, and native capabilities |
| Desktop: Settings → Server | Model provider, search, transcription, and other server configuration |
| Desktop: Settings → Updates | Desktop and server updates |
| Mobile: Settings | Appearance, notification preferences, and the private server connection |

Appearance and local-computer permissions belong to the device. Model and service configuration belongs to the server. Changing the model affects new work from every connected app.

## Change a bot's profile

Open the bot's settings to edit its name, description, and avatar. Use the bot's notification control when you want fewer alerts from that conversation.

Hiding a bot changes its visibility in navigation. It does not pause its routines or stop the server. Use the task or routine controls for that.

## Enable notifications

Allow OpenTeam notifications in your operating system, then check the app and bot notification settings. Alerts depend on the conversation and its read state; the app avoids notifying you for work you are already viewing.

Mobile push also requires a native app build configured for push delivery. If you built the mobile app yourself, complete the [mobile notification setup](../../apps/mobile/README.md) before relying on background alerts.

## Fix missing alerts

Check, in order:

1. The bot's notifications are enabled and the conversation is not hidden.
2. OpenTeam has notification permission in the operating system.
3. Focus or Do Not Disturb is not silencing the app.
4. The server and, for mobile, its push configuration are working.

Group-chat activity follows a quieter notification policy than direct bot conversations. Check the conversation itself when you are waiting for a result.

## Change servers or sign out

Use the desktop sign-in screen to connect to a different server. On mobile, open **Settings → Private connection**. Each server has its own owner account and data; entering another URL does not move your bots or history.
