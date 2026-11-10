# Remote access

Your apps connect to the server through its server URL. Choose a connection mode based on where your devices are: at home, on a VPN, or anywhere on the internet.

## Choose a connection mode

| Mode | Use it when |
| --- | --- |
| **Private network** | Your devices are on the same home or office network, or on a VPN such as Tailscale |
| **This machine only** | The server and the desktop app run on the same computer |
| **Public domain with automatic HTTPS** | You have a domain and want to reach the server from anywhere |
| **Tailscale HTTPS** | Create a private HTTPS address through [Tailscale Serve](#tailscale-https) |
| **Use my existing HTTPS setup** | You already run a reverse proxy |
| **Public address without HTTPS** | Only for testing. Your password and conversations travel unencrypted. |

To change the mode, run this on the server host:

```sh
openteam setup
```

A URL with `localhost` or `127.0.0.1` only works on the server itself. Your phone and other computers need the server's network address.

## Private network

Setup picks the host's private address and prints a URL such as `http://192.168.1.20:8787`. Any device on the same network can connect.

To connect while you're away, put the host and your devices on a private VPN such as [Tailscale](https://tailscale.com). Setup prefers a Tailscale address when it finds one.

## Tailscale HTTPS

Choose **Tailscale HTTPS** in `openteam setup`, or use **Settings → Server → Remote access** in the desktop app on the server host. Setup suggests it when it detects Tailscale; you review the choice and HTTPS port before applying it.

You can also manage it directly on the server host:

```sh
openteam tailscale enable                    # HTTPS port 443, or the current configured port
openteam tailscale enable --https-port 14443  # choose another port
openteam tailscale status                    # inspect route ownership and verify HTTPS
openteam tailscale disable                   # return to local access
```

All commands accept `--dir <installation-folder>` and `--json`. When connected to a remote server, desktop settings show the commands to run on that host.

Install and sign in to Tailscale on the host and your devices. Enable MagicDNS and HTTPS certificates in your [tailnet DNS settings](https://login.tailscale.com/admin/dns). OpenTeam reports missing prerequisites and permission problems; it does not install Tailscale or sign in for you.

OpenTeam adds a private Serve mapping to the server and gives you an address like `https://<machine>.<tailnet>.ts.net` (with a port suffix for a custom port). The API and screen ports stay on loopback, so the LAN HTTP address stops working. Reconnect your apps with the displayed HTTPS address and update any registered OAuth redirect URIs; plugin sign-in uses it too.

Enabling or changing the connection restarts services and can interrupt tasks. OpenTeam checks that the HTTPS address works before reporting success. If it doesn't, the previous configuration is restored and the error is reported; it never silently switches you to HTTP.

OpenTeam keeps the rest of your Serve and Funnel configuration as it is, and never turns on Funnel. If the chosen port is taken, pick another HTTPS port. If you already have a matching route, OpenTeam reuses it. Disabling removes only mappings OpenTeam created and that haven't been changed since; **routes you set up yourself stay active** until you remove them. OpenTeam records the mappings it owns in `tailscale-routes.json` in the install directory, so keep that file with your [backups](../manage/backups.md).

Serve mappings survive restarts. `openteam status`, `openteam doctor`, and `openteam tailscale status` detect missing or changed mappings; run `openteam tailscale enable` to repair a missing one. Before switching from Tailscale to automatic HTTPS on the same port, run `openteam tailscale disable`.

## Public domain with automatic HTTPS

1. Point your domain's DNS record at the server.
2. Allow inbound TCP ports **80** and **443** to the server.
3. Run `openteam setup`, choose **Public domain with automatic HTTPS**, and enter the domain.
4. Setup starts a proxy that gets a certificate for the domain.
5. Enter the `https://` URL in your apps.

If something else on the host already uses ports 80 or 443, stop it first or use your own proxy instead.

## Use your own HTTPS proxy

Choose **Use my existing HTTPS setup** and enter your public hostname. Point your proxy at the local address setup shows, usually `http://127.0.0.1:8787`, and forward both HTTP and WebSocket traffic. Set up the proxy before you confirm, because setup checks the `https://` address at the end.

## Keep it secure

- Use HTTPS for any address that's reachable from the internet.
- Use a strong password. Anyone who signs in can control your bots and their accounts.
- In **Private network** mode, bot screen ports `6200–6299` are open on your local network. Don't forward them from your router.

After you change the connection, run `openteam status` to confirm the new URL, then reconnect your apps. If they can't connect, see [troubleshooting](../manage/troubleshooting.md#the-app-cant-connect).
