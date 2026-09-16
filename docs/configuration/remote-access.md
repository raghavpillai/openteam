# Remote access

Choose an address your apps can reach. A private LAN or VPN is the simplest starting point; use HTTPS for access over the public internet.

## Connection defaults

Setup detects a private address where possible and prints the server URL. Use that URL on devices connected to the same LAN or private VPN.

A URL containing `localhost` or `127.0.0.1` only reaches the device on which you enter it. Your phone needs the server's reachable address instead.

To change the connection mode, run this on the server host:

```sh
openteam setup --advanced
```

## Pick a connection mode

| Mode | Use it when |
| --- | --- |
| Private network | Your devices reach the host over a trusted LAN or VPN such as Tailscale |
| This machine only | The server and desktop app run on the same machine |
| Public HTTPS | You have a domain pointed at the server and want internet access |
| Existing HTTPS proxy | You already manage HTTPS with a reverse proxy |
| Public HTTP | You are deliberately testing without encryption; mobile rejects public cleartext URLs |

## Private network

Connect the server and client devices to the same trusted network. Enter the private server address in each app. For access while away from home, connect the device to your VPN first.

The default API port is `8787`. Live screens also use `6200–6299`; keep these ports within the trusted network. A working chat connection does not prove that screen-viewer ports are reachable.

## Public HTTPS

1. Point the domain's DNS record at the server.
2. Allow inbound TCP ports **80** and **443**.
3. Choose public HTTPS in advanced setup and enter the domain.
4. Let setup start the bundled Caddy proxy and obtain a certificate.
5. Enter the resulting HTTPS URL in the apps.

If another service already uses 80 or 443, use an existing proxy or free those ports before setup.

## Existing HTTPS proxy

Setup prints the local upstream, usually `http://127.0.0.1:8787`. Configure your proxy to forward HTTP and WebSocket traffic and replace incoming forwarding headers with values from its own connection.

A proxy on another machine also needs the configured OpenTeam proxy secret when forwarding trusted client information. Use the [operator reference](../reference/server-configuration.md) for deployment-specific settings.

## Security notes

Keep owner authentication enabled. Do not expose raw screen-viewer ports to the public internet, and treat screen links as credentials. Public HTTP sends sign-in and session data without encryption.

After changing the connection, run `openteam status` and reconnect from the intended device. Check [troubleshooting](../manage/troubleshooting.md) if chat or screens are unavailable.
