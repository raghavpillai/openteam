# Connecting accounts

The setup instructions shipped with each package are the starting point. A catalog entry does not provide a provider subscription, administrative permission, OAuth application, or access to a restricted API.

The walkthroughs below cover [Google's three plugins](#google-access-requirements), [Slack](#slack-application-setup), [Linear](#linear-setup), [Notion](#notion-setup), and [Granola](#granola-setup). Google and Slack require an application registered by the deployment owner. Linear, Notion, and Granola register the OAuth client during connection, so their users can proceed directly to browser sign-in. All steps use OpenTeam and the provider's website; no terminal is required.

| Bundled integration | Setup path | Provider documentation |
| --- | --- | --- |
| Gmail, Google Calendar, Google Drive | Google Cloud project and APIs, OAuth consent configuration, web client credentials, exact callback URLs, then separate account authorization | [Google OAuth client setup](https://developers.google.com/workspace/guides/create-credentials) |
| Linear | Browser OAuth with dynamic client registration; choose the workspace | [Linear MCP](https://linear.app/docs/mcp) |
| Notion | Browser OAuth with dynamic client registration; choose the workspace/pages | [Notion MCP clients](https://developers.notion.com/guides/mcp/build-mcp-client) |
| Granola | Browser OAuth with dynamic client registration; use an existing Granola account and its active workspace | [Granola MCP](https://docs.granola.ai/help-center/sharing/integrations/mcp) |
| Slack | An internal or Marketplace Slack app, required user-token scopes, callback URL, and client credentials | [Slack MCP](https://docs.slack.dev/ai/slack-mcp-server/) |
| GitHub | Provider token with access to the intended repositories and operations | [GitHub MCP host integration](https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md) |

## Google access requirements

Google packages version 1.1.0 and later use the generally available [Gmail](https://developers.google.com/workspace/gmail/api/reference/rest), [Calendar](https://developers.google.com/workspace/calendar/api/v3/reference), and [Drive](https://developers.google.com/workspace/drive/api/reference/rest/v3) APIs through bundled MCP connectors on the Bot computer. They do **not** require Workspace Developer Preview enrollment or the Google MCP APIs.

### Create the Google application

You can use one Google Cloud project and OAuth client for Gmail, Calendar, and Drive. The person doing this setup needs permission to manage that project's APIs and OAuth configuration.

1. In OpenTeam, install the Google plugins you want. Open **Manage plugins → Installed**, select a plugin and account, and copy **OAuth callback URL**. Keep this page open; each account has a different callback.
2. Open [Google Cloud Console](https://console.cloud.google.com/). Use the project picker to select an existing project or **New Project** to create one.
3. Open **APIs & Services → Library**. Search for **Gmail API**, **Google Calendar API**, and **Google Drive API**, and choose **Enable** for each service you will use.
4. Open **Google Auth Platform**. If the project has no OAuth configuration, choose **Get started** and complete **Branding** with an app name, user support email, and developer contact email. This is the name people see when authorizing your deployment.
5. Under **Audience**, choose **External** when connecting personal Google accounts or people outside one Workspace organization. While its publishing status is **Testing**, use **Test users → Add users** to add every Google email address you will connect. **Internal**, when available, is limited to the project's Workspace organization. See [Google's consent-screen guide](https://developers.google.com/workspace/guides/configure-oauth-consent).
6. Under **Data Access → Add or remove scopes**, add the scopes shown in OpenTeam's **Requested scopes**. Use the table below for the bundled defaults; when sharing an OAuth client across plugins, include the scopes for all of those plugins. Save the selection.
7. Open **Clients → Create client**, select **Web application**, and name the client. Under **Authorized redirect URIs**, add each exact OpenTeam callback URL, including `connectionId`. Choose **Create**. OpenTeam exchanges the code on its server, so this flow uses redirect URIs rather than JavaScript origins. See [Google's client-creation guide](https://developers.google.com/workspace/guides/create-credentials).
8. Copy the resulting **Client ID** and **Client secret** into the corresponding OpenTeam account fields. Select **Replace** to enter a new secret. Store the secret in your password manager if you need to reuse the application for another plugin; Google may not let you reveal it again later. OpenTeam stores its saved copy in your deployment's database.

| Plugin | API to enable | Default OAuth scopes |
| --- | --- | --- |
| Gmail | Gmail API | `https://www.googleapis.com/auth/gmail.readonly`, `https://www.googleapis.com/auth/gmail.compose`, `https://www.googleapis.com/auth/gmail.modify` |
| Google Calendar | Google Calendar API | `https://www.googleapis.com/auth/calendar.calendarlist.readonly`, `https://www.googleapis.com/auth/calendar.events.freebusy`, `https://www.googleapis.com/auth/calendar.events.readonly`, `https://www.googleapis.com/auth/calendar.events` |
| Google Drive | Google Drive API | `https://www.googleapis.com/auth/drive.readonly`, `https://www.googleapis.com/auth/drive.file` |

### Authorize and verify each Google account

1. In OpenTeam, choose **Save and authorize**, select the intended Google identity, and review and grant the requested permissions.
2. Wait for the account to become **Ready**. Under **Test a tool**, run `get_profile` with `{}` in Gmail, `list_calendars` with `{}` in Calendar, or `list_recent_files` with `{"pageSize":5}` in Drive. Check the returned identity/data and any provider error, then grant the account to the intended Bots.
3. Repeat authorization for each installed Google plugin. Reusing a client ID and secret does not authorize the other plugins automatically.
4. For another identity, use **New account name → Add account**, register its new callback under the same Google client's **Authorized redirect URIs**, and add its email as a test user if needed. Then authorize that identity separately. No new Cloud project is needed.

The Google packages request offline access and explicit account selection. Each connection gets its own refresh token; the server refreshes expired access tokens automatically and serializes concurrent refreshes. Google's External/Testing applications normally issue refresh tokens that [expire after seven days](https://developers.google.com/identity/protocols/oauth2#expiration), so ongoing use may require reauthorization or a change to the application's publishing status under Google's verification requirements. Workspace administrators can restrict access independently.

### Google capabilities and limits

The 1.2.0 packages cover the published Google MCP tool inputs using public REST APIs. They also retain the earlier OpenTeam argument aliases. All write and destructive tools default to asking for approval.

| Plugin | Included capabilities |
| --- | --- |
| Gmail | Normalized message/thread reads, plaintext and HTML, metadata-only views, search and pagination, rich unsent drafts and replies, binary/inline attachments, nested labels with colors and visibility, trash and spam operations. Attachments are limited to 25 MB combined per draft. There is no send tool. |
| Google Calendar | Event creation, editing, deletion and RSVP; Google Meet links, attachments, reminders, guest permissions, visibility, recurrence and supported special event types; timezone-aware scheduling with working hours and weekend preferences; keyword and local semantic search. Start-only edits preserve duration. |
| Google Drive | Structured search and snippets, metadata and permission reads, copies, binary/text uploads and downloads, Google format conversion, document text extraction, and comment threads on native Docs, Sheets and Slides. Spreadsheet reads include every tab. Drive's `drive.file` scope limits writes to files accessible to the application under that scope. |

Calendar semantic search uses a bundled [English embedding model](https://huggingface.co/minishlab/potion-base-2M) on the Bot computer. It needs no model key or hosted search service. The first search indexes the selected calendar; later searches synchronize changes. It matches related concepts, but its ranking is not Google's proprietary ranking. Recurring events are indexed as series; use `list_events` for dated occurrences. The index supports up to 100,000 events. Descending event lists require an `endTime` to bound recurrence expansion. Special event types and Meet availability still depend on Google account features. Reference event inputs default to notifying attendees (`ALL`); specify `notificationLevel: "NONE"` when notifications are unwanted. The older nested `event` input retains its previous notification default of `none`.

Drive supports text extraction from native Docs/Sheets/Slides, PDF, DOC/DOCX, XLSX, ODS/ODT/ODP, PPTX, PNG and JPEG. PDF and image extraction require the current Bot computer image, which includes Poppler, Antiword and Tesseract. Image OCR is English; scanned PDFs support up to 25 pages. Native extraction has a 45-second total time budget. Text PDFs use their text layer. Unsupported formats return an explicit flag. Files are limited to 64 MB per operation, and Google's native export limit also applies. Compressed documents have bounded expansion limits. This replaces the old 64 KB inline restriction.

Large Google tool results return a `resultId`, `jsonFragment` and `nextOffset`. Call **read_result** on the same plugin account until `nextOffset` is null, concatenate the fragments in offset order, then parse the JSON. This preserves the result without rerunning a provider operation. Snapshots are stored with restricted file permissions on the Bot computer, separated by account, and readable for up to 24 hours subject to size/count eviction. Expired snapshots are removed on subsequent result access or capture; stopping the computer does not immediately erase its disk. Do not repeat a write merely to retrieve its output. Credentials remain in the deployment database; the connector only receives the current access token and an account identifier.

For an update from 1.1.0 to 1.2.0, choose **Apply reviewed update**, then **Restart / refresh tools** for each account. Existing OAuth credentials and account grants are retained; no new scopes are required. If document extraction reports a missing executable, update the Bot computer image as well.

Upgrading from the older Google MCP packages changes the connector transport. Apply the reviewed update, re-enter the OAuth client secret, and authorize each existing account again. Account IDs and callback URLs remain stable. Earlier versions used Google's official MCP endpoints, which currently require [Workspace Developer Preview enrollment](https://developers.google.com/workspace/preview); successful sign-in and tool discovery there did not guarantee that data calls were permitted.

## Slack application setup

Create an **internal** Slack app in the workspace you want to connect. You need permission to create/install apps there; workspace policy may require an administrator's approval.

1. Install Slack in OpenTeam. Open **Manage plugins → Installed**, select its account, and copy **OAuth callback URL**.
2. Open Slack's [Your Apps](https://api.slack.com/apps), sign in to the intended workspace, and choose **Create New App → From a manifest**.
3. Paste the contents of the package's [Slack app manifest](../../packages/plugins/slack/slack-app-manifest.json). Replace `https://YOUR-OPENTEAM-SERVER/api/v0/plugin-oauth/callback?connectionId=YOUR-CONNECTION-ID` with the exact callback from OpenTeam. You can also change the display name to identify your deployment.
4. Choose the workspace, review the manifest and its user-token permissions, and create the app. The manifest configures scopes, the redirect URL, and token rotation; no bot user, event listener, or Slack CLI is needed for this connector.
5. In the new app's dashboard, open **Agents** and turn on **Enable Slack MCP Server**. This is a separate switch from **Mark this app as an agent app**. Leaving MCP disabled produces “App is not enabled for Slack MCP server access” even if OAuth succeeds.
6. Open **Basic Information → App Credentials**. Copy **Client ID** and reveal/copy **Client Secret** into OpenTeam's corresponding fields. Use the OAuth client secret, not Slack's signing secret or an app-level token.
7. In OpenTeam, choose **Save and authorize**, select the intended workspace, and approve the requested access. If Slack requires workspace approval, complete that process before retrying authorization.
8. Once **Ready**, run `slack_search_users` with `{"query":"YOUR-SLACK-EMAIL"}`, replacing the example with your account email, or `slack_list_user_channels` with `{"types":"public_channel","format":"ids_only","limit":5}`. Inspect the result, then grant the account to the intended Bots.

For another account in the same workspace, use **Add account** in OpenTeam, add its callback under the Slack app's **OAuth & Permissions → Redirect URLs**, save the URLs, and authorize separately. Creating an app and connecting a user account are separate steps.

The manifest and package scopes cover Slack's published MCP tools. To limit access, reduce scopes in both places, reauthorize, and disable tools that need the removed permissions. A different workspace may need a separate internal app. Slack permits internal and Marketplace apps to use its MCP server; [unlisted distributed apps are prohibited](https://docs.slack.dev/ai/slack-mcp-server/). No hosted OpenTeam connector or Slack CLI is needed.

## Linear setup

The bundled Linear plugin uses [Linear's hosted MCP service](https://linear.app/docs/mcp). You do not need to create a Linear developer application, obtain an API key, or register a callback yourself.

1. Install **Linear** from **Plugins → Browse**.
2. Open **Manage plugins → Installed**, select Linear and its account, then choose **Save and authorize**.
3. Complete Linear sign-in in the browser, choose the intended workspace, and approve the requested access. Your workspace's application policy still applies.
4. Once **Ready**, run `get_user` with `{"query":"me"}` and verify the returned identity. Grant the account to the intended Bots.
5. Use **Add account** and repeat authorization for another identity/workspace. Each account keeps its own OAuth tokens.

## Notion setup

The bundled Notion plugin uses [Notion's hosted MCP service](https://developers.notion.com/guides/mcp/get-started-with-mcp). You do not need to create an internal Notion integration or paste an integration token for this OAuth flow.

1. Install **Notion** from **Plugins → Browse**.
2. Open **Manage plugins → Installed**, select Notion and its account, then choose **Save and authorize**.
3. Sign in to Notion, choose the intended workspace, and review the access requested on the consent screen. Complete any page/access selection that Notion presents, then authorize.
4. Once **Ready**, run `notion-get-users` with `{"user_id":"self"}`. Verify the returned identity/workspace, then grant the account to the intended Bots.
5. Use **Add account** and repeat authorization for another identity/workspace. A successful connection does not grant access to pages the user cannot access or remove provider plan restrictions on individual tools.

Notion 1.1.0 is a hybrid package with 14 OpenTeam-authored skills for search, finding content, page/task/database creation, database queries, knowledge capture, meeting preparation, research, implementation planning, and task workflows. Review them under **Bot access and plugin details → Skills**. Enable skills for the intended Bot and grant the Notion account separately. The workflow inventory matches the inspected Notion package in Grok Bot; the instructions are independently authored and the official Notion service supplies the tools. See the [package README](../../packages/plugins/notion/README.md) for provenance.

## 1Password setup

The [1Password package](../../packages/plugins/1password/README.md) uses the official **local Environments MCP server**. It includes environment management, variable-name inspection, and local `.env` mounts. It does not retrieve vault passwords or stored secret values.

1. Update and unlock **1Password** on macOS or Linux.
2. Open **Settings → Developer** and select **Integrate with MCP clients**. Complete any macOS setup/administrator prompt. The main window also has **Developer → MCP Server** with the enable checkbox. Older versions additionally require **Settings → Labs → MCP Server**; [1Password removed the Labs entry in 8.12.34](https://releases.1password.com/mac/stable/), so its absence alone does not indicate missing account access. If Developer has no MCP option, check with 1Password or your administrator; Business administrators can control **Policies → Agentic permissions → Local MCP server**.
3. Keep **OpenTeam desktop** open on the same computer. Add **1Password** from the Marketplace, select **Connect**, and approve 1Password's own prompt. No API token, developer application registration, or terminal configuration is needed.
4. Grant the connection and skill to the intended Bots. For a test, open the connection's **Test a tool** controls, run `authenticate` with `{}`, and use the returned account ID with `list_environments`. A first operation on an environment may require another prompt in 1Password.

Connect performs authentication before reporting readiness. Background health checks do not open native authorization prompts. Locking 1Password ends its authorization; unlock and reconnect from the UI if a later call requires it. Multiple OpenTeam aliases have isolated MCP processes and Bot grants, but the accounts visible to each process are chosen in 1Password; an alias does not pin a particular 1Password account.

If the provider says the desktop app is not running despite it being open, check for an unfinished macOS setup prompt: the first-time MCP command installation can leave the local service unavailable until that prompt completes. The enable checkbox and successful tool discovery alone do not prove authorization works.

The OpenTeam server and Bot computer reach the native provider through the existing authenticated desktop bridge. Browser-only deployments need that desktop connection configured. Local `.env` mounts are FIFOs on the user's computer; they are not mounted into Bot containers. Run consuming applications on that same computer. Windows is unsupported. The reference Cursor package also has a shell-validation hook; this OpenTeam package supplies the MCP and a workflow skill, not that Cursor hook. [Official MCP setup and tool reference](https://www.1password.dev/environments/mcp-server).

## Granola setup

The [Granola package](../../packages/plugins/granola/README.md) uses Granola's official MCP service. No developer enrollment, API key, client ID, or client secret is needed. Have an existing Granola account; check its email and active workspace in the Granola app before connecting.

1. Install **Granola** from **Plugins → Browse** and open its account.
2. Choose **Continue to authorization** (or **Save and authorize** in the full settings workspace), sign in with your Granola identity, and review the provider's requested access. OpenTeam handles registration and PKCE automatically.
3. Return to OpenTeam. In **Manage → Accounts and settings → Installed**, run `get_account_info` with `{}` under **Test a tool** to confirm the account and workspace. Then run `list_meetings` using the displayed input schema. Check for provider errors even if the account is connected.
4. Enable the plugin and its three skills for a Bot, then grant the intended account. The skills retrieve meeting context, prepare meeting briefs, and review work against recorded decisions.
5. Use **Add Another Account** for another Granola identity. Each has separate tokens and grants. If Granola silently signs in to the wrong identity, sign out of Granola in the browser before connecting the new account, or complete authorization in a private browser window. Verify each connection with `get_account_info`.

Granola supplies meeting search, lists, folders, notes, transcripts, and account information according to the connected account's access. It does not expose recording or note editing through this connector. **Basic** accounts have personal notes from the last 30 days and restrictions on some search, folder, and transcript tools. **Business** includes accessible personal and public notes. **Enterprise** administrators control member MCP access under **Settings → Workspace → General → Apps & connectors → MCP access for members**. This package uses ordinary browser OAuth; Enterprise-Managed Authorization through an identity provider is not implemented.

MCP follows the active workspace selected in Granola and only returns notes belonging to that workspace. Adding multiple OpenTeam accounts does not pin workspaces or combine their contents. For missing notes, confirm identity and workspace first, then plan and sharing permissions. “User has not created a Granola account yet” usually indicates a different login email. See [Granola's current access and troubleshooting documentation](https://docs.granola.ai/help-center/sharing/integrations/mcp).

Granola sign-in also follows your identity provider's MFA policy. If Google reports that your sign-in settings do not meet the organization's **2-Step Verification policy**, use an organization-approved second factor or have the workspace administrator resolve your account's enrollment. OpenTeam cannot fix that error by reconnecting the plugin; authorization has not reached Granola yet.

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| OAuth redirect mismatch | Register the selected account's full callback URL, including the query string; verify the deployment public URL |
| OAuth client rejected | Check client ID, saved secret, client type, and token endpoint authentication method |
| The wrong account was authorized | Select the intended connection, reauthorize, and choose the correct identity in the provider's browser flow |
| Sign-in requires MFA or organization SSO | Complete the provider's verification; a password alone may not satisfy it |
| An old sign-in tab reports an invalid OAuth state | Close the old authorization tab and choose **Retry** on the plugin account to start a fresh session; complete it within 15 minutes |
| Authorization succeeded but discovery failed | Try **Restart / refresh tools** and inspect endpoint reachability and provider status |
| Tools are listed, but calls return errors | Inspect `isError` and the provider message; check scopes, account/workspace permissions, plan, API enablement, and preview enrollment |
| A connected tool is missing for a Bot | Check package availability, that Bot's account grant, the tool's enabled checkbox, and workspace/Bot policies |
| A packaged process cannot start | Check the command, JSON argument array, working directory, included files, runtime dependencies, and setup fields on the Bot computer |
