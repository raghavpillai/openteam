# Desktop and mobile

Connect your devices to the same OpenTeam server to continue working with the same bots and conversations.

## Desktop

Download an available build for your platform from [openteam.so/download](https://openteam.so/download). The download page lists the installers included in the current release.

1. Start the OpenTeam server, or get its URL from your existing installation.
2. Open the app and enter that URL.
3. Sign in with the owner username and password.
4. Open an existing conversation or create a bot.

The desktop app provides chat, screen viewing, plugins, routines, settings, and the connection for approved work on your physical computer. Keep it open when tasks need local computer access or delegated workers.

## Mobile

The mobile app is currently available from source. Follow the [mobile build instructions](../../apps/mobile/README.md) for a native development build; it is not yet distributed through the public download page as an App Store release.

Enter the server URL on the sign-in screen. In the app, **Settings → Private connection** lets you change the URL or sign out.

You can message bots, attach files or photos, review requests, view and take over a bot's screen, and manage routines. Server settings and plugin setup are easiest to complete on desktop.

## Connect from another device

The device must be able to reach the server. Use a reachable LAN address, your private VPN, or public HTTPS. A loopback URL such as `http://127.0.0.1:8787` only works on the server machine itself.

For mobile access away from home, keep the phone connected to your private VPN or use HTTPS. Public cleartext HTTP is rejected by the mobile connection policy. See [remote access](../configuration/remote-access.md).

## Notifications

See [settings and notifications](../configuration/apps.md#enable-notifications) to enable alerts and configure mobile push.
