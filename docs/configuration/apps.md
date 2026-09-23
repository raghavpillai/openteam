# Settings and notifications

Some settings apply to one device, some to one bot, and some to your whole server. This page shows where each lives.

## Desktop settings

| Tab | What's there |
| --- | --- |
| **General** | Your account and sign out, theme, microphone, and [auto-review](approvals.md#auto-review) |
| **Computer** | Whether bots can use this computer, other connected computers, and saved logins |
| **Server** | Model provider, model and reasoning, web search, web fetch, event subscriptions, and transcription |
| **Updates** | Desktop app and server updates |

**Server** settings and auto-review apply to every bot and every app connected to your server. Changing the model there changes it for all bots.

Each bot also has its own settings. Open the bot and select its name at the top of the conversation to change its name, avatar, description, and notifications.

## iPhone settings

The iPhone app's **Settings** covers plugins, theme, notifications, and your account. It also lets you edit auto-review rules, unhide conversations, and see your server's status. Change server settings such as the model on desktop.

## Notifications

To get notified when a bot finishes or needs your input:

1. Allow OpenTeam to send notifications in your device's system settings.
2. Open the bot, select its name at the top of the conversation, and turn on **Notifications**.

You won't get alerts for the conversation you're looking at. Group chats don't have their own notification setting, so check the conversation when you're waiting on a group.

On iPhone, turn on **Notifications** in Settings, and choose which bots notify you under **Bot notifications**. Push notifications also need Apple push credentials on your server, which currently means [running the server from source](../development/from-source.md). See the [server configuration reference](../reference/server-configuration.md).

### If notifications don't arrive

1. Check that the bot's **Notifications** setting is on.
2. Check that OpenTeam is allowed to send notifications in your system settings.
3. Check that Focus or Do Not Disturb isn't silencing it.
4. On iPhone, check that your server is set up for push notifications.

## Sign out or switch servers

- **Desktop:** open **Settings → General** and choose **Sign Out**. Then enter a different server URL on the sign-in screen.
- **iPhone:** open **Settings** and choose **Sign out**. To change servers, open your account and choose **Re-auth**, which clears the app's local data so you can sign in again.

Each server has its own account and data. Connecting to a different server doesn't move your bots or conversations.
