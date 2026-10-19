# Settings and notifications

Some settings apply to one device, some to one bot, and some to your whole server. This page shows where each lives.

## Desktop settings

| Tab | What's there |
| --- | --- |
| **General** | Your account and sign out, theme, microphone |
| **Computer** | Whether bots can use this computer, other connected computers, the bot screen size, and Mac access |
| **Server** | Model provider, model and reasoning, event subscriptions, and transcription |
| **Providers** | Which service bots use for [web search and page fetching](web-search.md), and those services' API keys |
| **Updates** | Desktop app and server updates |

**Server** and **Providers** settings apply to every bot and every app connected to your server; changing the model there changes it for all bots. Theme, microphone, **Execution on this computer**, and Mac access apply only to the device you're using. The bot screen size and the list of connected computers apply to your whole server.

Each bot also has its own settings. Open the bot and select its name at the top of the conversation to change its name, label, avatar, description, and notifications.

## iPhone settings

The iPhone app's **Settings** covers plugins, appearance, notifications, and your account. You can also unhide conversations and see your server's status. Change server settings such as the model on desktop.

## Notifications

To get notified when a bot messages you:

1. Allow OpenTeam to send notifications in your device's system settings.
2. Open the bot, select its name at the top of the conversation, and check that **Notifications** is on. It's on by default.

On desktop, banners appear only while OpenTeam isn't the window you're using. Each conversation shows at most one banner every 5 seconds, so a burst of replies produces a single banner; replies inside that window don't get one later. Banners are silent, show the message's first line as plain text, and disappear once you read the chat on your Mac or iPhone. Reactions don't notify. On iPhone, you get an alert for each message except in the conversation you have open.

Group chats don't have their own setting; you're notified when a bot posts in a group if that bot's **Notifications** setting is on. On the Mac, a group's banner is titled with the group's name. Opening a notification for a reply inside a thread opens that thread.

On iPhone, turn on **Notifications** in Settings, and choose which bots notify you under **Bot notifications**. These are the same per-bot settings as on desktop. Push notifications also need Apple push credentials on your server, which you can import with `openteam notifications configure`. Changes apply live without a restart. Follow the [mobile notification setup guide](mobile-notifications.md) for Apple credentials, CLI configuration, and delivery checks.

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
