# Plugins

See [Using and developing plugins](../../docs/plugins.md) for account setup, Bot access, provider requirements, package examples, and contribution guidance.

Every plugin belongs in `packages/plugins/<plugin-name>/`. The same structure applies to every author. Most contributions change one directory. `scripts/generate.ts` discovers the directories, runs the shared validator, and builds `_generated/registry.json` automatically during the server build. Do not edit the generated registry or add provider imports to the server.

## Create and test through the app

1. Open **Plugins → Manage plugins → Develop** on desktop, or **Plugins → Manage → Develop** on mobile.
2. Select **Skills**, **Remote MCP**, **Packaged MCP**, or **Hybrid**, then create a package. The packaged examples include a working connector and use the runtime already on the Bot computer.
3. Edit the definition in the app, or load a folder/ZIP from your graphical editor. Loading the same package key updates its draft. The installed version stays pinned until you review and apply an update.
4. Validate and save, then install for testing. In **Installed**, configure each account, connect it, and use **Test tool**. Confirm a test that can modify data. Enable the package and grant the account to a test Bot to verify normal Bot calls and approvals.
5. Test another account, a restart, disabled tools, changed requirements, and removal. Check skills and their supporting files separately from connector authentication.
6. Export the ZIP. Imports and exports retain text and binary assets. Saved account values, headers, environment values, OAuth sessions, grants, and activity are stored separately and are not exported.
7. Use GitHub’s web editor to add the package directory and open a pull request. Include its purpose, provider setup documentation, required scopes, supported account types, and the tests you ran. No OpenBot command-line workflow is needed.

## Package structure

`plugin.json` owns the stable key, version, display metadata, components, connector declarations, typed setup fields, and skills. A skill can specify a `path` and omit its `body`; the importer reads `<path>/SKILL.md`, including name/description frontmatter. Supporting files keep their relative paths.

An executable MCP connector keeps source, tests, assets and dependencies under its own `connector/` directory. Export a standalone entry point or include the files its runtime needs. Use `${PLUGIN_ROOT}` in command arguments and working-directory values to reference installed assets. A local connector runs on the shared Bot computer. UI setup supplies command, JSON argument array, environment and working directory; arguments are never split on spaces. Provider dependencies must not become dependencies of `apps/server`, desktop or mobile.

For remote MCP, declare HTTP(S), authentication (`none`, `token`, or `oauth`), and provider setup instructions. OAuth supports dynamic registration, public clients, and manually configured confidential clients with either Basic or request-body client authentication. Use the callback URL shown for that account. Set `oauth.shareClientCredentials` only when accounts intentionally share a provider application; access/refresh tokens and account headers/environment are never copied.

If a provider requires OAuth authorization extensions, set `configuration.oauthAuthorizationParameters`. The supported parameters are `access_type` and `prompt`; security parameters such as state, callback, and PKCE remain controlled by OpenTeam. The Google packages request `access_type: "offline"` and `prompt: "consent select_account"` to obtain refresh tokens and explicitly choose an account. Configured scopes take precedence over the provider's advertised scope inventory.

`${FIELD_NAME}` substitutes a typed setup value. Declare credential fields with `secret: true`, no default, and use placeholders in the manifest. Configure actual secrets in Installed. Keep, replace and clear are distinct operations. Never include `.env`, credentials files, `node_modules`, or a real token in a contribution.

## Multiple provider accounts

Gmail, Google Calendar, Google Drive, and the other account-based connectors support multiple accounts. In **Manage plugins → Installed**, select a plugin, enter a **New account name** (for example, `work` or `personal`), and choose **Add account**. Select the new account, configure it, authorize it in the browser, and grant it to the Bots that should use it. Each account keeps its own credentials, tools, policies, activity, and Bot grants. Gmail, Calendar, and Drive are separate connectors; authorizing Gmail does not also authorize Calendar or Drive.

The Google packages use public REST APIs through packaged MCP servers. Enable the corresponding Google API, create an OAuth web client, and configure accounts in the UI. No Developer Preview enrollment is needed. Each account has independent tokens and a callback URL registered with the application. See the full guide for Google's Testing-mode refresh-token lifetime and Workspace administrator restrictions.

A package may declare `connector/server.ts`. Catalog generation bundles it as `connector/server.mjs` with its dependencies; the installed/exported package is standalone. Google packages share protocol and HTTP helpers in `_shared/google.ts`, while their tools stay in their own `connector/` directories. Do not put provider-specific dispatch in the server.

Provider behavior tests live in that package's `connector/test/`; shared contract and installation tests live in `test/`. The Google reference snapshots in `_shared/reference/` pin public interfaces for deliberate compatibility review. Check behavior beyond tool names: field defaults, reply MIME, binary integrity, pagination, error handling, account routing and notifications. Calendar's local model includes its license, pinned revision and checksums in `models/`. Exported packages contain their runtime assets and need no first-run dependency download.

Gmail, Calendar and Drive 1.2.0 add the richer Google tool inputs and lossless result paging. Notion 1.1.0 includes 14 independently authored workflows. See the [capability and limit details](../../docs/plugins.md#google-capabilities-and-limits). Linear, Notion and Slack use their provider's official MCP services with user-owned authorization.

For packaged browser OAuth, declare `oauth.authorizationServer` (`issuer`, `authorizationUrl`, `tokenUrl`), `oauth.registration: "manual"`, and `oauth.accessTokenEnv`. The server performs PKCE authorization and refresh, stores credentials in the user's database, and sends only the access token to the named environment variable. The computer needs no OAuth callback listener, client secret, or refresh token.

## Compatibility and policy

Portable root `plugin.json` and `.cursor-plugin/plugin.json` packages can import their skills, MCP declarations and supported configuration variables. The preview identifies unsupported hooks, rules, commands and agents; retaining these files does not execute them.

Account IDs define runtime namespaces, so renaming an account does not change routing. Tool enabled state and approval preference are independent. Workspace deny/disabled policy takes precedence over Bot preferences. Required/default packages enable capabilities for Bots but never automatically share private accounts. Updates review changed components and setup; compatible account IDs, credentials, grants and policies survive. Removing a source leaves installed snapshots available.

Repository CI and the UI use `@openteam/plugin-sdk` validation. The SDK is portable and contains no database, provider, app or runtime dependency. Runtime implementation remains in the computer/server adapters; client screens use shared contracts.
