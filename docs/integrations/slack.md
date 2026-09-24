# Slack

Connect Slack so bots can search channels, read threads, send messages, and work with canvases, using your Slack account's access.

## Before you start

- Your server needs an HTTPS address, because Slack returns you to it after you sign in. See [Tailscale HTTPS](../configuration/remote-access.md#tailscale-https) or [public HTTPS](../configuration/remote-access.md#public-domain-with-automatic-https).
- You need permission to create and install apps in your Slack workspace. An administrator may need to approve the app.

## 1. Create a Slack app

1. In OpenTeam, choose **Add** on Slack in **Marketplace**, and copy the **Authorized redirect URI** from the plugin's page.
2. Open [Slack's app dashboard](https://api.slack.com/apps), choose **Create New App → From a manifest**, and pick your workspace.
3. Paste OpenTeam's [Slack app manifest](../../packages/plugins/slack/slack-app-manifest.json). Replace its example redirect URL with the URI you copied from OpenTeam.
4. Review the permissions and create the app.
5. In the app's **Agents** settings, turn on **Enable Slack MCP Server**. Sign-in will seem to work without this, but no tools will load.
6. From **Basic Information**, copy the **Client ID** and **Client Secret** into OpenTeam. Use the client secret, not the signing secret.

Keep the app internal to your workspace. Slack doesn't allow unlisted public apps to use its MCP server.

## 2. Connect and test

1. In OpenTeam, choose **Save credentials and continue**, pick your workspace, and approve access.
2. To check the connection, open **Manage → Accounts and settings**, choose the Slack account, and run a small read under **Test a tool**.
3. Under **Bot access** on the plugin's page, turn on the account for the bots that should use it.

Start with a read-only request:

> Find recent decisions about the website launch and summarize them with links. Don't post anything to Slack.

Set sending and posting tools to **Ask first** until you trust how a bot uses them. See [approvals and privacy](../configuration/approvals.md#control-plugin-access).

To limit what bots can do in Slack, turn tools off or set them to **Deny** under **Manage → Accounts and settings**.

## Connect another workspace

Choose **Add Another Account** on the plugin's page, give the account a name, and sign in to the other workspace. Slack apps belong to one workspace, so a different workspace usually needs its own app. The new account starts with your first app's credentials. To use a second app, open **Manage → Accounts and settings**, select the new account, enter the app's client ID, set the client secret to **Replace** and paste the new secret, then choose **Save and authorize**.

## Fix common problems

| Problem | What to do |
| --- | --- |
| App isn't enabled for Slack MCP Server | Turn on **Enable Slack MCP Server** under **Agents**, then choose **Restart / refresh tools** |
| Redirect mismatch | Check that the app's redirect URL exactly matches the **Authorized redirect URI** in OpenTeam |
| A channel is missing or a tool is denied | Check your own access to the channel, the app's scopes, and the bot's access |
| Administrator approval required | Finish your workspace's app approval process, then try again |

Keep all the scopes from the manifest in your Slack app. OpenTeam requests all of them when you sign in, so removing one can make sign-in fail.
