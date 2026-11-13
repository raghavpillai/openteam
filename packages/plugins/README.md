# Plugins

This directory holds the plugins that ship with OpenTeam. See [Build a plugin](../../docs/development/plugins.md) to create, test and export a plugin in the app, and [Plugins](../../docs/usage/plugins.md) to install one and connect accounts. This page covers the package format and how to contribute a package to this repository.

Every plugin belongs in `packages/plugins/<plugin-name>/`. The same structure applies to every author. Most contributions change one directory. `scripts/generate.ts` discovers the directories, runs the shared validator, and builds `_generated/registry.json` automatically during the server build. The generated registry is ignored by Git. Run `bun run prepare:plugins` from the repository root before invoking individual test files directly; normal build, dev, typecheck, and test scripts generate it automatically. Do not edit the registry or add provider imports to the server.

## Bundled plugins

| Plugin | Connection | What bots can do |
| --- | --- | --- |
| [1Password](1password/README.md) | Skill using the 1Password CLI | Sign in to websites with logins and one-time codes from the vaults you choose |
| [Email](email/README.md) | Packaged MCP over IMAP and SMTP | Search and read mail, reply through review cards, and run routines when mail arrives |
| [GitHub](github/README.md) | Remote MCP, personal access token | Search repositories, inspect code, manage issues, and work with pull requests |
| [Gmail](gmail/README.md) | Packaged MCP, Google OAuth | Search, read, draft, and manage email, and send reviewed drafts |
| [Google Calendar](google-calendar/README.md) | Packaged MCP, Google OAuth | Search events and schedule meetings |
| [Google Docs](google-docs/README.md) | Packaged MCP, Google OAuth | Read, create, and edit documents |
| [Google Drive](google-drive/README.md) | Packaged MCP, Google OAuth | Search, read, create, organize, share, and comment on files |
| [Google Sheets](google-sheets/README.md) | Packaged MCP, Google OAuth | Read, write, and format spreadsheets |
| [Google Slides](google-slides/README.md) | Packaged MCP, Google OAuth | Create, edit, and render presentations |
| [Granola](granola/README.md) | Remote MCP, OAuth | Use meeting notes, decisions, and action items |
| [Linear](linear/README.md) | Remote MCP, OAuth | Find, create, and update issues, projects, and comments |
| [Notion](notion/README.md) | Remote MCP, OAuth | Work with documents, research, meetings, and tasks |
| [OpenStreetMap](openstreetmap/README.md) | Packaged MCP, no account | Find places and nearby spots with hours, plan walking, cycling and driving routes, and show them on maps |
| [Plaid](plaid/README.md) | Skills using the Plaid CLI | Query balances, transactions, recurring payments, investments, and loans |
| [Ramp](ramp/README.md) | Remote MCP, OAuth | Analyze spend, manage expenses and approvals, and run finance workflows |
| [T3 Code](t3-code/README.md) | Remote MCP, OAuth and bundled skills | Start coding work in T3 worktrees, follow results, and continue existing threads |
| [Slack (managed)](slack/README.md) | Remote MCP, your Slack app's OAuth | Search channels, read threads, send messages, and work with canvases |
| [Slack (stealth)](slack-stealth/README.md) | Packaged MCP, browser session | Search, read channels and threads, send messages, and add reactions |

## Create and test through the app

1. On desktop, open **Marketplace**, then choose **Manage → Develop plugins**.
2. Choose a **Plugin type** (**Skills**, **Remote MCP**, **Packaged MCP**, or **Hybrid skills + packaged MCP**), then **Create plugin**. The packaged templates include a working connector that uses the runtime already on the Bot computer.
3. Edit the definition in the app, or load your files with **Load / reload folder** or **Import ZIP or manifest**. Loading the same package key updates its draft. The installed version stays pinned until you review and apply an update.
4. Choose **Validate and save**, then **Install for testing**. Open the plugin from **Marketplace**, connect an account, and run a small read with **Test a tool**, which is on the plugin's page under **Settings → Advanced settings**. Then try a normal Bot call in chat.
5. Test another account (**Add Another Account**), a restart, changed requirements, and removal. Check skills and their supporting files separately from connector authentication.
6. Choose **Export ZIP**. Imports and exports retain text and binary assets. Saved account values, headers, environment values, OAuth sessions and activity are stored separately and are not exported.
7. Use GitHub’s web editor to add the package directory and open a pull request. Include its purpose, provider setup documentation, required scopes, supported account types, and the tests you ran. No OpenTeam command-line workflow is needed.

On iPhone, Settings → **Plugins** → **Plugin workspace** lists drafts under **Packages**. **Import package** loads one from a URL, a ZIP archive or text files, and a draft can be saved, installed or exported from there.

## Package structure

`plugin.json` owns the stable key, version, display metadata, components, connector declarations, typed setup fields, and skills. A skill can specify a `path` and omit its `body`; the importer reads `<path>/SKILL.md`, including name/description frontmatter. Supporting files keep their relative paths.

An executable MCP connector keeps source, tests, assets and dependencies under its own `connector/` directory. Export a standalone entry point or include the files its runtime needs. Use `${PLUGIN_ROOT}` in command arguments and working-directory values to reference installed assets. A local connector runs on the shared Bot computer. UI setup supplies command, JSON argument array, environment and working directory; arguments are never split on spaces. Provider dependencies must not become dependencies of `apps/server`, desktop or mobile.

For remote MCP, declare HTTP(S), authentication (`none`, `token`, or `oauth`), and provider setup instructions. OAuth supports dynamic registration, public clients, and manually configured confidential clients with either Basic or request-body client authentication. Use the callback URL shown for that account. Set `oauth.shareClientCredentials` only when accounts intentionally share a provider application; access/refresh tokens and account headers/environment are never copied.

If a provider requires OAuth authorization extensions, set `configuration.oauthAuthorizationParameters`. The supported parameters are `access_type` and `prompt`; security parameters such as state, callback, and PKCE remain controlled by OpenTeam. The Google packages request `access_type: "offline"` and `prompt: "consent select_account"` to obtain refresh tokens and explicitly choose an account. Configured scopes take precedence over the provider's advertised scope inventory.

`${FIELD_NAME}` substitutes a typed setup value. Declare credential fields with `secret: true`, no default, and use placeholders in the manifest. Enter real secrets in the installed account's settings. Keep, replace and clear are distinct operations. Never include `.env`, credentials files, `node_modules`, or a real token in a contribution.

## Multiple provider accounts

Gmail, Google Calendar, Google Drive, and the other account-based connectors support multiple accounts. On the plugin's page, choose **Add Another Account**, label it (for example, `work` or `personal`), choose **Add Account**, then sign in to the new account. Each account keeps its own credentials, tools and activity. Gmail, Calendar, Drive, Docs, Sheets, and Slides are separate connectors; authorizing one does not authorize the others.

The Google packages use public REST APIs through packaged MCP servers. Enable the corresponding Google API, create an OAuth web client, and configure accounts in the UI. No Developer Preview enrollment is needed. Each account has independent tokens and a callback URL registered with the application. See the [Google guide](../../docs/integrations/google.md) for Google's Testing-mode refresh-token lifetime and Workspace administrator restrictions.

A package may declare `connector/server.ts`. Catalog generation bundles it as `connector/server.mjs` with its dependencies; the installed/exported package is standalone. Google packages share protocol and HTTP helpers in `_shared/google.ts`, while their tools stay in their own `connector/` directories. Do not put provider-specific dispatch in the server.

Provider behavior tests live in that package's `connector/test/`; shared contract and installation tests live in `test/`. The Google reference snapshots in `_shared/reference/` pin public interfaces for deliberate compatibility review. Check behavior beyond tool names: field defaults, reply MIME, binary integrity, pagination, error handling, account routing and notifications. Calendar's local model includes its license, pinned revision and checksums in `models/`. Installed package exports contain bundled JavaScript dependencies. A connector that declares managed native prerequisites downloads their pinned, verified archives on first connection; see the managed-runtime contract in [development documentation](../../docs/development/plugins.md). Registry exports of source-fetched plugins resolve their pinned source at installation.

The Google connectors return large results in lossless pages through `read_result`; see [what bots can do](../../docs/integrations/google.md#what-bots-can-do). GitHub, Granola, Linear, Notion, Ramp and Slack (managed) connect to their provider's official MCP service with your own authorization.

For packaged browser OAuth, declare `oauth.authorizationServer` (`issuer`, `authorizationUrl`, `tokenUrl`), `oauth.registration: "manual"`, and `oauth.accessTokenEnv`. The server performs PKCE authorization and refresh, stores credentials in the user's database, and sends only the access token to the named environment variable. The computer needs no OAuth callback listener, client secret, or refresh token.

## Compatibility

Portable root `plugin.json` and `.cursor-plugin/plugin.json` packages can import skills, MCP declarations, supported configuration variables, rules, commands, agents, and supported lifecycle hooks. Once installed, these components and the plugin's connected accounts are available to all bots. Import warnings identify unsupported component options. An agent that declares its own tool allow or deny list is disabled rather than given broader access.

MCP declarations can use `mcp.json`, `.mcp.json`, or an explicit manifest path.
Cursor manifest-relative paths may resolve inside the package but cannot escape
it. Imports with an upstream OAuth client identity require configuration of the
deployment's own application. Packages that omit authentication metadata show
a warning; use the provider's OpenTeam registry package for its configured OAuth
flow, or declare the required authentication method in the plugin definition before installing.

Account IDs define runtime namespaces, so renaming an account does not change routing. Installed packages provide their tools and runtime components to all bots, and connected tools run directly. A reviewed update lists the changed components and setup; compatible accounts keep their IDs and credentials. Removing a source leaves installed snapshots available.

Repository CI and the UI use `@openteam/plugin-sdk` validation. The SDK is portable and contains no database, provider, app or runtime dependency. Runtime implementation remains in the computer/server adapters; client screens use shared contracts.

## Third-party sources

Each package's `upstream.json` records where its files come from. It is build metadata, not an instruction file.

- Most packages are OpenTeam-authored and declare `"origin": "openteam"` with a short description of any third-party material. Copied MIT-licensed skills or commands go in the package's own `skills/` or `commands/` with the notice in `LICENSE`, as Slack and the Google packages do.
- Ramp pins `ramp-public/skills` to a commit, with a SHA-256 hash for each file it uses. The originals are stored unchanged under `ramp/upstream/`, and registry generation fails if a stored file differs from its hash or isn't in the inventory. Don't edit those files; update the pin deliberately.
- Granola and Notion pin a commit and file hashes but keep no copies here, because those sources declare no license. Installing or updating downloads the originals from the pinned GitHub commit and verifies every byte. A failed download or hash check leaves a working install in place, and installed snapshots run without further downloads.

Pin only provider files the package actually uses. When `plugin.json` already declares the connection and the provider package adds no workflows, don't copy it. The outer `plugin.json` is OpenTeam's setup overlay: stable package and connection IDs, authentication, typed fields, and platform requirements. Shared host code maps tool names, account namespaces, and command invocation. Original OAuth client identities are never adopted as OpenTeam's application.

From `packages/plugins`, `bun run upstream:check` verifies the files stored under `upstream/` against their pins; it skips OpenTeam-authored and install-fetched packages. `bun run upstream:sync` downloads every pinned file from GitHub, verifies it, and rewrites the stored copies; for Granola and Notion it verifies without writing anything. After changing a pin, regenerate the registry and run the plugin, SDK, runtime, and upgrade tests.

To repeat the real-source checks from the repository root, run:

```sh
OPENTEAM_TEST_UPSTREAM_SOURCES=1 bun test ./apps/server/test/plugin/upstream-source.integration.test.ts ./apps/computer/test/runtime/collaboration-plugins.test.ts
```

These checks download and verify originals, compare exported and installed bytes, and run upstream commands in a runtime harness. They don't call live account tools or show that a model completes a provider workflow.
