# Troubleshooting

Find the part that isn't working (installation, the app connection, a bot, or a plugin) and start there.

## Run diagnostics

On the server host:

```sh
openteam status
openteam doctor
```

`status` shows whether each service is running. `doctor` runs deeper checks and tells you how to fix each problem it finds.

To see what the server is doing:

```sh
openteam logs server --follow
```

## Installation fails

- **Docker isn't running:** run `docker info`. If it fails, start Docker Desktop or Docker Engine. If you have more than one Docker setup, run `docker context show` to check which one you're using.
- **A port is already in use:** another program, or another OpenTeam installation, is using port `8787` or `6200–6299`. Stop it, or choose a different **API port** with `openteam setup --advanced`. The screen ports `6200–6299` can't be changed, so free them instead. With automatic HTTPS, ports `80` and `443` must also be free.
- **Some containers show "Exited (0)":** that's normal. Setup containers exit once they finish. The `server`, `worker`, `computer`, `computer-memory-init`, and `postgres` containers should stay running, and `caddy` too if you use automatic HTTPS.
- **`openteam` isn't found:** open a new terminal, or add the install location to your `PATH`. See [installation](../getting-started/installation.md#install).

## The app can't connect

1. Run `openteam status` on the server and use the **Server** address under **Connection**.
2. On another device, don't use a `localhost` or `127.0.0.1` address. Use the server's network, VPN, or HTTPS address.
3. Check that both devices are on the same network or VPN.
4. For a public HTTPS address, check that your domain points at the server and ports 80 and 443 are open.
5. If you run your own proxy, check that it forwards WebSocket traffic.

See [remote access](../configuration/remote-access.md).

## Desktop sign-in shows a secure storage error

The desktop app encrypts your saved sign-in using your system's secure storage.

- **macOS:** look for a Keychain prompt and allow it. If none appears, open Keychain Access and make sure your login keychain is unlocked.
- **Linux:** make sure a system keyring, such as GNOME Keyring or KWallet, is installed and unlocked.

Then sign in again. Don't reset your keychain or delete saved credentials to get around the error.

## A bot doesn't respond

1. Scroll the conversation for a question or form that's waiting for you.
2. Run `openteam doctor` to check your model provider. Sign-ins can expire and accounts can run out of quota. To reconnect, see [model providers](../configuration/models.md#check-the-connection).
3. If the bot is working on your own computer, make sure the desktop app is open and connected.

## Doctor reports a workspace permission problem

`openteam doctor` checks that bots can read, write, and delete files in the workspace, running as the bot's user (UID 1000) on the computer. If the check fails, make sure the Docker drive has free space and that the workspace volume is writable by that user. Run `openteam logs computer` to look for storage errors.

## The screen doesn't load

- Run `openteam status` and check that the `computer` service is healthy.
- If the preview says **Computer setup needs attention**, choose **Retry setup**.
- If you run your own proxy, check that it forwards WebSocket traffic.

For work on your own computer, check **Settings → Computer** in the desktop app and your system's permissions for OpenTeam.

## A plugin is connected but tasks fail

1. In the desktop app, open **Marketplace**, then the plugin. Check the account's status on its page, and use its **Sign in**, **Connect**, or **Set up** button if it needs one.
2. On the same page, open **Settings → Advanced settings** and use **Test a tool** to check that the connection works.
3. Check the account's permissions and quota on the service's side.

Installed plugins and their connected accounts are available to all bots. On iPhone, plugins are under **Settings → Plugins**.

For sign-in and callback errors, see [connecting accounts](../integrations/accounts.md#troubleshooting).

### A lookup reports a connection reset

A connection reset during a plugin lookup does not establish that a password or token is wrong. Record the failure time and check the server and computer logs for `computer_network.` events:

```sh
openteam logs computer --tail 2000 2>&1 | rg 'computer_network\.'
openteam logs server --tail 2000 2>&1 | rg 'computer_network\.'
```

`route_changed`, `route_fenced`, `lease_expired`, and `transport_closed` identify route switches, lease loss, and control-channel interruptions. Correlate their `epoch` and `previousEpoch` values with the failure time. `proxy_capacity` records a local connection-limit rejection. `proxy_dial_failed` and `proxy_socket_error` preserve recognized error codes such as `ECONNRESET`; `side` distinguishes the application-facing socket from the upstream socket. An upstream reset still does not identify which remote service or intermediate network generated it.

These records contain timestamps, route and source IDs, counts, numeric destination IPs and ports, and fixed error/reason codes. They exclude hostnames, URLs, credentials, request contents, and free-form error messages. Each component emits at most 20 connection events and 20 control events per second; the next emitted event in each category reports any `suppressed` count. Desktop exit errors are logged by the desktop process.

The 1Password skill preserves CLI failures through filters and permits one delayed retry of a read-only lookup after a transient transport failure. Authentication rejections, rate limits, website actions, and writes are not retried by that guidance.

## A routine didn't run

Check that the routine is **Active**, and open its **Run history**. The server must be running at the scheduled time. See [routines](../usage/routines.md#when-a-routine-fails).

## The result is wrong or incomplete

Say exactly what's wrong, give the bot any missing source, and ask it to revise its existing work. For facts that change, ask it to check the source again. If the same mistake keeps coming back, ask the bot what it remembers about the topic and correct its [memory](../usage/memory.md) or [skill](../usage/skills.md).

## Get help

If you're still stuck, [open an issue](https://github.com/raghavpillai/openteam/issues). Include your app version, your server version (shown by `openteam status`), your operating system, the steps that cause the problem, and the error. Remove passwords, tokens, and private conversation content from logs and screenshots first.
