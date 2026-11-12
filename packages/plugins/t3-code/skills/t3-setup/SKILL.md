---
name: t3-setup
description: Connect or troubleshoot T3 Code MCP URLs, sign-in, access levels, and unavailable environments.
---

The user installs one T3 Code plugin with its skills and adds an account for each environment. It connects an existing T3 installation; repositories and authenticated coding providers must already be available there.

Use the plugin's account setup to collect the complete MCP URL copied from T3's environment menu or “Use T3 Code in another app (MCP).” Choose public-client OAuth with dynamic registration, not a manually registered client or API token. The URL must be HTTPS, or HTTP on localhost when the OpenTeam server itself runs beside T3. A container's localhost does not reach its host's desktop app. Prefer T3 Connect or reachable tailnet HTTPS for remote hosting.

The link is validated before sign-in; successful authenticated tool discovery establishes readiness. A valid-looking URL alone does not prove a working connection. Read environment identity/projects to check the intended machine without starting a coding job.

The user authorizes on T3's page. A one-time code from the wizard lasts five minutes and approves only its selected access level. Paste it exactly as issued: wizard codes may have an `AUTO-` prefix, while a host CLI pairing code is plain and uses the selected access level. Do not add or change a prefix. Enter it on T3's page if requested; do not save it as an API key, put it into the MCP URL, or ask for it in ordinary chat. If it expired, start a fresh authorization using the host's secure flow.

Read only permits inspection. Supervised asks for execution approval. Auto uses the provider's automatic review for routine actions and can still ask about other actions; providers without equivalent review may fall back to asking. Full access is broader. Explain the choice without changing the user's approved level. The granted access can cover all projects in that T3 environment.

If discovery fails, check reachability, endpoint path (normally `/mcp`), T3 host availability, expired/revoked authorization, and supported outside-client tools. A missing repository/provider should be configured in T3, not silently replaced. Keep existing remote IDs when reconnecting; a new OAuth session changes retry-key scope. Removing a plugin account does not itself stop remote coding work or revoke access in T3; revocation is available under T3 Sharing & access.

See [T3 outside-agent setup](https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md) and [permission modes](https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md).
