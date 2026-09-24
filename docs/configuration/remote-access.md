# Remote access

Your apps connect to the server through its server URL. Choose a connection mode based on where your devices are: at home, on a VPN, or anywhere on the internet.

## Choose a connection mode

| Mode | Use it when |
| --- | --- |
| **Private network** (default, unless setup finds Tailscale HTTPS) | Your devices are on the same home or office network, or on a VPN such as Tailscale |
| **This machine only** | The server and the desktop app run on the same computer |
| **Public domain with automatic HTTPS** | You have a domain and want to reach the server from anywhere |
| **Use my existing HTTPS setup** | You already run a reverse proxy, or use [Tailscale HTTPS](#tailscale-https) |
| **Public address without HTTPS** | Only for testing. Your password and conversations travel unencrypted. |

To change the mode, run this on the server host:

```sh
openteam setup --advanced
```

A URL with `localhost` or `127.0.0.1` only works on the server itself. Your phone and other computers need the server's network address.

## Private network

Setup picks the host's private address and prints a URL such as `http://192.168.1.20:8787`. Any device on the same network can connect.

To connect while you're away, put the host and your devices on a private VPN such as [Tailscale](https://tailscale.com). Setup prefers a Tailscale address when it finds one.

## Tailscale HTTPS

If Tailscale is running on the host and HTTPS is turned on for your tailnet, setup uses the host's `https://<name>.ts.net` address through [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve), and sets the connection mode to **Use my existing HTTPS setup**. Only devices on your tailnet can reach it. HTTPS also makes plugin sign-in simpler, because services such as Google can return you straight to your server.

In this mode, the server only accepts connections from the host itself, which Tailscale Serve forwards to, so the old `http://` network address stops working. Use the `https://` address on all your devices.

Setup leaves existing Serve routes and Funnel settings alone. If port 443 is already in use in Serve, or HTTPS can't be set up, it keeps the private network address.

## Public domain with automatic HTTPS

1. Point your domain's DNS record at the server.
2. Allow inbound TCP ports **80** and **443** to the server.
3. Run `openteam setup --advanced`, choose **Public domain with automatic HTTPS**, and enter the domain.
4. Setup starts a proxy that gets a certificate for the domain.
5. Enter the `https://` URL in your apps.

If something else on the host already uses ports 80 or 443, stop it first or use your own proxy instead.

## Use your own HTTPS proxy

Choose **Use my existing HTTPS setup** and enter your public hostname. Point your proxy at the local address setup shows, usually `http://127.0.0.1:8787`, and forward both HTTP and WebSocket traffic. Set up the proxy before you confirm, because setup checks the `https://` address at the end.

If your proxy runs on a different machine, see the [server configuration reference](../reference/server-configuration.md) for the extra settings it needs.

## Keep it secure

- Use HTTPS for any address that's reachable from the internet.
- Use a strong password. Anyone who signs in can control your bots and their accounts.
- In **Private network** mode, bot screen ports `6200–6299` are open on your local network. Don't forward them from your router.

After you change the connection, run `openteam status` to confirm the new URL, then reconnect your apps. If they can't connect, see [troubleshooting](../manage/troubleshooting.md#the-app-cant-connect).
