# Granola

Granola's official MCP service and original Cursor plugin workflows: three
skills, six commands, one agent, and one rule. OpenTeam supplies account setup
and shared host compatibility.

## Workflows

Enable **Instructions and hooks** and grant the intended Granola account.
Original commands are `/granola-brief`, `/granola-plan`, `/granola-spec`,
`/granola-pr`, `/granola-gaps`, and `/granola-bug-report`, followed by your topic.
Namespaced commands such as `/granola:granola-plan` and the earlier
`/granola:plan` spelling also work. The original agent is
`plugin_agent: "granola:granola-engineer"`; `granola:engineer` remains an alias.

## Connect through the UI

1. Install **Granola** from **Plugins → Browse**.
2. Open the plugin's account and choose **Continue to authorization** (or **Save and authorize** in the full settings workspace). No API key, developer application, client ID, or client secret is required. OpenTeam registers a public OAuth client automatically and uses PKCE.
3. Sign in with the email shown in your Granola app and review Granola's consent screen. Return to OpenTeam to finish tool discovery.
4. In **Manage → Accounts and settings → Installed**, run `get_account_info` with `{}` under **Test a tool**. Confirm the account and active workspace, then test `list_meetings` using its displayed schema.
5. Enable the package for the intended Bot, enable its skills, and grant that Bot the account. Try “What decisions did we make in recent meetings?”

Use **Add Another Account** for another identity. Each account has separate OAuth registration, tokens, tools, settings, and Bot grants in the deployment's database. If the browser silently selects the wrong Granola identity, sign out of Granola in the browser before authorizing the new account, or use a private browser window. Verify the result with `get_account_info`.

## Tools and limits

OpenTeam discovers Granola's tools dynamically; the manifest does not pin their schemas. Granola currently documents semantic meeting queries, meeting lists, folder lists, note retrieval, transcripts, and account/workspace information. These are read capabilities; the connector does not record meetings, create or edit notes, or send follow-ups.

- **Basic:** personal notes from the last 30 days; some search, folder, and transcript capabilities require a paid plan.
- **Business:** accessible personal and public notes in the active workspace.
- **Enterprise:** workspace administrators control member MCP access to personal and public notes. Ordinary browser OAuth is supported; this package does not implement Enterprise-Managed Authorization through an organization's identity provider.
- MCP follows the workspace selected in Granola. Multiple OpenTeam accounts separate identities; they do not pin a Granola workspace or combine notes across workspaces.
- An existing Granola account is required. “User has not created a Granola account yet” usually means the wrong identity was selected. Empty results can also indicate a different active workspace or plan restrictions.
- Google Workspace may require an organization-approved second factor before Granola sign-in. If Google says the account's sign-in settings do not meet its 2-Step Verification policy, complete verification with an approved method or have the workspace administrator resolve the account's enrollment. Reinstalling Granola or creating an OpenTeam OAuth client cannot resolve an identity-provider policy error.

Credentials remain in the user's deployment database and are not included in exported packages. No Granola desktop files or internal tokens are read. The deployment needs outbound HTTPS and a browser-reachable OAuth callback.

## Source and updates

[Granola's original package](https://github.com/granola-inc/granola-cursor-plugin/tree/56583da6e4db7f311808543f18ac905b8de1ff85)
is pinned by revision and file hashes in `upstream.json`. That revision declares
no redistribution license, so the shipped registry carries source metadata.
Install or update downloads the pinned original files directly from GitHub,
checks every hash, and saves them under `upstream/` in the installed snapshot.
Subsequent execution and unchanged-source updates reuse those saved files.
A failed download or hash check leaves the installed version intact.

No skill, command, agent, or rule text is rewritten. Host tool mapping and
account guidance are supplied by shared runtime code. The existing connection
key, OAuth registration, credentials, and grants are preserved on upgrade.
Choose **Reconnect** after updating to rediscover tools with saved authorization.

## Validation scope

Source integrity, ZIP preservation, command expansion, runtime loading, and
account-preserving upgrades are tested separately from live provider behavior.
Earlier live checks passed OAuth, account verification, listing, search, and
reconnection, but returned no accessible notes. Retrieval of real transcripts
and model-driven execution of the newly restored workflows remain unverified.
