# Connecting accounts

Each plugin signs in to its service in one of a few ways. This page explains what each one needs and how to check that the right account is connected. To install a plugin first, see [plugins](../usage/plugins.md#add-a-plugin).

## What each plugin needs

| Plugin | How it signs in |
| --- | --- |
| Linear, Notion, Granola | Browser sign-in. Nothing to set up first. |
| OpenStreetMap | Nothing. Choose **Connect**; it uses free public OpenStreetMap services. |
| Ramp | Browser sign-in. Choose read-only or full access when you approve; your Ramp role still applies. If Ramp rejects the callback URL, ask Ramp to allowlist the exact URL OpenTeam shows. |
| GitHub | A fine-grained personal access token |
| Gmail, Google Calendar, Google Drive, Google Docs, Google Sheets, Google Slides | Your own Google OAuth app. See [Google](google.md). |
| Slack (managed) | Your own Slack app. See [Slack](slack.md). Needs an HTTPS server address. |
| Slack (stealth) | The browser token (`xoxc-`) and session cookie (`xoxd-`) from your signed-in Slack session. See the [stealth setup guide](../../packages/plugins/slack-stealth/README.md). |
| Email | The mailbox's email address and an app password. See [Email](email.md). |
| 1Password | A read-only 1Password service account token, entered when you add the plugin |
| Plaid | Your own Plaid client ID and secret. Ask a bot to set up Plaid; it asks for them and then sends a link for signing in to your bank. Real banks need Plaid production access. |
| Custom MCP | Whatever the MCP server requires |

Enter tokens and secrets only in the plugin's setup form, or in the masked field a bot shows when it asks for one. Never paste them into a chat message.

## Browser sign-in

When you add the plugin, sign-in starts on its own. In your browser, choose the account and workspace you want OpenTeam to use, and approve access. If your browser doesn't open, choose **Sign in** or **Reopen sign-in** under **Accounts** on the plugin's page.

If your server URL starts with `http://`, choose **Continue to browser** and approve access. Your browser then ends on a page that doesn't load; that's expected. Copy the full address from the address bar, paste it into **Paste the browser address here** in OpenTeam, and choose **Complete sign-in**.

Granola uses whichever workspace is active in the Granola app. To work with a different workspace, switch to it in Granola.

## GitHub

Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens) in GitHub. Give it access to only the repositories and permissions you want bots to use. Paste it into the plugin's setup form and choose **Save token and connect**.

## 1Password

Put the logins bots should use in a vault other than Personal, Private, Employee, or the default Shared vault. On 1Password.com, create a service account (Developer → Directory → Other → Create a Service Account) with read access to that vault only, then add the **1Password** plugin and paste its token, which 1Password shows only once. Every bot can use it; replace it on the plugin page after rotating it. See [saved logins](../usage/computer.md#sign-in-to-websites).

The 1Password desktop app and browser extension are not used.

## Sign-in callback

Plugins that sign in through the browser have a **Sign-in callback** setting, which controls how the service returns you to OpenTeam. To change it, hover over the account on the plugin's page and choose the gear (**Account settings**). Leave it on **Automatic (recommended)** unless you have a reason to change it: it uses **Server callback** (`https://<your-server>/api/v0/plugin-oauth/callback`) when your server has an HTTPS address, and **Paste callback URL** otherwise. **Desktop listener (advanced)** receives the callback in the desktop app, so start sign-in there. Slack (managed) needs the HTTPS server callback. One callback URL works for every account on your server.

## Check the connected account

After you connect, open the plugin in **Marketplace** and expand **Settings → Advanced settings**. Choose the account under **Connection / account**. Under **Test a tool**, pick a tool that shows who you're signed in as, enter its input, and choose **Run test**:

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
| Wrong account connected | Sign out of the service in your browser, then choose **Reauthorize** in the plugin's **Advanced settings** |
| Signed in, but a tool fails | Check the account's permissions, the app's scopes, and any workspace restrictions |
| A bot can't use the tool | Check that the account is connected and the tool is available |
| The connection stopped working | In the plugin's **Advanced settings**, choose **Restart / refresh tools**, then **Reauthorize** if that doesn't fix it |
