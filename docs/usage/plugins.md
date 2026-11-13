# Plugins

Plugins connect your bots to services such as Gmail, GitHub, Slack, and Notion. Some also add skills for working with that service. You can connect your own tools through MCP as well.

## Available plugins

| Plugin | What bots can do |
| --- | --- |
| GitHub | Search repositories, read code, and manage issues and pull requests |
| Gmail | Search, read, organize, and draft email, and send drafts you approve |
| Email | Search and read a mailbox over IMAP, reply through drafts you approve, and run routines when mail arrives |
| Google Calendar | Find events, check availability, and schedule meetings |
| Google Drive | Find, read, create, organize, share, and comment on files |
| Google Docs | Read, write, and format documents |
| Google Sheets | Read, write, format, and chart spreadsheets |
| Google Slides | Build, edit, and preview presentations |
| Slack (managed) | Search channels, read threads, send messages, and work with canvases through a Slack app you authorize |
| Slack (stealth) | Search Slack, read channels and threads, send messages, and add reactions using your browser session |
| Linear | Find, create, and update issues, projects, and comments |
| Notion | Work with pages for documents, research, meetings, and tasks |
| Granola | Use meeting notes, decisions, and action items |
| OpenStreetMap | Find places and nearby spots with opening hours, plan routes, and show them on maps. Free, with no account |
| Google Maps | Find places with Google ratings, reviews, photos and live opening hours, plan routes, and show them on maps. Uses your own Google Maps Platform API key |
| Plaid | Connect banks with your own Plaid keys and query balances, transactions, investments, and loans |
| Signal | Read collected messages and contacts, and send text through a linked Signal account |
| WhatsApp | Search messages, send messages and files, and manage chats through a linked WhatsApp account |
| Ramp | Analyze spend, manage expenses and approvals, and run Ramp finance workflows |
| 1Password | Sign in to websites with saved logins and one-time codes from vaults shared with a service account |
| T3 Code | Start coding work on a connected T3 environment, follow progress, and continue or stop threads |

Several plugins also include skills; see [the included skills](skills.md#skills-from-plugins).

For T3 Code, paste the full MCP URL copied from your T3 environment, then choose **Validate URL and connect**. Authorize on T3's page; enter its current one-time code there if asked. **Auto** is T3's provider review mode and can still ask for approval. The plugin includes its coding, thread-management and setup skills. See the [T3 Code guide](../../packages/plugins/t3-code/README.md).

Plaid adds skills only. After adding it, ask a bot to set up Plaid on the computer that should hold your credentials; it asks for your Plaid keys and sends a link for connecting your bank from any device. Those bank connections are kept on that computer, not in the plugin's accounts. See the [Plaid guide](../../packages/plugins/plaid/README.md).

## Add a plugin

1. Open **Marketplace** and choose **Add** on the plugin. The plugin's page opens.
2. Under **Accounts**, follow the setup steps. Depending on the plugin, you sign in through your browser, paste a token, or enter the details of an app you registered with the service. See [connecting accounts](../integrations/accounts.md) for what each plugin needs, and the [Slack](../integrations/slack.md), [Google](../integrations/google.md) and [Email](../integrations/email.md) guides.
3. Once the account connects, its tools and bundled instructions are available to all bots.

On iPhone and iPad, plugins are under **Settings → Plugins**.

Then try it in chat:

> List my five most recently updated GitHub repositories.

All bots can use installed plugins and connected accounts. To check which account is connected, [test a tool](../integrations/accounts.md#check-the-connected-account).

## Link Signal or WhatsApp

Add the plugin from **Marketplace**, open its account settings, and choose **Connect**. Scan the live QR code using **Linked Devices** in Signal or **Linked devices → Link a device** in WhatsApp on your phone. If you use OpenTeam on that phone, display the code on another screen. Use **Get new code** when a code expires.

Both plugins run on the bot computer and need it online to collect messages. They use unofficial linked-device clients. Signal installs verified Java and signal-cli runtimes on first connection; WhatsApp includes its Linux client. These plugins make tools available to bots; incoming messages do not create OpenTeam conversations automatically.

Signal collects new messages after linking and does not import old phone history. WhatsApp can search its local message store and request bounded history backfill; it is not a complete backup. Their send tools do not use OpenTeam's editable email/Slack draft cards. Review the task and connected account before asking a bot to send.

**Disconnect** keeps account state for reconnection. **Remove account** deletes its local account data after stopping the connector. Remove the linked device in the phone app too to revoke it there. See the [Signal guide](../../packages/plugins/signal/README.md) and [WhatsApp guide](../../packages/plugins/whatsapp/README.md) for supported tools, storage, uncertain sends, and limits.

## Connect more than one account

To connect a second account, such as a work and a personal Gmail, choose **Add Another Account** under **Accounts** on the plugin's page. Give it a clear name, then sign in.

Gmail, Google Calendar, Google Drive, Google Docs, Google Sheets, and Google Slides are separate plugins. Connecting one doesn't connect the others.

## What bots do without asking

By default, bots put outgoing email and Slack messages in an editable draft card in the chat, and nothing goes out until you choose **Send**. A card's menu can let a bot email those recipients without asking, or turn drafts off for that bot; see [approve before it sends](../integrations/email.md#approve-before-it-sends). Texts sent through Messages on a Mac get a similar card; see [Messages on a Mac](computer.md#messages-on-a-mac).

Other plugin tools run as soon as a bot uses them. Bots are told to confirm with you in chat before they change, post, delete, or send something, but nothing beyond these cards enforces that. The account's permissions on the service decide which operations it accepts. To stop bots from using an account, disconnect or remove it.

## Manage a plugin

Open **Marketplace** and choose the plugin. Its page lists the plugin's accounts with their status, a **Sign in**, **Connect**, or **Set up** button when an account needs one, and **Disconnect** for a connected account. On an account row:

- The pencil button renames the account and shows **Remove**.
- The gear button (**Account settings**, shown on hover) holds the account's sign-in details and callback setting, **Restart**, its instructions, and **Remove account**.

More actions are on the same page under **Settings → Advanced settings**:

| Action | What it does |
| --- | --- |
| **Test a tool** | Runs one of the plugin's tools so you can check the connected account |
| **Restart / refresh tools** | Reconnects and reloads the plugin's tools |
| **Reauthorize** | Signs in again, for accounts that sign in through the browser |
| **Disconnect** | Stops the connection. The sign-in is kept. |
| **Remove account** | Deletes the account. If it's the plugin's only account, it's reset instead. |
| **Apply reviewed update** | Installs a new version after you review the changes. Plugins that ship with OpenTeam update on their own when OpenTeam updates, and their connected accounts reconnect. |

**Uninstall**, at the top of the plugin's page, removes the plugin and all its accounts.

Removing an account in OpenTeam doesn't revoke access on the service's side. To do that, remove OpenTeam from the service's security or connected apps settings.

## Add your own tools

From **Marketplace**, open **Manage**:

- **Add custom MCP** connects an MCP server over HTTP, or runs one as a command on the bots' computer.
- **Private skills** lets you write your own [skills](skills.md).
- **Develop plugins** lets you build and package your own. See [build a plugin](../development/plugins.md).
- **Your plugins** lists the plugins you've installed.

On iPhone and iPad, **Settings → Plugins → Plugin workspace** also has **Add source**, for adding a catalog of plugins from a URL.
