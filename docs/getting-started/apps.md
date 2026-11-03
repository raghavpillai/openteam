# Desktop and mobile

The OpenTeam apps connect to your server. Sign in from as many devices as you like; they all show the same bots and conversations.

## Desktop

Download the desktop app from [openteam.so/download](https://openteam.so/download). It's available for macOS (Apple silicon) and Linux (x64 AppImage). Windows and Intel Mac builds aren't available yet.

1. Open the app, choose **Log In**, and enter your server URL under **Server address**. You can leave off `http://`. If you don't have it, run `openteam status` on the server and use the **Server** address under **Connection**. If the server runs on the same computer, the app finds it for you.
2. Sign in with the username and password you created during setup.
3. The first time, a short setup checks your server, connects an AI model, offers voice notes, and creates your first bot, one screen at a time. See the [quickstart](quickstart.md).

The desktop app does everything: chat, watching bots' screens, plugins, routines, and all settings. It's also how bots [work on your own computer](../usage/computer.md#use-your-own-computer), so keep it open when they do.

## iPhone

The iPhone app is in public beta on TestFlight. It needs iOS 18 or later.

1. Install [TestFlight](https://apps.apple.com/app/testflight/id899247664) from the App Store.
2. On your iPhone, open the [OpenTeam beta invite](https://testflight.apple.com/join/KFBFPkjP) and choose **Accept**, then **Install**.

You can also build the app yourself with Xcode by following the [iPhone app instructions](../../apps/ios/README.md).

Enter your server URL and sign in. If the server has no model or bots yet, the app walks you through connecting a model and creating your first bot. On iPhone, you can:

- Chat with bots, send files and photos, and dictate messages with voice notes
- Answer questions and forms
- Watch a bot's screen and take control when it needs you
- Add, edit, and run routines
- Set up plugins and private skills
- Connect or change the model in **Settings → Model**, and set up voice notes in **Settings → Voice notes**

On iPhone, ChatGPT sign-in shows a code to enter on the sign-in page. Remote access and computer settings are on desktop.

## Connect from another device

Your phone or laptop needs an address it can reach the server at:

- **At home:** use the private network address from setup, such as `http://192.168.1.20:8787`.
- **Away from home:** connect through a VPN such as Tailscale, or give your server an HTTPS address.

A `localhost` or `127.0.0.1` address only works on the server itself. See [remote access](../configuration/remote-access.md) for all the options.

OpenTeam doesn't encrypt plain `http://` addresses. That's fine on your home network, and Tailscale encrypts traffic for you. Use HTTPS for anything reachable from the internet.

## Notifications

To get alerts when a bot messages you, see [notifications](../configuration/apps.md#notifications). For iPhone push credentials and server setup, follow [mobile notifications](../configuration/mobile-notifications.md).
