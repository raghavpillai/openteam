# Plugins

Plugins connect bots to services such as GitHub, Gmail, Slack, and Notion. They can also add reusable skills or connect your own MCP server.

## Install and connect

1. Open **Plugins** and find the package in the marketplace.
2. Choose **Add**, then open its account setup.
3. Follow the package's instructions. Some services use browser sign-in; others need an API token or a registered OAuth application.
4. Choose **Save and authorize** or **Save and connect**.
5. Check the account and run a small read with **Test a tool**.
6. Grant the account to the bots that should use it. Enable any included skills separately.

Try a small task in chat after connecting. For example, ask the bot to list the repositories or notes you expect it to access.

**Added** means the package is installed. **Connected** or **Ready** means the account connected and its tools were discovered. Neither means every bot has access or every provider operation is permitted.

## Multiple accounts

Use **Add Another Account** or **Add account** to connect a second identity. Give it a name such as Work or Personal, authorize it separately, and check its bot grants.

When a service requires registered callbacks, add the new account's exact callback URL to the provider application. Connecting Gmail does not also connect Google Calendar or Drive.

## Bot access and tool approvals

Choose account grants under **Bot access and plugin details**. Under tool policies, use **Allow**, **Ask first**, or **Deny** to control execution. Start with read access and deliberate approvals for changes.

If a bot cannot see a connected tool, check its account grant, the tool's enabled state, and any workspace restrictions. See [approvals and privacy](../configuration/approvals.md).

## Updates, disconnection, and removal

- **Restart / refresh tools** reconnects and refreshes available tools.
- **Reauthorize** repeats browser sign-in for the selected account.
- **Disconnect** stops the connection while retaining saved credentials for reconnection.
- **Remove account** deletes that account's saved connection and access settings.
- **Apply reviewed update** updates the package after you review its changes.
- **Uninstall** removes the package and its accounts from OpenTeam.

Revoking access in the provider's own settings is a separate action.

## Custom servers, sources, and private skills

Use **Add custom MCP** for an HTTP MCP endpoint. The OpenTeam server must be able to reach it. Use **Develop** for a reusable package or a command-based connector that runs on the bot computer.

Use **Sources** to add a plugin catalog, or **Private skills** to create your own instructions. See [skills](skills.md) and the contributor guide to [building a plugin](../development/plugins.md).

For provider-specific setup, start with [connecting accounts](../integrations/accounts.md).
