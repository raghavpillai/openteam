# Connecting accounts

Choose the sign-in method for your service, then verify the account before granting it to a bot. For the shared install and access steps, see [plugins](../usage/plugins.md#install-and-connect).

## Choose an integration

Open **Plugins → Manage → Installed** and select the package and account. Its setup form lists the required fields; enter secrets there.

| Service | What you need |
| --- | --- |
| GitHub | A token with access to the repositories and operations you need |
| Linear, Notion, Granola | An existing account and browser authorization; no developer application to register |
| Gmail, Google Calendar, Google Drive | A Google OAuth application; follow [Google setup](google.md) |
| Slack | An application in the intended workspace; follow [Slack setup](slack.md) |
| 1Password | Its local Environments MCP service; see [1Password setup](#1password-setup) |
| Custom MCP | The endpoint or package configuration and its authentication requirements |

## Verify the connected identity

Choose **Save and authorize** for browser sign-in, select the intended identity and workspace, then use **Test a tool**:

| Service | Test | Access to check |
| --- | --- | --- |
| Linear | `get_user` with `{"query":"me"}` | The expected user and workspace |
| Notion | `notion-get-users` with `{"user_id":"self"}` | The expected workspace and accessible pages |
| Granola | `get_account_info` with `{}` | The expected identity and active workspace; available notes depend on plan and sharing permissions |

Grant the account to the intended bot and enable any included skills separately. For a second identity, add an account, name it clearly, and authorize it separately. Google and Slack also need that account's exact callback registered.

Granola follows the active workspace selected in Granola. Adding another OpenTeam account does not pin or merge workspaces. If the wrong identity connects, sign out of Granola in the browser before authorizing again.

## 1Password setup

The Environments integration manages environment variables and local mounts; it does not retrieve vault passwords. Enable MCP integration in 1Password, keep it unlocked, and keep OpenTeam desktop open on the same computer.

Follow the [package setup instructions](../../packages/plugins/1password/README.md) for supported platforms, permissions, and connection checks. This integration is separate from the computer's saved-login feature.

## Troubleshooting

| Problem | Next step |
| --- | --- |
| Callback or redirect mismatch | Register the full callback shown for this account, including its query string; recheck callbacks after changing the server URL |
| Wrong account connected | Reauthorize with the intended browser identity |
| Sign-in works but a tool fails | Check scopes, workspace access, API enablement, and provider limits |
| A bot cannot find the tool | Check its account grant, enabled tools, and tool policies |
| An old sign-in tab fails | Start a fresh authorization from the plugin account |
| Connection stopped working | Refresh tools, then reauthorize if access expired or was revoked |
