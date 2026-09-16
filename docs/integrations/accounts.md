# Connecting accounts

Each plugin account connects one identity to a service. Authorize it, verify the account, and choose which bots can use it.

## Choose an integration

| Service | How to connect |
| --- | --- |
| GitHub | Enter a provider token with access to the repositories and operations you need |
| Linear, Notion, Granola | Start browser authorization from the plugin's account setup |
| Gmail, Google Calendar, Google Drive | Configure a Google OAuth application, then authorize each plugin |
| Slack | Configure a Slack app for your workspace, then authorize the account |
| 1Password | Connect its local Environments MCP service through the desktop app |
| Custom MCP | Provide the endpoint or package configuration and its required authentication |

Use **Plugins → Manage → Installed** to select a package and account. The package's setup form describes its required fields. Enter secrets there, rather than in a bot conversation.

## Check the account before granting access

After connecting, use **Test a tool** for a small read that identifies the account or lists familiar data. Then grant it to the intended bot and try a small task in chat.

Multiple accounts keep separate authorization and bot grants. Name them clearly, such as Personal GitHub and Work GitHub.

## Google access requirements

Gmail, Calendar, and Drive are separate plugins. You can reuse a Google OAuth application, but each account needs its own callback registration and authorization. Follow [Google setup](google.md).

### Google capabilities and limits

Gmail can read and organize mail and prepare drafts; the bundled connector has no send tool. Calendar can read and manage events. Drive can find, read, and work with accessible files. See [Google capabilities](google.md#what-bots-can-do) for the practical limits.

## Slack application setup

Slack needs a configured application in the workspace you want to connect. Follow [Slack setup](slack.md), including the MCP-access switch and exact callback URL.

## Linear setup

Install Linear, choose **Save and authorize**, sign in, and select the intended workspace. You do not need to create a separate developer application for the bundled connection. Verify the returned account and grant it to your bot.

## Notion setup

Install Notion and start browser authorization. Select the intended workspace and review the access offered by Notion. The plugin can only work with content the connected account can access.

Enable any included Notion skills separately from the account grant. An installed skill does not authorize the account.

## Granola setup

Use an existing Granola account and complete browser authorization. Check the active workspace and run a small read before granting access. Available meeting notes depend on the connected account's plan and sharing permissions.

If the wrong identity appears, reauthorize with the intended login. Connecting another account does not merge separate Granola workspaces.

## 1Password setup

The bundled integration uses 1Password's local **Environments MCP server** through the OpenTeam desktop app. It manages environments and mounts; it does not retrieve vault passwords.

Enable MCP integration in 1Password's developer settings, keep the app unlocked, and follow the [package setup instructions](../../packages/plugins/1password/README.md) for the supported desktop platforms.

## Troubleshooting

| Problem | Check |
| --- | --- |
| Callback or redirect mismatch | Register the full callback URL shown for this account, including its query string |
| Wrong account connected | Reauthorize and select the intended browser identity |
| Sign-in works but a tool fails | Check scopes, workspace access, API enablement, and provider limits |
| A bot cannot find the tool | Check its account grant, enabled tools, and tool policies |
| An old sign-in tab fails | Start a fresh authorization from the plugin account |
| Connection stopped working | Try refresh, then reauthorize if the provider revoked or expired access |

If you change the server's public URL, review registered callbacks too. See [remote access](../configuration/remote-access.md).
