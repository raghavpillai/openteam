# T3 Code

Connect an existing [T3 Code](https://t3.codes) environment to OpenTeam through T3's official remote MCP server. The plugin bundles `t3-code`, `t3-threads`, and `t3-setup`; no separate skill installation or bridge process is needed.

Install from Marketplace, paste the full MCP URL from T3's **Use T3 Code in another app (MCP)** or **Copy MCP URL**, then choose **Validate URL and connect**. OpenTeam checks the URL, starts public-client OAuth with PKCE and dynamic registration, and discovers tools after authorization. No client ID, client secret, or coding-provider API key is required. Invalid URLs fail before sign-in; only authenticated MCP discovery marks the account ready.

If T3 asks for a one-time code, enter the wizard's current code on T3's authorization page. It expires after five minutes and is not stored as an OpenTeam credential. **Auto** is a T3 access level: it uses the selected provider's automatic review to approve routine actions and asks about others. It is separate from OpenTeam's Automatic callback setting. Read-only access cannot start coding tasks. Choose the access you intend to grant; its scope can include every project on that environment.

T3 must have an authenticated coding provider and the project on its host. Use T3 Connect or HTTPS reachable from the OpenTeam server when they run on different computers. Plain HTTP is accepted only for localhost; localhost inside a container refers to the container. Keep T3 online, using its background service for unattended work if appropriate. Add another plugin account for another environment.

Try “Fix the upload crash in OpenBot through T3, using a new worktree,” “How is that T3 task going?” or “Stop the T3 upload fix.” OpenTeam's existing executor and saved-progress continuations follow remote runs and deliver results to the original chat. Human execution approvals stay in T3, reached through the returned thread link. A local observer being stopped does not prove the remote run stopped.

The connector discovers T3's current tool schemas. Its bundled skills use the outside-client thread tools, not internal parent-session delegation. OAuth sessions can expire and need reapproval; no refresh token is assumed. Reconnect to saved work instead of launching duplicates. Plugin account removal does not revoke the T3 grant or interrupt jobs; revoke access separately in T3's **Sharing & access**.

This is an OpenTeam integration, not a T3-published package. See [outside agents](https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md) and [permission modes](https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md).
