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

Desktop OAuth receives callbacks on your computer and relays them to the selected server. Account settings also offer **Server callback** for web clients and **Desktop callback port** for providers requiring a fixed port. In Server mode, add the new account's exact callback URL to the provider application. Google Desktop app clients do not require a public server callback. Connecting Gmail does not also connect Google Calendar or Drive.

## Self-hosted Google sign-in on desktop and iOS

For a server on another computer, choose **Desktop app** as the sign-in method and configure a Google **Desktop app** OAuth client. OpenTeam opens the system browser on the computer running its desktop app. Google returns to a temporary `127.0.0.1` listener on that same computer; OpenTeam relays the response to your selected server. The server exchanges the code and stores the refresh token. No public callback hostname, Tailscale, or SSH callback tunnel is required for this method. The app must still be able to reach the server; use HTTPS or a trusted encrypted network for that connection.

After connecting, sign into the **same OpenTeam server/account on iOS**. The connection is already available there, and the desktop app can be closed. Provider tokens stay on the server. OpenTeam login sessions remain in each device’s secure storage across app restarts.

To perform first-time Google authorization entirely from iOS with the current implementation, use **Server callback** in Connection settings, configure a Google **Web application** OAuth client, and register the displayed callback URL. A remote Google callback requires an HTTPS hostname, reachable by the browser completing sign-in. It does not have to be publicly exposed if that browser can reach it privately with a valid certificate. A raw HTTP LAN/Tailscale IP is not an accepted Google web callback. A Desktop app client is not interchangeable with a Web application client.

iOS does not run the desktop loopback listener. It directs desktop-mode connections to desktop setup and does not reopen a pending desktop callback on the phone. A native Google iOS SDK/custom-scheme flow would be a separate implementation and OAuth client registration; it is not currently provided. See [Google’s installed-app guidance](https://developers.google.com/identity/protocols/oauth2/native-app).

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
