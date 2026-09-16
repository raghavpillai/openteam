# Slack

Connect a Slack account so bots can find workspace context and use the tools permitted by that account.

## Before you start

You need permission to create and install an app in the intended Slack workspace. An administrator may need to approve it. This connection uses Slack's MCP service and the scopes configured for your app.

## Create the Slack app

1. Install Slack in OpenTeam and copy the selected account's **OAuth callback URL**.
2. Open [Slack's app dashboard](https://api.slack.com/apps) and create an app **From a manifest**.
3. Use the repository's [Slack app manifest](../../packages/plugins/slack/slack-app-manifest.json). Replace its callback placeholder with the complete URL from OpenTeam.
4. Review the workspace and requested user permissions, then create the app.
5. Enable **Slack MCP Server** access in the app's **Agents** settings. This is separate from marking the app as an agent app.
6. Copy the app's **Client ID** and **Client Secret** from its credentials into OpenTeam's setup form. Use the OAuth client secret, not a signing secret or app-level token.

See [Slack's MCP documentation](https://docs.slack.dev/ai/slack-mcp-server/) for the service's current setup and app requirements.

## Connect and verify

Choose **Save and authorize**, select the intended workspace, and complete Slack's consent flow. Once connected, use **Test a tool** for a small read and confirm it returns the expected workspace data.

Grant the account to the bots that need it. Start with a request such as:

> Find the recent decisions about the website launch and summarize them with links. Do not post anything to Slack.

Review tool policies before allowing message or other write actions.

## Add another account

Add an account in OpenTeam and register its exact callback in the Slack app's redirect URLs. Authorize it separately. A different workspace may require a separate application.

## Fix common problems

- **App is not enabled for Slack MCP server access:** check the MCP switch even if OAuth sign-in succeeded.
- **Redirect mismatch:** register the full URL for this account, including the query string.
- **Missing channel or denied tool:** check the user's access, app scopes, and bot grant.
- **Administrator approval required:** complete the workspace's installation process before retrying.

Use **Restart / refresh tools** after configuration changes and reauthorize when permissions change.
