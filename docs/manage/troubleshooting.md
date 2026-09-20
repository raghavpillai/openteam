# Troubleshooting

Start with the part that is failing: installation, app connection, a bot task, or a connected service.

## Run diagnostics

On the server host:

```sh
openteam status
openteam doctor
```

Status checks service health. Doctor gives recovery steps and tests the saved model with a small request, which uses normal provider usage.

For more detail:

```sh
openteam logs --service server --follow
```

## Docker or installation fails

- **Docker is installed but unreachable:** run `docker info`. Start Docker Desktop or Docker Engine, then check `docker context show` points to the intended engine.
- **A port is already allocated:** another service or OpenTeam installation may be using `8787` or `6200–6299`. Stop the conflicting stack or choose a different API port with advanced setup.
- **Initialization containers show Exited:** an exit code of `0` is expected for completed setup jobs. The server, worker, computer, and database should stay running.
- **The CLI is not found:** reopen the terminal or add the install directory to PATH. See [installation](../getting-started/installation.md#install).

## The app cannot connect

Run `openteam status` and use its server URL. On another device, replace a loopback URL with the server's reachable LAN, VPN, or HTTPS address.

Check that both devices are on the expected network. Public HTTPS also needs correct DNS and accessible ports 80 and 443. An existing proxy must forward WebSocket traffic. See [remote access](../configuration/remote-access.md).

## Desktop sign-in reports a secure storage error

The desktop encrypts saved sessions with the operating system's secure storage. If access stalls, the app returns an error and keeps the sign-in form usable. Existing encrypted session data is preserved when storage access fails.

On macOS, check for a Keychain access prompt on the computer running OpenTeam, complete it directly, then retry sign-in. A valid server password does not authorize access to the Mac's Keychain. If no prompt appears, check Keychain Access in that Mac's logged-in desktop session. Do not reset the Keychain or delete saved credentials to work around this error.

Desktop sign-in always saves the session in OS-backed encrypted storage. If that storage is unavailable, sign-in reports an error and preserves any existing saved session; it never silently switches to a temporary session. On Linux, enable or unlock a supported system credential store before signing in.

Locally packaged, ad-hoc signed builds can prompt again after a rebuild because their signing identity changes. Distributed builds should use the same Developer ID signing identity across updates; see [building from source](../development/from-source.md#package-the-macos-desktop).

## A bot does not respond

Check that a model provider is connected, then run `openteam model list` and `openteam doctor`. A saved sign-in can expire or lack quota.

Look for a pending question or approval in the conversation. If the task needs delegation or your physical computer, keep the OpenTeam desktop app open and connected.

## Chat works but the screen does not

Check the computer service and screen access for your connection mode. On a private network, the viewer ports must be reachable as well as the API port. For local-computer work, check **Settings → Computer** and the relevant operating-system permissions.

## A plugin connects but a task fails

Check the selected account, the bot's grant, and the requested tool's policy. Then run a small read under **Test a tool**. Provider permissions, workspace access, or quota can block a call even when the account shows Connected.

For OAuth callback and account errors, see [connecting accounts](../integrations/accounts.md#troubleshooting).

## The result is wrong or incomplete

Point out the specific error, provide the missing source, and ask the bot to revise its existing work. For current facts, ask it to verify the source again. For repeated mistakes, review saved [memory](../usage/memory.md) and [skills](../usage/skills.md).

## Get help

If the problem persists, [open an issue](https://github.com/raghavpillai/openteam/issues) with the app and server versions, operating system, the steps that reproduce it, and the relevant error. Remove credentials, session URLs, and private conversation content from logs or screenshots before sharing them.
