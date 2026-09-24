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
- **Some containers show "Exited (0)":** that's normal. Setup containers exit once they finish. The `server`, `worker`, `computer`, and `postgres` containers should stay running, and `caddy` too if you use automatic HTTPS.
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

1. Scroll the conversation for a question or approval request that's waiting for you.
2. Run `openteam doctor` to check your model provider. Sign-ins can expire and accounts can run out of quota. To reconnect, see [model providers](../configuration/models.md#check-the-connection).
3. If the bot is working on your own computer, make sure the desktop app is open and connected.

## The screen doesn't load

- Run `openteam status` and check that the `computer` service is healthy.
- If the preview says **Computer setup needs attention**, choose **Retry setup**.
- If you run your own proxy, check that it forwards WebSocket traffic.

For work on your own computer, check **Settings → Computer** in the desktop app and your system's permissions for OpenTeam.

## A plugin is connected but tasks fail

1. In **Marketplace → Manage → Accounts and settings**, use **Test a tool** to check that the connection works.
2. Check that the bot has access under **Bot access**, and that the tool's policy isn't **Deny**.
3. Check the account's permissions and quota on the service's side.

For sign-in and callback errors, see [connecting accounts](../integrations/accounts.md#troubleshooting).

## A routine didn't run

Check that the routine is **Active**, and open its **Run history**. The server must be running at the scheduled time. See [routines](../usage/routines.md#when-a-routine-fails).

## The result is wrong or incomplete

Say exactly what's wrong, give the bot any missing source, and ask it to revise its existing work. For facts that change, ask it to check the source again. If the same mistake keeps coming back, ask the bot what it remembers about the topic and correct its [memory](../usage/memory.md) or [skill](../usage/skills.md).

## Get help

If you're still stuck, [open an issue](https://github.com/raghavpillai/openteam/issues). Include your app version, your server version (shown by `openteam status`), your operating system, the steps that cause the problem, and the error. Remove passwords, tokens, and private conversation content from logs and screenshots first.
