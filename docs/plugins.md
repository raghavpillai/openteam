# Using and developing plugins

Plugins add tools, reusable skills, or both to OpenTeam Bots. Install, configure, authorize, test, update, and remove them through the app. Each deployment owns its provider configuration and credentials; OpenTeam does not supply a hosted account-connection service.

This guide covers [using plugins](#using-plugins), [provider setup](#provider-setup), [developing packages](#developing-packages), and [contributing to the repository](#contributing-to-the-repository).

## Plugin types

| Type | What it contains | Where it runs |
| --- | --- | --- |
| Skills | Instructions in `SKILL.md`, with optional supporting files | Available to the Bots that have the skills enabled |
| Remote MCP | Connections to MCP servers over HTTP(S) | The OpenTeam server connects to a provider-operated or deployment-operated endpoint |
| Packaged MCP | An MCP executable and its supporting files | A process on the Bot computer, communicating over standard input/output |
| Hybrid | Skills and MCP connections in one package | Skills guide the Bot; connections provide tools |

The **Develop** screen has templates for all four types. Its hybrid template starts with skills and a packaged MCP server; a package can also combine skills with HTTP connections. A package may contain several skills and connections.

The bundled Utility Lab uses an internal connector for testing. The `builtin` transport is reserved for supported OpenTeam functionality; new integrations should use HTTP or packaged MCP.

## Using plugins

### Install and connect

1. Open **Plugins** to browse the **Marketplace**. Search or choose a category, then select **Add** beside a plugin. **Added** means the package is installed.
2. Open the plugin to see **Accounts**, **Connectors**, and **Skills**. A new account displays its provider setup form. For the full configuration and tool tester, choose **Manage → Accounts and settings → Installed**, then select the **Installed plugin** and **Connection / account**.
3. Follow its setup instructions and fill in the required fields. Depending on the provider, this may mean an API token, an OAuth client ID and secret, or simply browser authorization.
4. Choose **Save and authorize** for OAuth, or **Save and connect** for other connections. Complete provider sign-in and consent in the browser.
5. Check the connection status and discovered tools. Under **Test a tool**, select a read-only tool, enter its JSON arguments, and choose **Run test**.
6. Open **Bot access and plugin details** and grant the account to the Bots that should use it. For skills, enable the package's skills for the relevant Bots.

Choose **Your plugins** (the installed count above search) for a compact list of installed packages and private skills. **Manage plugins** opens the full workspace. In a plugin detail, use the pencil to rename an account, the settings icon for its advanced controls, and **Add Another Account** to connect another identity. **Retry** starts authorization again when needed. Connector and skill lists start collapsed; their counts describe package components, independently of the number of accounts.

On mobile, the equivalent workspace is under **Plugins → Manage**, with **Installed**, **Private skills**, **Sources**, and **Develop** sections. Desktop also supports loading a package folder from the file picker.

**Connected** in the desktop account row (or **Ready** in the full workspace) means the connection completed discovery. It does not guarantee that every provider tool is permitted. Inspect the test result: a response containing `isError: true` is a failed tool call even when the connection remains ready. Start with a small read, then verify the intended behavior from a Bot conversation.

### Authentication modes

| Mode | What you configure |
| --- | --- |
| No connection authentication | An endpoint or packaged process configuration; no HTTP login is needed |
| Token | A provider token, or secret setup fields used in headers/environment variables |
| OAuth with dynamic registration | Sign in and consent; the provider registers the client during authorization |
| OAuth with a manually registered client | Create an application in the provider's dashboard, register the displayed callback URL, and enter its client ID and any required secret |

Browser OAuth supports public clients with PKCE and confidential clients using either a secret in the token request or HTTP Basic authentication. **Server settings** exposes the token endpoint authentication method when needed. Use the method required by the provider; the bundled package supplies its default.

For manually configured OAuth, copy **OAuth callback URL** exactly, including its `connectionId` query parameter. It is derived from the deployment's public URL. In a deployed setup, it must lead the browser back to that deployment; see [deployment configuration](deployment.md).

### Multiple accounts

You can connect more than one account to the same plugin. For example, a Bot can have access to both a personal Gmail account and a work Gmail account.

1. Select an existing connection in **Manage plugins → Installed**.
2. Enter a **New account name**, such as `work`, and choose **Add account**.
3. Select the new entry in **Connection / account**.
4. Review its configuration. If it uses a manually registered OAuth application, add this account's displayed callback URL to that application's allowed redirects.
5. Authorize the intended provider identity in the browser, run a read test, and grant that account to the appropriate Bots.

Each account has a stable ID and separate OAuth tokens, instructions, tool preferences, activity, and Bot grants. Renaming an account preserves its ID and routing. Adding an account does not copy its access or refresh tokens. A package can explicitly permit reuse of the provider application's client ID and secret; each account still needs its own authorization. Account headers and environment credentials are not copied into the new account.

Gmail, Google Calendar, and Google Drive are separate plugins. Authorizing one does not authorize the other two. Register each connection's callback URL even when the connections reuse one Google OAuth application.

### Bot access and tool approvals

Installation, account access, and permission to run a tool are separate controls:

| Control | Effect |
| --- | --- |
| Bot access | Chooses which Bots may use an account or the package's skills |
| Tool enabled checkbox | Hides a disabled tool from Bots |
| **Allow** | Permits the tool without an approval prompt, subject to other access controls |
| **Ask first** | Requires approval before execution |
| **Deny** | Blocks execution |

Workspace restrictions take precedence over a Bot's preferences. Under **Package version, updates, and workspace policy**, installation modes are **Optional**, **Default**, **Required**, and **Disabled**. Default and required packages affect availability to Bots; they do not automatically grant private account access. Required packages cannot be disabled by an individual Bot.

The tool tester requires an additional confirmation for tools that may change provider data. Use disposable data for those tests. Approval settings do not grant missing provider scopes or workspace permissions.

In a Bot conversation, **Allow once** executes only the reviewed call and leaves its policy unchanged. The result is delivered back to the Bot so it can verify the operation and continue, even if its previous turn ended while waiting. Repeated approval submissions do not repeat the provider write or queue another continuation. A failed or uncertain write is reported as such; it must not be repeated automatically.

### Secrets and saved configuration

Configure secrets in the selected account's setup form. **Keep saved value**, **Replace**, and **Clear** are distinct operations. Saved secret values are not returned by the configuration screen.

Credentials and OAuth sessions live in the deployment's database, separately from package definitions. Package exports do not include account values, credentials, grants, or activity. A running connector receives the credentials it needs through the configured transport. For packaged OAuth, the server exchanges and refreshes tokens in the database and passes only the current access token into the declared environment variable on the Bot computer. Client secrets and refresh tokens stay on the server. Other packaged connectors receive their explicitly configured environment. Do not put tokens in skill instructions or package source files.

### Updates, disconnection, and removal

- **Restart / refresh tools** reconnects and refreshes the tool inventory. Use it after a provider change or a temporary discovery failure.
- **Reauthorize** starts a new browser authorization flow for the selected account.
- **Disconnect** stops the connection and invalidates pending authorization callbacks. Saved credentials remain available for reconnection. Use **Remove account** to remove saved account credentials and grants. Revoke access in the provider's dashboard when you also want to invalidate the provider-side grant.
- **Remove account** removes that connection and its associated local access settings. Other accounts remain separate.
- **Apply reviewed update** installs an available package version after showing its changes. Compatible accounts and preferences are retained; changed connectors may need setup again, and removed connectors lose their accounts.
- **Restore previous package** returns to the retained previous package definition. It is not a database restore for account records removed by an update.
- **Uninstall** removes the installed package. Export the package first if you want to keep its definition and files.

Draft edits and source refreshes do not silently replace an installed package. Installations retain a versioned snapshot until an update is applied.

### Custom servers, sources, and private skills

Use **Add custom MCP** to connect an HTTP endpoint directly. For a reusable package, packaged executable, or mixed skills/tools bundle, use **Manage plugins → Develop** instead.

Under **Sources**, add a catalog URL and refresh it to discover its packages. The server must be able to fetch that URL. A source cannot take over a package key already owned by another source or the bundled catalog. Removing a source leaves installed snapshots in place.

Under **Private skills**, create instructions or import a `SKILL.md` file, add supporting files, and choose the Bots that can use the skill. Private skills stay in the deployment's database and do not require a distributable package.

## Provider setup

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

### Google access requirements

Google packages version 1.1.0 and later use the generally available [Gmail](https://developers.google.com/workspace/gmail/api/reference/rest), [Calendar](https://developers.google.com/workspace/calendar/api/v3/reference), and [Drive](https://developers.google.com/workspace/drive/api/reference/rest/v3) APIs through bundled MCP connectors on the Bot computer. They do **not** require Workspace Developer Preview enrollment or the Google MCP APIs.

#### Create the Google application

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

#### Authorize and verify each Google account

1. In OpenTeam, choose **Save and authorize**, select the intended Google identity, and review and grant the requested permissions.
2. Wait for the account to become **Ready**. Under **Test a tool**, run `get_profile` with `{}` in Gmail, `list_calendars` with `{}` in Calendar, or `list_recent_files` with `{"pageSize":5}` in Drive. Check the returned identity/data and any provider error, then grant the account to the intended Bots.
3. Repeat authorization for each installed Google plugin. Reusing a client ID and secret does not authorize the other plugins automatically.
4. For another identity, use **New account name → Add account**, register its new callback under the same Google client's **Authorized redirect URIs**, and add its email as a test user if needed. Then authorize that identity separately. No new Cloud project is needed.

The Google packages request offline access and explicit account selection. Each connection gets its own refresh token; the server refreshes expired access tokens automatically and serializes concurrent refreshes. Google's External/Testing applications normally issue refresh tokens that [expire after seven days](https://developers.google.com/identity/protocols/oauth2#expiration), so ongoing use may require reauthorization or a change to the application's publishing status under Google's verification requirements. Workspace administrators can restrict access independently.

#### Google capabilities and limits

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

### Slack application setup

Create an **internal** Slack app in the workspace you want to connect. You need permission to create/install apps there; workspace policy may require an administrator's approval.

1. Install Slack in OpenTeam. Open **Manage plugins → Installed**, select its account, and copy **OAuth callback URL**.
2. Open Slack's [Your Apps](https://api.slack.com/apps), sign in to the intended workspace, and choose **Create New App → From a manifest**.
3. Paste the contents of the package's [Slack app manifest](../packages/plugins/slack/slack-app-manifest.json). Replace `https://YOUR-OPENTEAM-SERVER/api/v0/plugin-oauth/callback?connectionId=YOUR-CONNECTION-ID` with the exact callback from OpenTeam. You can also change the display name to identify your deployment.
4. Choose the workspace, review the manifest and its user-token permissions, and create the app. The manifest configures scopes, the redirect URL, and token rotation; no bot user, event listener, or Slack CLI is needed for this connector.
5. In the new app's dashboard, open **Agents** and turn on **Enable Slack MCP Server**. This is a separate switch from **Mark this app as an agent app**. Leaving MCP disabled produces “App is not enabled for Slack MCP server access” even if OAuth succeeds.
6. Open **Basic Information → App Credentials**. Copy **Client ID** and reveal/copy **Client Secret** into OpenTeam's corresponding fields. Use the OAuth client secret, not Slack's signing secret or an app-level token.
7. In OpenTeam, choose **Save and authorize**, select the intended workspace, and approve the requested access. If Slack requires workspace approval, complete that process before retrying authorization.
8. Once **Ready**, run `slack_search_users` with `{"query":"YOUR-SLACK-EMAIL"}`, replacing the example with your account email, or `slack_list_user_channels` with `{"types":"public_channel","format":"ids_only","limit":5}`. Inspect the result, then grant the account to the intended Bots.

For another account in the same workspace, use **Add account** in OpenTeam, add its callback under the Slack app's **OAuth & Permissions → Redirect URLs**, save the URLs, and authorize separately. Creating an app and connecting a user account are separate steps.

The manifest and package scopes cover Slack's published MCP tools. To limit access, reduce scopes in both places, reauthorize, and disable tools that need the removed permissions. A different workspace may need a separate internal app. Slack permits internal and Marketplace apps to use its MCP server; [unlisted distributed apps are prohibited](https://docs.slack.dev/ai/slack-mcp-server/). No hosted OpenTeam connector or Slack CLI is needed.

### Linear setup

The bundled Linear plugin uses [Linear's hosted MCP service](https://linear.app/docs/mcp). You do not need to create a Linear developer application, obtain an API key, or register a callback yourself.

1. Install **Linear** from **Plugins → Browse**.
2. Open **Manage plugins → Installed**, select Linear and its account, then choose **Save and authorize**.
3. Complete Linear sign-in in the browser, choose the intended workspace, and approve the requested access. Your workspace's application policy still applies.
4. Once **Ready**, run `get_user` with `{"query":"me"}` and verify the returned identity. Grant the account to the intended Bots.
5. Use **Add account** and repeat authorization for another identity/workspace. Each account keeps its own OAuth tokens.

### Notion setup

The bundled Notion plugin uses [Notion's hosted MCP service](https://developers.notion.com/guides/mcp/get-started-with-mcp). You do not need to create an internal Notion integration or paste an integration token for this OAuth flow.

1. Install **Notion** from **Plugins → Browse**.
2. Open **Manage plugins → Installed**, select Notion and its account, then choose **Save and authorize**.
3. Sign in to Notion, choose the intended workspace, and review the access requested on the consent screen. Complete any page/access selection that Notion presents, then authorize.
4. Once **Ready**, run `notion-get-users` with `{"user_id":"self"}`. Verify the returned identity/workspace, then grant the account to the intended Bots.
5. Use **Add account** and repeat authorization for another identity/workspace. A successful connection does not grant access to pages the user cannot access or remove provider plan restrictions on individual tools.

Notion 1.1.0 is a hybrid package with 14 OpenTeam-authored skills for search, finding content, page/task/database creation, database queries, knowledge capture, meeting preparation, research, implementation planning, and task workflows. Review them under **Bot access and plugin details → Skills**. Enable skills for the intended Bot and grant the Notion account separately. The workflow inventory matches the inspected Notion package in Grok Bot; the instructions are independently authored and the official Notion service supplies the tools. See the [package README](../packages/plugins/notion/README.md) for provenance.

### Granola setup

The [Granola package](../packages/plugins/granola/README.md) uses Granola's official MCP service. No developer enrollment, API key, client ID, or client secret is needed. Have an existing Granola account; check its email and active workspace in the Granola app before connecting.

1. Install **Granola** from **Plugins → Browse** and open its account.
2. Choose **Continue to authorization** (or **Save and authorize** in the full settings workspace), sign in with your Granola identity, and review the provider's requested access. OpenTeam handles registration and PKCE automatically.
3. Return to OpenTeam. In **Manage → Accounts and settings → Installed**, run `get_account_info` with `{}` under **Test a tool** to confirm the account and workspace. Then run `list_meetings` using the displayed input schema. Check for provider errors even if the account is connected.
4. Enable the plugin and its three skills for a Bot, then grant the intended account. The skills retrieve meeting context, prepare meeting briefs, and review work against recorded decisions.
5. Use **Add Another Account** for another Granola identity. Each has separate tokens and grants. If Granola silently signs in to the wrong identity, sign out of Granola in the browser before connecting the new account, or complete authorization in a private browser window. Verify each connection with `get_account_info`.

Granola supplies meeting search, lists, folders, notes, transcripts, and account information according to the connected account's access. It does not expose recording or note editing through this connector. **Basic** accounts have personal notes from the last 30 days and restrictions on some search, folder, and transcript tools. **Business** includes accessible personal and public notes. **Enterprise** administrators control member MCP access under **Settings → Workspace → General → Apps & connectors → MCP access for members**. This package uses ordinary browser OAuth; Enterprise-Managed Authorization through an identity provider is not implemented.

MCP follows the active workspace selected in Granola and only returns notes belonging to that workspace. Adding multiple OpenTeam accounts does not pin workspaces or combine their contents. For missing notes, confirm identity and workspace first, then plan and sharing permissions. “User has not created a Granola account yet” usually indicates a different login email. See [Granola's current access and troubleshooting documentation](https://docs.granola.ai/help-center/sharing/integrations/mcp).

Granola sign-in also follows your identity provider's MFA policy. If Google reports that your sign-in settings do not meet the organization's **2-Step Verification policy**, use an organization-approved second factor or have the workspace administrator resolve your account's enrollment. OpenTeam cannot fix that error by reconnecting the plugin; authorization has not reached Granola yet.

### Troubleshooting

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

## Developing packages

### Start in the UI

1. Open **Plugins → Manage plugins → Develop**.
2. Choose **Skills**, **Remote MCP**, **Packaged MCP**, or **Hybrid skills + packaged MCP**, then **Create plugin**. The packaged templates include a working `greet` server using the Bun runtime already on the Bot computer.
3. Give the package a stable key, name, version, description, and publisher. Edit **Package definition**, or edit its files in your editor and use **Load / reload folder** on desktop. ZIP/manifest and URL imports are also available.
4. Choose **Validate and save**. This validates the draft without changing an installed version.
5. Choose **Install for testing**, then configure its account under **Installed**. For an already installed package, review and apply the available update.
6. Run a tool test, enable the package/account for a test Bot, and verify the actual Bot behavior. For the unmodified packaged template, call `greet` with `{"name":"World"}`.
7. Return to **Develop → Export ZIP** to share the draft, or export the installed package from **Installed**.

Loading the same package key updates its draft. Use a new key for a different plugin and increment the version for a distributable update. Saving a draft, testing an installation, and distributing a package are separate steps.

### Directory layout

Every bundled plugin belongs in one directory:

```text
packages/plugins/my-plugin/
├── plugin.json
├── README.md
├── skills/
│   └── my-skill/
│       ├── SKILL.md
│       └── references/
│           └── workflow.md
└── connector/
    ├── server.mjs
    ├── src/
    ├── test/
    └── assets/
```

Include only the parts the plugin needs. A skills package does not need `connector/`; a provider-operated HTTP connection usually needs no executable. Keep a connector's source, tests, assets, and dependency/build configuration under `connector/`. Supply a runnable entry point and the assets it needs; package installation does not build the connector or install its dependencies automatically. Repository packages may use `connector/server.ts`: catalog generation bundles it into portable `connector/server.mjs`, including imports from `packages/plugins/_shared/`. Keep reusable protocol helpers there and service-specific tools in their provider package. The exported package includes the executable, so installation requires no dependency setup.

The importer preserves package-relative text and binary files. It rejects unsafe paths and excluded private/generated files. Keep `.env`, credentials files, `.git`, and `node_modules` out of the bundle. Bundled package discovery also rejects symlinks.

### Package icons and marketplace copy

Every bundled package owns its artwork in `assets/`. For a contributed package, add a square PNG, JPEG, or WebP file (192 × 192 pixels recommended, at most 256 KB) and declare its relative path:

```json
"icon": "assets/icon.png"
```

Keep the original vector artwork and its source/license attribution in `assets/icon.svg` and `assets/SOURCES.md` when available. The declared display icon is raster so the same asset works on desktop and native mobile. Icons travel with folder and ZIP imports, installed snapshots, and exports; users do not need a hosted image service or an icon API key. Use **Develop → Load / reload folder** or **Import ZIP or manifest** to import the package with its assets. A bare manifest URL cannot supply a package-relative binary icon; use a folder, repository, or release ZIP that includes it.

The marketplace, installed list, plugin details, and package studio show these icons. Existing installed versions without artwork can use the current catalog's icon without applying a package update. Custom packages without an icon, or with an image that cannot load, receive a puzzle icon. Legacy `logoUrl` images remain supported, but a packaged icon takes precedence and works offline.

Use the provider's recognizable mark for integrations and original artwork for other packages. Write a short, plain description of what the plugin actually does. Keep provider setup requirements in `setup` and contributor details in the README. Do not imply that a package is published by the provider unless it is.

### Manifest example: a skills package

The following is a complete `plugin.json` for the accompanying skill file:

```json
{
  "schemaVersion": 1,
  "key": "release-review",
  "version": "1.0.0",
  "name": "Release Review",
  "description": "Review a release against its documented acceptance criteria.",
  "publisher": "Your name",
  "category": "Productivity",
  "featured": false,
  "components": ["skills"],
  "connections": [],
  "skills": [
    {
      "name": "release-review",
      "description": "Use when reviewing a release before publication.",
      "path": "skills/release-review"
    }
  ]
}
```

Create `skills/release-review/SKILL.md`:

```markdown
---
name: release-review
description: Use when reviewing a release before publication.
---

Read the release's acceptance criteria and the supplied validation results.
Report missing checks and unresolved failures with references to the evidence.
```

When a skill declares a `path` and omits its body, package import loads the `SKILL.md` there. Supporting files retain their relative paths. An inline skill can instead provide a `body` in the definition.

The schema and validation live in [SDK types](../packages/plugin-sdk/src/types.ts) and [manifest validation](../packages/plugin-sdk/src/manifest.ts). Use the shared importer for packages containing skill files; a raw manifest is not the fully resolved package definition.

### Add an MCP connection

Declare `"mcp"` in `components` and add a connection with a stable key, name, transport, authentication mode, endpoint, and tools. `tools: []` requests discovery when connecting. The UI templates provide the surrounding manifest.

For a remote endpoint, use `transport: "http"`. OpenTeam tries Streamable HTTP and supports legacy SSE fallback. Use `auth: "none"`, `"token"`, or `"oauth"` according to the server. An HTTP endpoint may be operated by the provider or by the user's deployment; it does not have to be hosted by OpenTeam.

For a packaged server, the connection configuration looks like this:

```json
{
  "key": "tools",
  "name": "My tools",
  "transport": "stdio",
  "auth": "none",
  "endpoint": "",
  "tools": [],
  "configuration": {
    "command": "bun",
    "args": ["${PLUGIN_ROOT}/connector/server.mjs"],
    "cwd": "${PLUGIN_ROOT}",
    "env": { "EXAMPLE_API_TOKEN": "${API_TOKEN}" }
  }
}
```

`${PLUGIN_ROOT}` resolves to the materialized package on the Bot computer. Arguments are a JSON array, never a shell command string. Keep protocol output on stdout and diagnostics on stderr. The example's `auth: "none"` describes the local MCP transport; its server can still authenticate to a provider API using the configured environment token. Packaged connectors can also use browser OAuth with `auth: "oauth"` and the authorization-server settings below.

### Setup fields and credentials

For the packaged example above, add this field to the package's `setupFields`:

```json
{
  "key": "API_TOKEN",
  "label": "Example API token",
  "type": "string",
  "required": true,
  "secret": true,
  "helpText": "Create a token in the provider dashboard and enter it here."
}
```

`${FIELD_NAME}` substitutes a configured value. Fields support `string`, `number`, `integer`, and `boolean` types, plus required flags, non-secret defaults, and enumerated choices. Every credential field must be marked `secret: true` and have no default.

A package's `setup` describes guided setup for its `connectionKey`; a connection can declare its own `setup`. Include the title, description, provider documentation URL, steps, fields, and required scopes. Setup kinds are `none`, `token`, `oauth`, and `oauth_client`. For the standard HTTP token flow, use the secret field key `token`. For manually registered OAuth clients, use `clientId` and secret `clientSecret`.

### OAuth configuration

Use the [Linear package](../packages/plugins/linear/plugin.json) as a dynamic/public OAuth example and the [Gmail package](../packages/plugins/gmail/plugin.json) as a manually configured/confidential example.

| Connection setting | Purpose |
| --- | --- |
| `oauth.clientType` | Declares `public` or `confidential` |
| `oauth.registration` | Declares `dynamic` or `manual` setup |
| `oauth.tokenEndpointAuthMethod` | `none`, `client_secret_post`, or `client_secret_basic` |
| `oauth.authorizationServer` | For packaged OAuth: explicit `issuer`, `authorizationUrl`, and `tokenUrl`; HTTPS except loopback development servers |
| `oauth.accessTokenEnv` | For packaged OAuth: environment variable receiving only the current access token |
| `oauth.shareClientCredentials` | Explicitly permits copying the provider application's client credentials when adding an account; never its OAuth tokens |
| `setup.requiredScopes` | Supplies the initial configured scope list and user-facing explanation |
| `configuration.oauthAuthorizationParameters` | Supplies supported provider authorization extensions: `access_type` and `prompt` |

Only `access_type` and `prompt` are applied from authorization extensions. State, PKCE, callback URL, and client ID remain controlled by the OAuth flow. Google uses `access_type: "offline"` and `prompt: "consent select_account"` to request refresh tokens and account selection, following [Google's OAuth guidance](https://developers.google.com/identity/protocols/oauth2/web-server).

Document provider API enablement, application registration, callback restrictions, required scopes, supported account/workspace types, plan requirements, and any enrollment dependency. Do not assume that dynamic registration is available or that a user has the provider's administrative permissions.

### Tool behavior and approvals

Give every tool a useful description and an accurate JSON input schema. Declare read-only and destructive MCP annotations accurately. For discovered tools, a read-only, non-destructive tool defaults to allow; other tools default to an approval prompt. Static tool definitions use `risk: "read" | "write" | "destructive"` and `defaultDecision: "allow" | "prompt" | "deny"`.

Support paginated tool discovery if the server has more tools than one response can contain. OpenTeam also handles tool-list change notifications. Return provider failures as failures rather than success-shaped text, and keep tokens out of results and logs. Never infer permissions solely from a successful `tools/list` response.

Google compatibility references are pinned in `packages/plugins/_shared/reference/`. When updating them, compare behavior as well as schemas: defaults, pagination, MIME formats, account routing, notifications, and error handling. Bundled model assets need a pinned revision, checksum, license and provenance; installation must not depend on a first-run download. The Google result store demonstrates paging large results without repeating writes. Keep provider features inside the package and reusable transport/result code in `_shared/`.

Use `createToolValidator` from `@openteam/plugin-sdk/json-schema` when validating executable connector inputs. It preserves JSON Schema format validation while handling large base64 `byte` fields without the grouped-regex limits of the default validator. Keep the subpath import separate from browser package editing code.

### Test before contributing

Record what actually passed and any provider prerequisites that prevented validation:

- Fresh installation, required-field errors, connect, a small read, and an authorized write against disposable data where applicable.
- A second account with a distinct provider identity; independent credentials, tool settings, and Bot grants after account switching and renaming.
- Disconnect/reconnect, reauthorization, cancellation, token refresh where supported, and recovery from an unreachable endpoint or stopped process.
- Enabled/disabled tools, allow/ask/deny behavior, and workspace restrictions during actual Bot calls.
- Skills and supporting files available to the intended Bots; packaged executable and assets present on the Bot computer.
- Reloaded draft, reviewed package update, changed setup requirements, previous-version restore, and removal.
- ZIP export/import round trip with no account values or secrets included.

Use a configured inference provider for the Bot conversation checks. A successful settings-screen tool test does not cover model-driven tool selection or the conversation approval flow. Keep connector tests alongside its implementation; shared SDK/runtime behavior belongs in the existing SDK/server/computer test suites.

## Contributing to the repository

Add or update `packages/plugins/<plugin-name>/` and open a pull request. You can export from **Develop**, unpack in your graphical file manager, and contribute through your editor or GitHub's web UI. The same package structure applies to every author.

Include a README with setup, required permissions, tool coverage, account support, known limitations, and validation results. Keep provider-specific implementation and dependencies in that package. A typical integration contribution should not need edits to the app's screens or a provider-specific server import.

[Package discovery](../packages/plugins/scripts/generate.ts) finds package directories, imports their files, validates the catalog, and generates `_generated/registry.json` during the server build. Do not hand-edit the generated registry. Shared validation is used by both the UI and repository tooling.

| Location | Responsibility |
| --- | --- |
| [`packages/plugins/`](../packages/plugins/) | Individual packages and generated catalog |
| [`packages/plugin-sdk/`](../packages/plugin-sdk/) | Portable definitions, validation, import/export, templates, identities, and policy helpers |
| [`apps/server/src/services/plugin/`](../apps/server/src/services/plugin/) | Installation snapshots, configuration, accounts, grants, invocation, and package management |
| [`apps/server/src/plugins/`](../apps/server/src/plugins/) | HTTP MCP sessions and shared HTTP/packaged OAuth lifecycle |
| [`apps/computer/src/plugin-package-cache.ts`](../apps/computer/src/plugin-package-cache.ts) | Materialization of executable package files on the Bot computer |
| [`apps/computer/src/mcp-manager.ts`](../apps/computer/src/mcp-manager.ts) | Packaged/local MCP process lifecycle |
| [`packages/contracts/src/plugin-management.ts`](../packages/contracts/src/plugin-management.ts) | Shared management API contracts used by clients |

For source distribution, **Sources** accepts a catalog document containing a `plugins` array of definitions; use the [marketplace parser](../apps/server/src/plugins/catalog.ts) as the format reference. A catalog URL and a single-package import URL serve different purposes.

### Import compatibility

The importer accepts OpenTeam `plugin.json` packages and supported agent/Cursor-style packages, including `.cursor-plugin/plugin.json`. It imports supported skills, MCP declarations, and configuration variables. The preview reports unsupported hooks, rules, commands, and agents; retaining their files does not execute those features. Review the warnings and validate the imported package before installing it.
