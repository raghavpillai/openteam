# Desktop and mobile

The OpenTeam apps connect to your server. Sign in from as many devices as you like; they all show the same bots and conversations.

## Desktop

Download the desktop app from [openteam.so/download](https://openteam.so/download). It's available for macOS (Apple silicon), Windows (x64), and Linux (x64 AppImage).

1. Open the app, choose **Log In**, and enter your server URL under **Server address**. If you don't have it, run `openteam status` on the server and use the **Server** address under **Connection**.
2. Sign in with the username and password you created during setup.

The desktop app does everything: chat, watching bots' screens, plugins, routines, and all settings. It's also how bots [work on your own computer](../usage/computer.md#use-your-own-computer), so keep it open when they do.

## iPhone

The iPhone app isn't in the App Store yet. To use it now, build it from source with Xcode by following the [iPhone app instructions](../../apps/ios/README.md).

Enter your server URL and sign in. On iPhone, you can:

- Chat with bots, send files and photos, and dictate messages with voice notes
- Answer approval requests
- Watch a bot's screen and take control when it needs you
- Add, edit, and run routines
- Set up plugins and private skills

Use the desktop app to change server settings such as the model, web search, and transcription.

## Connect from another device

Your phone or laptop needs an address it can reach the server at:

- **At home:** use the private network address from setup, such as `http://192.168.1.20:8787`.
- **Away from home:** connect through a VPN such as Tailscale, or give your server an HTTPS address.

A `localhost` or `127.0.0.1` address only works on the server itself. See [remote access](../configuration/remote-access.md) for all the options.

OpenTeam doesn't encrypt plain `http://` addresses. That's fine on your home network, and Tailscale encrypts traffic for you. Use HTTPS for anything reachable from the internet.

## Notifications

To get alerts when a bot finishes or needs you, see [notifications](../configuration/apps.md#notifications).
