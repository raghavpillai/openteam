# Slack

This package connects to Slack's official MCP server using a Slack application owned by your deployment. Internal apps can use it without a Marketplace listing. Unlisted distributed apps cannot use Slack MCP.

1. Install Slack in OpenTeam and open its account under **Plugins → Manage plugins → Installed**. Copy the displayed OAuth callback URL.
2. Open [Your Apps](https://api.slack.com/apps), select **Create New App → From a manifest**, and paste [slack-app-manifest.json](slack-app-manifest.json). Replace its example redirect URL with the exact OpenTeam callback URL. Choose your workspace, review, and create the app.
3. In the Slack app dashboard, open **Agents** and turn on **Enable Slack MCP Server**. OAuth can succeed while discovery fails if this switch is off.
4. From **Basic Information**, copy the client ID and client secret into OpenTeam. Choose **Save and authorize**, select the workspace, and approve access.
5. Run a small read test, such as searching for your own user or listing your channels. Check the actual tool result before granting Bot access.

The manifest requests the user-token scopes in [Slack's MCP tool reference](https://docs.slack.dev/ai/slack-mcp-server/#oauth-scopes-needed-on-user-token-for-different-tools), including search, files, channel history, users, messages, canvases, and lists. You may remove capabilities you do not need: reduce scopes in both Slack and OpenTeam, reauthorize, and disable the corresponding tools. Workspace policy or Slack plan restrictions can still limit individual tools.

For multiple accounts or workspaces, add an OpenTeam account, register its callback URL in the Slack app, and authorize it separately. An internal app belongs to its workspace; a different workspace may require its own internal app credentials.

Use the [plugin guide](../../../docs/usage/plugins.md) for account management, secrets, development, and troubleshooting. No Slack CLI is required.

## Skills and commands

Version 1.1.0 adds eight skills: `slack-messaging`, `slack-search`, `slack-docs`,
`slack-api`, `slack-cli`, `create-slack-app`, `test-slack-app`, and `block-kit`.
They cover everyday workspace tasks as well as Slack app development. The
developer workflows may need the Slack CLI and Node.js or Python on the Bot's
computer; installing this plugin does not install or authenticate those tools.

Enable **Instructions and hooks** for the Bot to load the workflows, then grant
the intended Slack account. Commands are:

- `/slack:summarize-channel #channel`
- `/slack:find-discussions topic`
- `/slack:channel-digest #first, #second`
- `/slack:draft-announcement topic`
- `/slack:standup`

Commands that summarize or compose return drafts. Saving an announcement as a
Slack draft requires the approval described in that workflow and does not send
it. Existing account and tool policies continue to apply.

The workflow files are adapted from Slack's MIT-licensed plugin; see
[UPSTREAM.md](UPSTREAM.md), [LICENSE](LICENSE), and [OpenTeam execution
notes](OPENTEAM.md). This update retains the connection key, scopes, and OAuth
setup, so applying it preserves existing account credentials and grants.
After applying the update, choose **Reconnect** to refresh tools with the saved
authorization, then enable **Instructions and hooks** for the intended Bot.

## Validation

September 24, 2026: portable ZIP import/export, all five command expansions,
eight skill bodies and supporting references, generated catalog consistency,
and workspace type checks passed. A disposable OAuth/MCP server verified manual
client authentication, upgrade and reconnection with the saved authorization,
account policies, and independent Bot instruction/account access. These checks
do not claim live Slack message delivery or developer CLI app creation.
