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
4. Test `channels_me` or `channels_list` and verify the intended workspace.
5. Use the account's tool settings to control the operations available to bots.

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
remains limited to the signed-in user's access. OpenTeam discovers tool schemas
and applies its normal account and tool controls.

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
[upstream.json](upstream.json) pins the unmodified upstream MIT license notice.
Slack artwork and its attribution are bundled in `assets/`.

## Session limitations

This uses Slack browser-session authentication rather than Slack's supported
app OAuth integration. Sessions may expire or be revoked, and workspace
security policies can prevent access. If authentication fails, replace both
secret fields from the current session and reconnect. There is no OAuth refresh flow.
Stealth describes app-free setup; it does not promise invisible activity.

## Validation

The precompiled executables were built twice from the pinned upstream source
using Go 1.25.9; executable and compressed-archive digests matched across builds.
Source and test fixtures are not included in this package.

The exported package ran in an offline Linux arm64 OpenTeam computer container
with `/tmp` mounted `noexec`.
The smoke fixture used upstream's demo authentication to exercise the actual
launcher, stdio initialization, discovery of all nine tools, write annotations,
invalid-argument rejection, shutdown, and private-directory cleanup. Linux x64
integrity was checked; execution on x64 was not tested.

A prior live browser-session test of the same upstream version, using its release
binaries, in YC W2024 on the OpenTeam computer discovered all
nine tools and returned channel data through `channels_list`. The subsequent
`channels_me` read failed, and the browser session was logged out. This Enterprise
workspace did not sustain the session for further testing. Message search,
history, thread reads, and write operations remain unverified live. No messages
or reactions were sent. App-free connectivity is demonstrated; reliable operation
in this workspace is not established.
