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
| Plaid | Bring your own keys, connect banks through Hosted Link from any device, and query financial data |
| 1Password | Sign in to websites with saved logins and one-time codes from vaults shared with a service account |

Slack, Granola, and Notion include provider skills alongside their tools. See [the included skills and how to enable them](skills.md#skills-from-plugins). Gmail, Google Calendar, and Google Drive provide tools without bundled skills.

Plaid is a skills-only integration. After adding it, ask a Bot to set up Plaid on the computer that should hold your credentials. It installs the CLI and prepares Python helpers, asks for missing API keys, then sends a Hosted Link URL you can open on your laptop or phone. After bank login, tell the Bot “done” so it saves and verifies the connection. Bank connections live in that computer's CLI configuration rather than OpenTeam's Accounts section. See the [Plaid guide](../../packages/plugins/plaid/README.md).

## Add a plugin

1. Open **Marketplace** and choose **Add** on the plugin. The plugin's page opens.
2. Under **Accounts**, follow the setup steps. Depending on the plugin, you sign in through your browser, paste a token, or enter the details of an app you registered with the service. See [connecting accounts](../integrations/accounts.md) for what each plugin needs.
3. Once the account connects, its tools and bundled instructions are available to all bots.

Then try it in chat:

> List my five most recently updated GitHub repositories.

All bots can use installed plugins and connected accounts. To check which account is connected, [test a tool](../integrations/accounts.md#check-the-connected-account).

## Connect more than one account

To connect a second account, such as a work and a personal Gmail, choose **Add Another Account** under **Accounts** on the plugin's page. Give it a clear name, sign in.

Gmail, Google Calendar, and Google Drive are separate plugins. Connecting one doesn't connect the others.

## Connect Slack to a self-hosted server

Create an internal Slack app in your workspace and enter its client ID and client secret in OpenTeam. Your OpenTeam server keeps the authorization and connects directly to Slack's official MCP server. You can reuse the internal app for additional OpenTeam accounts in the same workspace.

The Slack connection needs an HTTPS OpenTeam address. For a private deployment, use Tailscale Serve and keep Tailscale connected on your devices. Copy the exact callback URL from OpenTeam's account settings into the Slack app, enable **Agents → Enable Slack MCP Server**, then save the credentials in OpenTeam and authorize the workspace. The [Slack setup guide](../../packages/plugins/slack/README.md) includes a ready-to-use app manifest.

## Connected tools

Bots execute connected tools directly. Disconnect or remove an account to stop its use. Provider account scopes determine which operations the service accepts.

## Manage a plugin

Open **Marketplace → Manage → Accounts and settings** and choose the plugin and account.

| Action | What it does |
| --- | --- |
| **Restart / refresh tools** | Reconnects and reloads the plugin's tools |
| **Reauthorize** | Signs in again, for accounts that sign in through the browser |
| **Disconnect** | Stops the connection. The sign-in is kept. |
| **Remove account** | Deletes the account. If it's the plugin's only account, it's reset instead. |
| **Apply reviewed update** | Installs a new version after you review the changes |
| **Uninstall** | Removes the plugin and all its accounts |

Removing an account in OpenTeam doesn't revoke access on the service's side. To do that, remove OpenTeam from the service's security or connected apps settings.

## Add your own tools

From **Marketplace**, open **Manage**:

- **Add custom MCP** connects an MCP server over HTTP, or runs one as a command on the bots' computer.
- **Private skills** lets you write your own [skills](skills.md).
- **Plugin sources** adds catalogs of plugins from other sources.
- **Develop plugins** lets you build and package your own. See [build a plugin](../development/plugins.md).
