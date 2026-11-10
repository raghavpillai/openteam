# Desktop and mobile

The OpenTeam apps connect to your server. Sign in from as many devices as you like; they all show the same bots and conversations.

## Desktop

Download the desktop app from [openteam.so/download](https://openteam.so/download). It's available for macOS (Apple silicon) and Linux (x64 AppImage). There's no Windows or Intel Mac app; you can still run the server on Windows and connect from another device.

1. Open the app and choose **Get started**. If the server runs on the same computer, the app finds it for you. Otherwise, enter your server URL under **Server address** and choose **Connect**. You can leave off `http://`. If you don't have the URL, run `openteam status` on the server and use the **Server** address under **Connection**.
2. Sign in with the username and password you created during setup.
3. The first time, a short setup checks your server, connects an AI model, offers web search and voice notes, and creates your first bot, one screen at a time. You can skip web search and voice notes. See the [quickstart](quickstart.md).

The desktop app does everything: chat, watching bots' screens, plugins, routines, and all settings. It's also how bots [work on your own computer](../usage/computer.md#use-your-own-computer), so keep it open when they do.

## iPhone

The iPhone app is in public beta on TestFlight. It needs iOS 18 or later.

1. Install [TestFlight](https://apps.apple.com/app/testflight/id899247664) from the App Store.
2. On your iPhone, open the [OpenTeam beta invite](https://testflight.apple.com/join/KFBFPkjP) and choose **Accept**, then **Install**.

You can also build the app yourself with Xcode by following the [iPhone app instructions](../../apps/ios/README.md).

Enter your server URL and sign in. If the server has no model or bots yet, the app walks you through the same setup as desktop: a server check, an AI model, web search and voice notes (both optional), and your first bot. On iPhone, you can:

- Chat with bots, send files and photos, and dictate messages with voice notes
- Start a group chat with **+**, then **New Group Chat**
- Answer questions and forms
- Watch a bot's screen and take control when it needs you
- Add, edit, and run routines
- Set up plugins and private skills
- Connect or change the model in **Settings → Model**, and set up voice notes in **Settings → Voice notes**

On iPhone, ChatGPT sign-in shows a code to enter on the sign-in page. **Settings → Server** manages your connected computers and, under **Browser network**, the order of internet connections the bot computer uses. A computer joins that order after you turn on **Share this computer’s connection** in the desktop app's **Settings → Server** on that computer.

### Shortcuts, Siri, and Spotlight

In the Shortcuts app, OpenTeam has actions to open a Bot or a conversation, record a voice note, send a task, run a saved routine, and find messages. Choose a fixed Bot in a saved shortcut to run it with Back Tap or the Action button. Actions need an unlocked iPhone, and sending, searching, and running routines need your server. A voice note shortcut opens the composer; you decide when to send.

The **Siri and Spotlight** switch in Settings lets Siri understand visible messages and lets Spotlight find recent conversations and messages on this iPhone. Turning it off or signing out clears that content.

## Connect from another device

Your phone or laptop needs an address it can reach the server at:

- **At home:** use the private network address from setup, such as `http://192.168.1.20:8787`.
- **Away from home:** connect through a VPN such as Tailscale, or give your server an HTTPS address.

A `localhost` or `127.0.0.1` address only works on the server itself. See [remote access](../configuration/remote-access.md) for all the options.

OpenTeam doesn't encrypt plain `http://` addresses. That's fine on your home network, and Tailscale encrypts traffic for you. Use HTTPS for anything reachable from the internet.

## Notifications

To get alerts when a bot messages you, see [notifications](../configuration/apps.md#notifications). For iPhone push credentials and server setup, follow [mobile notifications](../configuration/mobile-notifications.md).
