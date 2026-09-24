# Connecting accounts

Each plugin signs in to its service in one of a few ways. This page explains what each one needs and how to check that the right account is connected. To install a plugin first, see [plugins](../usage/plugins.md#add-a-plugin).

## What each plugin needs

| Plugin | How it signs in |
| --- | --- |
| Linear, Notion, Granola | Browser sign-in. Nothing to set up first. |
| GitHub | A fine-grained personal access token |
| Gmail, Google Calendar, Google Drive | Your own Google OAuth app. See [Google](google.md). |
| Slack | Your own Slack app. See [Slack](slack.md). Needs an HTTPS server address. |
| OneDrive | Your own Microsoft Entra app. Needs an HTTPS server address. |
| 1Password | The 1Password app on the same Mac or Linux computer as the OpenTeam desktop app |
| Custom MCP | Whatever the MCP server requires |

Enter tokens and secrets only in the plugin's setup form. Never paste them into a chat.

## Browser sign-in

When you add the plugin, sign-in starts on its own. In your browser, choose the account and workspace you want OpenTeam to use, and approve access. If your browser doesn't open, choose **Sign in** or **Reopen sign-in** under **Accounts** on the plugin's page.

If your server URL starts with `http://`, choose **Continue to browser** and approve access. Your browser then ends on a page that doesn't load; that's expected. Copy the full address from the address bar, paste it into **Paste the browser address here** in OpenTeam, and choose **Complete sign-in**.

Granola uses whichever workspace is active in the Granola app. To work with a different workspace, switch to it in Granola.

## GitHub

Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens) in GitHub. Give it access to only the repositories and permissions you want bots to use. Paste it into the plugin's setup form and choose **Save token and connect**.

## OneDrive

OneDrive needs your server to have an [HTTPS address](../configuration/remote-access.md).

1. In OpenTeam, add the OneDrive plugin from **Marketplace** and keep its page open.
2. Register an app in [Microsoft Entra](https://entra.microsoft.com/) with:
   - The account types you need (personal, work, or both)
   - A **Web** redirect URI set to the **Authorized redirect URI** shown on the plugin's page
   - Delegated permissions `Files.ReadWrite`, `User.Read`, and `offline_access`
3. Copy the app's client ID and a client secret into OpenTeam, choose **Save credentials and continue**, and sign in.

## 1Password

The 1Password plugin manages Developer Environments and `.env` files. It doesn't read your vault passwords. To let bots sign in to websites with saved passwords, use [saved logins](../usage/computer.md#sign-in-to-websites) instead.

1. Install 1Password on macOS or Linux and unlock it.
2. In 1Password, open **Settings → Developer** and turn on **Integrate with MCP clients**.
3. In the OpenTeam desktop app on the same computer, add the 1Password plugin and approve the prompt in 1Password. If it doesn't connect, choose **Connect**.

Keep 1Password unlocked and the OpenTeam desktop app open while bots use it.

## Sign-in callback

Plugins that sign in through the browser have a **Sign-in callback** setting. It controls how the service sends you back to OpenTeam after you sign in. You'll find it in the account's settings on the plugin's page, or under **Marketplace → Manage → Accounts and settings**. It's set to **Automatic (recommended)**, and you rarely need to change it:

| Option | How it works |
| --- | --- |
| **Automatic** | Uses **Server callback** when your server has an HTTPS address, and **Paste callback URL** otherwise |
| **Server callback** | The service returns you straight to `https://<your-server>/api/v0/plugin-oauth/callback`. Needs HTTPS. |
| **Paste callback URL** | The service returns you to a local page that doesn't load. Copy the full address from your browser and paste it into OpenTeam. Not available for Slack or OneDrive. |
| **Desktop listener (advanced)** | The desktop app receives the callback on your computer. Start sign-in from the desktop app. Doesn't work for Slack or OneDrive. |

One callback URL works for every account on your server, so you don't need to register a new one for each account.

## Check the connected account

After you connect, open **Marketplace → Manage → Accounts and settings** and choose the plugin and account. Under **Test a tool**, pick a tool that shows who you're signed in as, enter its input, and choose **Run test**:

| Plugin | Tool | Input |
| --- | --- | --- |
| Notion | `notion-get-users` | `{"user_id":"self"}` |
| Granola | `get_account_info` | `{}` |

For other plugins, pick a read-only tool that returns your profile or workspace.

If the wrong account connected, sign out of the service in your browser, then choose **Reauthorize**.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| Redirect or callback mismatch | Register the exact callback shown in OpenTeam. If you changed your server address, update it with the service too. |
| Wrong account connected | Sign out of the service in your browser, then choose **Reauthorize** under **Manage → Accounts and settings** |
| Signed in, but a tool fails | Check the account's permissions, the app's scopes, and any workspace restrictions |
| A bot can't use the tool | Check **Bot access** on the plugin's page, then check that the tool is turned on and its policy under **Manage → Accounts and settings** |
| The connection stopped working | Under **Manage → Accounts and settings**, choose **Restart / refresh tools**, then **Reauthorize** if that doesn't fix it |
