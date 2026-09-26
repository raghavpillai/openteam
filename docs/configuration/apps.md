# Settings and notifications

Some settings apply to one device, some to one bot, and some to your whole server. This page shows where each lives.

## Desktop settings

| Tab | What's there |
| --- | --- |
| **General** | Your account and sign out, theme, microphone, and [auto-review](approvals.md#auto-review) |
| **Computer** | Whether bots can use this computer, other connected computers, the bot screen size, saved logins, and Mac access |
| **Server** | Model provider, model and reasoning, event subscriptions, and transcription |
| **Providers** | Which service bots use for [web search and page fetching](web-search.md), and those services' API keys |
| **Updates** | Desktop app and server updates |

**Server** and **Providers** settings and auto-review apply to every bot and every app connected to your server; changing the model there changes it for all bots. Theme, microphone, **Execution on this computer**, and Mac access apply only to the device you're using. The bot screen size and the list of connected computers apply to your whole server.

Each bot also has its own settings. Open the bot and select its name at the top of the conversation to change its name, label, avatar, description, and notifications.

## iPhone settings

The iPhone app's **Settings** covers plugins, appearance, notifications, and your account. Auto-review rules are under **More preferences**. You can also unhide conversations and see your server's status. Change server settings such as the model on desktop.

## Notifications

To get notified when a bot finishes or needs your input:

1. Allow OpenTeam to send notifications in your device's system settings.
2. Open the bot, select its name at the top of the conversation, and check that **Notifications** is on. It's on by default.

You won't get alerts for the conversation you're looking at. Group chats don't have their own setting; you're notified when a bot posts in a group if that bot's **Notifications** setting is on.

On iPhone, turn on **Notifications** in Settings, and choose which bots notify you under **Bot notifications**. These are the same per-bot settings as on desktop. Push notifications also need Apple push credentials on your server, which currently means [running the server from source](../development/from-source.md). See the [server configuration reference](../reference/server-configuration.md).

### If notifications don't arrive

1. Check that the bot's **Notifications** setting is on.
2. Check that OpenTeam is allowed to send notifications in your system settings.
3. Check that Focus or Do Not Disturb isn't silencing it.
4. Check that the bot or conversation isn't hidden from the sidebar. Hidden bots don't send notifications.
5. On iPhone, check that your server is set up for push notifications.

## Sign out or switch servers

- **Desktop:** open **Settings → General** and choose **Sign Out**. Then enter a different **Server address** when you sign in.
- **iPhone:** open **Settings** and choose **Sign out**. To change servers, open your account and choose **Re-auth**, which clears the app's local data so you can sign in again.

Each server has its own account and data. Connecting to a different server doesn't move your bots or conversations.
