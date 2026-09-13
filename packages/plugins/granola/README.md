# Granola

One official Granola MCP connection and three OpenTeam-authored skills: `granola-context`, `granola-prep`, and `granola-review`. The package is maintained by OpenTeam; Granola operates the service.

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

## Provenance and maintenance

Compared with the Granola detail view in Grok Bot on September 12, 2026: one connector and three skills. Its source link points to [Granola's public Cursor plugin](https://github.com/granola-inc/granola-cursor-plugin), inspected at revision `56583da6e4db7f311808543f18ac905b8de1ff85`. That repository did not include a redistribution license at that revision. The skill bodies here are independently authored implementations of those workflows; upstream commands, agents, rules, and skill text are not bundled. Icon provenance is in [assets/SOURCES.md](assets/SOURCES.md).

The endpoint and OAuth behavior follow [Granola's current MCP documentation](https://docs.granola.ai/help-center/sharing/integrations/mcp). Public discovery advertises issuer `https://mcp-auth.granola.ai`, dynamic registration, S256 PKCE, and the protected-resource scope `mcp`. Provider schemas, plan restrictions, and workspace behavior may change independently of this package. See [the plugin guide](../../../docs/plugins.md#granola-setup) for setup and troubleshooting, and the repository's plugin QA evidence for the checks actually performed.

## Validation

September 12, 2026: package generation, portable ZIP import/export with all three skill bodies and unchanged icon bytes, UI installation/setup, real Granola dynamic registration, saved PKCE/state, and reads of all three installed skills through the unprivileged Linux Bot's native file reader passed. The focused catalog, SDK, and OAuth suites passed (29 tests), as did plugin, SDK, server, and desktop type checks.

Live validation with a personal Granola account passed browser OAuth, six-tool discovery, account/workspace verification, meeting listing, natural-language search, and reconnection with saved credentials through OpenTeam's UI. Listing and search returned no accessible notes; folder listing returned Granola's paid-tier restriction. Note and transcript retrieval therefore remain unverified, as do provider token expiry/refresh, a second authenticated identity, and model-driven skill workflows. A separate work identity was blocked by Google's organization 2-Step Verification policy. The shared OAuth account/refresh behavior has existing regression coverage; it is not a substitute for those provider checks.
