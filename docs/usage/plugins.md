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

**Added** means the package is installed. **Provider setup required** means required credentials or configuration are missing. **Ready to authorize** means those fields are saved, and **Authorization pending** means browser sign-in has started. A connection error requires validation or retry. **Connected** or **Ready** means the account connected and its tools were discovered. Neither means every bot has access or every provider operation is permitted.

## Multiple accounts

Use **Add Another Account** or **Add account** to connect a second identity. Give it a name such as Work or Personal, authorize it separately, and check its bot grants.

Each account has separate authorization and Bot grants. Server callbacks share one stable deployment URL; adding another account does not require another callback registration. Connecting Gmail does not also connect Calendar or Drive.

## Self-hosted Google sign-in on desktop and iOS

Keep **Sign-in callback → Automatic**. With HTTPS, either app opens its local browser and authorization returns to your OpenTeam server. Tailscale Serve is the preferred private HTTPS setup; a custom HTTPS domain works through the same flow. Configure a Google **Web application** OAuth client with the callback shown in account settings.

If the server address is HTTP, compatible providers use **Paste callback URL**. For Google, configure a **Desktop app** OAuth client, approve in your browser, and paste the complete returned localhost address into the app's dedicated authorization form. The failed localhost page is expected. The backend checks the session, state, redirect, and expiration. This flow is implemented on desktop and iOS; Google's real iPhone consent/copy experience still needs device acceptance testing.

Tokens stay on your server, which refreshes them independently of either app. No OpenTeam-operated callback service is required. Explicit **Desktop listener (advanced)** settings are preserved and still need the desktop app. See [Google setup](../integrations/google.md) for registration and migration details.

Google applications with an External consent screen in **Testing** normally receive seven-day refresh tokens for Calendar/Gmail scopes. For durable personal use, review the project’s publishing status and Google’s requirements; storing a token successfully cannot override provider expiry or revocation. See [Google’s token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration).

## Bot access and tool approvals

Choose account grants under **Bot access and plugin details**. Tool policies control which actions need review; see [approvals and privacy](../configuration/approvals.md#set-plugin-access) for **Allow**, **Ask first**, and **Deny**.

If a connected tool is missing, check the bot's grant, the tool's enabled state, and workspace restrictions.

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
