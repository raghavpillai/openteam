# Plugins

Plugins connect your bots to services such as Gmail, GitHub, Slack, and Notion. Some also add skills for working with that service. You can connect your own tools through MCP as well.

## Available plugins

| Plugin | What bots can do |
| --- | --- |
| GitHub | Search repositories, read code, and manage issues and pull requests |
| Gmail | Search, read, organize, and draft email |
| Google Calendar | Find events, check availability, and schedule meetings |
| Google Drive | Find, read, and create files |
| Slack | Search channels, read threads, send messages, and work with canvases |
| Linear | Find, create, and update issues, projects, and comments |
| Notion | Work with pages for documents, research, meetings, and tasks |
| Granola | Use meeting notes, decisions, and action items |
| 1Password | Manage Developer Environments and `.env` files (macOS and Linux) |

Slack, Granola, Notion, and 1Password include provider skills alongside their tools. See [the included skills and how to enable them](skills.md#skills-from-plugins). Gmail, Google Calendar, and Google Drive provide tools without bundled skills.

## Add a plugin

1. Open **Marketplace** and choose **Add** on the plugin. The plugin's page opens.
2. Under **Accounts**, follow the setup steps. Depending on the plugin, you sign in through your browser, paste a token, or enter the details of an app you registered with the service. See [connecting accounts](../integrations/accounts.md) for what each plugin needs.
3. Under **Bot access**, turn on the account for each bot that should use it. If the plugin includes skills, such as Notion or Granola, also turn on **Instructions and hooks** for those bots.

Then try it in chat:

> List my five most recently updated GitHub repositories.

Adding a plugin doesn't give every bot access. Each bot only sees the accounts you turn on for it. To check which account is connected, [test a tool](../integrations/accounts.md#check-the-connected-account).

## Connect more than one account

To connect a second account, such as a work and a personal Gmail, choose **Add Another Account** under **Accounts** on the plugin's page. Give it a clear name, sign in, and choose which bots can use it.

Gmail, Google Calendar, and Google Drive are separate plugins. Connecting one doesn't connect the others.

## Control what bots can do

Two settings on the plugin's page work together:

- **Bot access** decides which bots can use each account.
- **Tool policies** decide what happens when a bot uses a tool: **Allow**, **Ask first**, or **Deny**. On desktop, policies apply to all bots.

Use **Ask first** for tools that send, post, or delete. To hide a tool from bots entirely, turn it off under **Manage → Accounts and settings**. Choosing **Always allow** on an approval lets that bot skip **Ask first** for that tool on that account. A **Deny** policy still applies. See [approvals and privacy](../configuration/approvals.md).

## Manage a plugin

Open **Marketplace → Manage → Accounts and settings** and choose the plugin and account.

| Action | What it does |
| --- | --- |
| **Restart / refresh tools** | Reconnects and reloads the plugin's tools |
| **Reauthorize** | Signs in again, for accounts that sign in through the browser |
| **Disconnect** | Stops the connection. The sign-in, bot access, and policies are kept. |
| **Remove account** | Deletes the account and its bot access. If it's the plugin's only account, it's reset instead. |
| **Apply reviewed update** | Installs a new version after you review the changes |
| **Uninstall** | Removes the plugin and all its accounts |

Removing an account in OpenTeam doesn't revoke access on the service's side. To do that, remove OpenTeam from the service's security or connected apps settings.

## Add your own tools

From **Marketplace**, open **Manage**:

- **Add custom MCP** connects an MCP server over HTTP, or runs one as a command on the bots' computer.
- **Private skills** lets you write your own [skills](skills.md).
- **Plugin sources** adds catalogs of plugins from other sources.
- **Develop plugins** lets you build and package your own. See [build a plugin](../development/plugins.md).
