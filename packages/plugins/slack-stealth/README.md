# Slack (stealth)

Connect a signed-in Slack browser session without creating or installing a Slack app.
This OpenTeam package runs the MIT-licensed [korotovsky/slack-mcp-server](https://github.com/korotovsky/slack-mcp-server)
v1.3.0 on the Bot computer. It is a community integration, not an official Slack product.
The precompiled server includes the original copyright and MIT license notice.
See [NOTICE.md](NOTICE.md).

Use **Slack (managed)** for Slack's official MCP server with app authorization.
The two plugins have independent accounts and can be installed together.

## Setup

1. Install **Slack (stealth)** from Marketplace and open its account settings.
2. Sign in to the intended Slack workspace in your browser. Follow the
   [upstream authentication guide](https://github.com/korotovsky/slack-mcp-server/blob/a079b3cd4d5836d791c942a9fc107987e7865b37/docs/01-authentication-setup.md) to find
   its `xoxc-` browser token and `xoxd-` session cookie (the cookie named `d`).
3. Enter them in **Slack browser token** and **Slack session cookie**, save, and
   choose **Connect**. Never send these login credentials in a conversation.
4. Run `channels_me` or `channels_list` with **Test a tool**, on the plugin's page under
   **Settings → Advanced settings**, and verify the intended workspace.

OpenTeam stores these values as account secrets and passes them to the process in
memory. They are not included in plugin exports or written to the package.
Installed plugins and their connected accounts are available to all bots.
Use **Add Another Account** for another workspace or user; credentials are independent.

## Tools

- List channels and your channel memberships; search users.
- Search messages; read channel history and threads.
- Send messages as your Slack user; add and remove your reactions.

The package explicitly registers these nine upstream tools. It does not claim
the managed plugin's canvas, list, or file-upload coverage. Workspace access
remains limited to the signed-in user's access. OpenTeam discovers the tool
schemas when the account connects. Sends run directly through
`conversations_add_message`; the review cards that Slack (managed) uses don't
apply to this plugin.

## Runtime and provenance

The package includes compressed, precompiled Linux x64 and arm64 executables.
The generated catalog and exported ZIP carry these executables for offline
installation. OpenTeam's Linux Bot computers run them with a bundled Bun launcher;
no Go compiler, Docker build, npm install, first-run download, Slack CLI, app ID,
OAuth callback, or HTTPS OpenTeam address is needed. A native macOS or Windows
computer runtime is not supported by this package.

The launcher verifies both the compressed archive and extracted executable with
SHA-256, then runs in a disposable private directory under
`~/.cache/openteam/slack-stealth/` so it works when `/tmp` is mounted `noexec`.
Each connection has its own
executable and user/channel caches; these are removed when the process exits.
Reconnects refresh upstream caches. Credentials are never supplied as command arguments.

[connector/release.json](connector/release.json) records the pinned Go toolchain,
source inventory digest, deterministic build flags, binary digests, archive digests,
sizes, and source revision
`a079b3cd4d5836d791c942a9fc107987e7865b37`.
[LICENSE](LICENSE) retains the unmodified upstream MIT license notice.
Slack artwork and its attribution are bundled in `assets/`.

## Session limitations

This uses Slack browser-session authentication rather than Slack's supported
app OAuth integration. Sessions may expire or be revoked, and workspace
security policies can prevent access. If authentication fails, replace both
secret fields from the current session and reconnect. There is no OAuth refresh flow.
Stealth describes app-free setup; it does not promise invisible activity.
