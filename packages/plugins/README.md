# Plugins

See [Using and developing plugins](../../docs/usage/plugins.md) for account setup, Bot access, provider requirements, package examples, and contribution guidance.

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

Provider behavior tests live in that package's `connector/test/`; shared contract and installation tests live in `test/`. The Google reference snapshots in `_shared/reference/` pin public interfaces for deliberate compatibility review. Check behavior beyond tool names: field defaults, reply MIME, binary integrity, pagination, error handling, account routing and notifications. Calendar's local model includes its license, pinned revision and checksums in `models/`. Installed package exports contain their runtime assets and need no first-run dependency download. Registry exports of source-fetched plugins resolve their pinned source at installation.

Gmail, Calendar and Drive 1.2.0 add the richer Google tool inputs and lossless result paging. Notion includes 14 original upstream workflows fetched at installation. See the [capability and limit details](../../docs/integrations/google.md#what-bots-can-do). Linear, Notion and Slack use their provider's official MCP services with user-owned authorization.

For packaged browser OAuth, declare `oauth.authorizationServer` (`issuer`, `authorizationUrl`, `tokenUrl`), `oauth.registration: "manual"`, and `oauth.accessTokenEnv`. The server performs PKCE authorization and refresh, stores credentials in the user's database, and sends only the access token to the named environment variable. The computer needs no OAuth callback listener, client secret, or refresh token.

## Compatibility and policy

Portable root `plugin.json` and `.cursor-plugin/plugin.json` packages can import
skills, MCP declarations, supported configuration variables, rules, commands,
agents, and supported lifecycle hooks. The Bot's **Instructions and hooks**
setting controls execution of those workflow components. Import warnings identify
unsupported component options; disabled agent permissions are not broadened.

MCP declarations can use `mcp.json`, `.mcp.json`, or an explicit manifest path.
Cursor manifest-relative paths may resolve inside the package but cannot escape
it. Imports with an upstream OAuth client identity require configuration of the
deployment's own application. Packages that omit authentication metadata show
a warning; use the provider's OpenTeam registry package for its configured OAuth
flow, or declare the required authentication method in the plugin definition before installing.

Account IDs define runtime namespaces, so renaming an account does not change routing. Tool enabled state and approval preference are independent. Workspace deny/disabled policy takes precedence over Bot preferences. Required/default packages enable capabilities for Bots but never automatically share private accounts. Updates review changed components and setup; compatible account IDs, credentials, grants and policies survive. Removing a source leaves installed snapshots available.

Repository CI and the UI use `@openteam/plugin-sdk` validation. The SDK is portable and contains no database, provider, app or runtime dependency. Runtime implementation remains in the computer/server adapters; client screens use shared contracts.

## Preserve upstream packages

Provider-owned runtime files remain unchanged under `upstream/`: manifests,
MCP declarations, skills and references, commands, rules, agents, hooks, scripts,
and assets. `upstream.json` pins the repository, commit, file inventory and
SHA-256 hashes. It is build metadata, not an instruction file. Never edit a
vendored file to add host guidance; update the source pin deliberately.

The outer `plugin.json` is OpenTeam's setup overlay: stable package and connection
IDs, authentication, typed fields, and platform requirements. Shared host code
maps tool names, account namespaces, and command invocation. Original OAuth
client identities are retained as source, never adopted as our application.

| Package | Original source | Delivery and host exception |
| --- | --- | --- |
| Slack | `slackapi/slack-skills-plugin` | MIT files bundled unchanged; deployment-owned OAuth app |
| 1Password | `1Password/cursor-plugin` | MIT files bundled unchanged; desktop MCP bridge; desktop mount hook inactive on Bot computer |
| Granola | `granola-inc/granola-cursor-plugin` | Original files fetched and verified on install; no license declared at pin |
| Notion | `makenotion/cursor-notion-plugin` | Original files fetched and verified on install; no license declared at pin |
| Linear | `linear/cursor-plugin` | Original files fetched and verified on install; no license declared at pin; MCP only |
| GitHub | `cursor/plugins/third_party/github` | MIT files bundled unchanged; same provider MCP, account token configured locally |
| Gmail | `cursor/plugins/third_party/gmail` | MIT source retained; public API adapter remains because upstream MCP requires Workspace Developer Preview |
| Google Calendar | `cursor/plugins/third_party/google-calendar` | Same Google Preview exception |
| Google Drive | `cursor/plugins/third_party/google-drive` | Same Google Preview exception |

Source-fetched packages download only from a pinned GitHub commit and verify
every byte before installation or replacement. Installed snapshots include the
resolved originals and work without further source downloads; same-source
updates reuse cached files. Source failures do not replace a working install.
The registry contains metadata rather than independently rewritten workflows.

From `packages/plugins`, use `bun run upstream:check` to verify bundled/reference files locally, or
`bun run upstream:sync` to restore them from their pinned source. The latter
also verifies install-time sources without writing those files into the repo.
After a deliberate revision or inventory change, regenerate the registry and
run the plugin, SDK, runtime, and upgrade tests. Export and filesystem-cache
checks must compare the original bytes, including unknown frontmatter.

To repeat the real-source checks from the repository root, run:

```sh
OPENTEAM_TEST_UPSTREAM_SOURCES=1 bun test ./apps/server/test/plugin/upstream-source.integration.test.ts ./apps/computer/test/runtime/collaboration-plugins.test.ts
```

These checks download and verify originals, compare exported and materialized
bytes, and dispatch upstream commands using a runtime harness. They do not call
live account tools or establish that a model has completed a provider workflow.
