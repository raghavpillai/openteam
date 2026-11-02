# Settings and notifications

Some settings apply to one device, some to one bot, and some to your whole server. This page shows where each lives.

## Desktop settings

| Tab | What's there |
| --- | --- |
| **General** | Your account and sign out, theme, microphone |
| **Computer** | The current computer's name and Messages access and permissions |
| **Model** | AI provider and account, model, reasoning effort, and connection test |
| **Voice notes** | Transcription provider, model, API key, language, and connection test |
| **Server** | Connected server version and a link to Updates, server activity, remote access, connected computers, and the bot screen size |
| **Providers** | Which service bots use for [web search and page fetching](web-search.md), and those services' API keys |
| **Updates** | Desktop app and server updates |

**Model**, **Voice notes**, **Server**, and **Providers** settings apply to every bot and every app connected to your server; changing the model there changes it for all bots. Theme, microphone, the current computer's name, and Messages access apply only to the device you're using. The bot screen size and the list of connected computers live in **Server** and apply to your whole server.

Each bot also has its own settings. Open the bot and select its name at the top of the conversation to change its name, label, avatar, and description.

## iPhone settings

The iPhone app's **Settings → Model** lets you connect an AI provider and choose and test the model and reasoning effort for every bot on your server. These are the same settings as **Settings → Model** on desktop. Settings also covers voice notes, web providers, plugins, appearance, notifications, your account, and hidden conversations.

**Settings → Server** shows the connected server's version, activity and services, with **Manage devices** for its connected computers and a **View updates** link. **Settings → Updates** contains server updates and a link to TestFlight for iOS app updates.

## Notifications

To get notified when a bot messages you:

1. Allow OpenTeam to send notifications in your device's system settings.
2. Every bot notifies you by default. To mute a bot, open **Settings → Bot notifications** in the iPhone app; the setting applies on every device.

On desktop, banners appear only while OpenTeam isn't the window you're using. Each conversation shows at most one banner every 5 seconds, so a burst of replies produces a single banner; replies inside that window don't get one later. Banners are silent, show the message's first line as plain text, and disappear once you read the chat on your Mac or iPhone. Reactions don't notify. On iPhone, you get an alert for each message except in the conversation you have open.

Group chats don't have their own setting; you're notified when a bot posts in a group if that bot's **Notifications** setting is on. On the Mac, a group's banner is titled with the group's name. Opening a notification for a reply inside a thread opens that thread.

On iPhone, turn on **Notifications** in Settings, and choose which bots notify you under **Bot notifications**. Push notifications also need Apple push credentials on your server, which you can import with `openteam notifications configure`. Changes apply live without a restart. Follow the [mobile notification setup guide](mobile-notifications.md) for Apple credentials, CLI configuration, and delivery checks.

### If notifications don't arrive

1. Check that the bot isn't muted under **Settings → Bot notifications** in the iPhone app.
2. Check that OpenTeam is allowed to send notifications in your system settings.
3. Check that Focus or Do Not Disturb isn't silencing it.
4. Check that the bot or conversation isn't hidden from the sidebar. Hidden bots don't send notifications.
5. On iPhone, check that your server is set up for push notifications.

## Sign out or switch servers

- **Desktop:** open **Settings → General** and choose **Sign Out**. Then enter a different **Server address** when you sign in.
- **iPhone:** open **Settings** and choose **Sign out**. To change servers, open your account and choose **Re-auth**, which clears the app's local data so you can sign in again.

Each server has its own account and data. Connecting to a different server doesn't move your bots or conversations.
