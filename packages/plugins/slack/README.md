# Slack (managed)

This package connects to Slack's official MCP server using a Slack application owned by your deployment. Internal apps can use it without a Marketplace listing. Unlisted distributed apps cannot use Slack MCP.

For browser-session access without a Slack app, use [Slack (stealth)](../slack-stealth/README.md).

Your OpenTeam server stores the app credentials and account authorization and connects directly to Slack's hosted MCP server. Create the internal app once for your workspace, then use it for the OpenTeam accounts in that workspace.

Before connecting, configure an HTTPS address for your OpenTeam server. Tailscale Serve works for a private deployment; keep Tailscale connected on the devices used to sign in. This package uses a server callback, so callback paste is not available.

1. Install **Slack (managed)** from **Marketplace**, then open the plugin's account settings. Copy the displayed OAuth callback URL.
2. Open [Your Apps](https://api.slack.com/apps), select **Create New App → From a manifest**, and paste [slack-app-manifest.json](slack-app-manifest.json). Replace its example redirect URL with the exact OpenTeam callback URL. Choose your workspace, review, and create the app.
3. In the Slack app dashboard, open **Agents** and turn on **Enable Slack MCP Server**. OAuth can succeed while discovery fails if this switch is off.
4. From **Basic Information**, copy the client ID and client secret into OpenTeam. Choose **Save and authorize**, select the workspace, and approve access.
5. Run a small read with **Test a tool**, on the plugin's page under **Settings → Advanced settings**, such as `slack_read_user_profile` or `slack_search_channels`. Check the actual tool result before using the account.

The manifest requests the user-token scopes in [Slack's MCP tool reference](https://docs.slack.dev/ai/slack-mcp-server/#oauth-scopes-needed-on-user-token-for-different-tools), including search, files, channel history, users, messages, canvases, and lists. Keep all of them in your Slack app: OpenTeam requests every scope when you sign in, so removing one can make sign-in fail. Workspace policy or Slack plan restrictions can still limit individual tools.

For multiple accounts or workspaces, add an OpenTeam account, register its callback URL in the Slack app, and authorize it separately. An internal app belongs to its workspace; a different workspace may require its own internal app credentials.

Use the [plugin guide](../../../docs/usage/plugins.md) for account management, secrets, development, and troubleshooting. No Slack CLI is required.

## Skills and commands

The package includes the eight original upstream skills: `slack-messaging`, `slack-search`, `slack-docs`,
`slack-api`, `slack-cli`, `create-slack-app`, `test-slack-app`, and `block-kit`.
They cover everyday workspace tasks as well as Slack app development. The
developer workflows may need the Slack CLI and Node.js or Python on the Bot's
computer; installing this plugin does not install or authenticate those tools.

Installed plugins and their connected accounts are available to all bots, so every bot
can use these skills and commands. Commands are:

- `/slack:summarize-channel #channel`
- `/slack:find-discussions topic`
- `/slack:channel-digest #first, #second`
- `/slack:draft-announcement topic`
- `/slack:standup`

Commands that summarize or compose return drafts. Saving an announcement as a
Slack draft requires the approval described in that workflow and does not send
it. By default, bots put outgoing Slack messages in an editable draft card that
you send.

The skills (with their references) and commands in `skills/` and `commands/`
come unchanged from
[slackapi/slack-skills-plugin](https://github.com/slackapi/slack-skills-plugin/tree/8044341769fa84f85ee952dceddb67ef165ab110)
under the MIT license in `LICENSE`. Account setup is in `plugin.json`; shared
runtime code maps provider tool names to connected accounts. There are no
OpenTeam instruction files inserted into the original workflows.
Both the original flat commands (such as `/standup`) and the namespaced forms
above work; a flat name is available only when it is unambiguous.

Plugin updates keep the connection key, scopes, and OAuth setup, so existing
account credentials carry over. If the tools look out of date after an update,
choose **Restart / refresh tools** under **Settings → Advanced settings**.
