# Plugin format and runtime

Start with [Build a plugin](../development/plugins.md) for the app workflow. This reference covers package files, manifests, executable connectors, and repository contributions.

The packaged UI template includes a Bun `greet` server; test it with `{"name":"World"}`. Desktop also supports **Load / reload folder**, ZIP/manifest imports, and URL imports. Loading the same package key updates its draft; a distributable update needs a new version.

## Directory layout

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

## Package icons and marketplace copy

Every bundled package owns its artwork in `assets/`. For a contributed package, add a square PNG, JPEG, or WebP file (192 × 192 pixels recommended, at most 256 KB) and declare its relative path:

```json
"icon": "assets/icon.png"
```

Keep the original vector artwork and its source/license attribution in `assets/icon.svg` and `assets/SOURCES.md` when available. The declared display icon is raster so the same asset works on desktop and native mobile. Icons travel with folder and ZIP imports, installed snapshots, and exports; users do not need a hosted image service or an icon API key. Use **Develop → Load / reload folder** or **Import ZIP or manifest** to import the package with its assets. A bare manifest URL cannot supply a package-relative binary icon; use a folder, repository, or release ZIP that includes it.

The marketplace, installed list, plugin details, and package studio show these icons. Existing installed versions without artwork can use the current catalog's icon without applying a package update. Custom packages without an icon, or with an image that cannot load, receive a puzzle icon. Legacy `logoUrl` images remain supported, but a packaged icon takes precedence and works offline.

Use the provider's recognizable mark for integrations and original artwork for other packages. Write a short, plain description of what the plugin actually does. Keep provider setup requirements in `setup` and contributor details in the README. Do not imply that a package is published by the provider unless it is.

## Manifest example: a skills package

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

The schema and validation live in [SDK types](../../packages/plugin-sdk/src/types.ts) and [manifest validation](../../packages/plugin-sdk/src/manifest.ts). Use the shared importer for packages containing skill files; a raw manifest is not the fully resolved package definition.

## Add an MCP connection

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

## Setup fields and credentials

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

## OAuth configuration

Use the [Linear package](../../packages/plugins/linear/plugin.json) as a dynamic/public OAuth example and the [Gmail package](../../packages/plugins/gmail/plugin.json) as a manually configured Google Desktop client example.

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
| `configuration.oauthCallbackMode` | `desktop` (default in the native app) or `server`; browser-only clients use the server callback |
| `configuration.oauthLoopbackPort` | `0` selects an available desktop port; `1024`–`65535` selects a provider-registered fixed port |

Desktop OAuth uses an HTTP listener bound only to `127.0.0.1` on the user's computer. The authenticated backend start request supplies its exact `/callback` URL. The backend stores that redirect with state, PKCE verifier, connection generation, and the initiating login session; the desktop relays the code through the authenticated callback API. The server exchanges and stores tokens. Public browser callback routes cannot complete desktop attempts. Client registration must support the selected callback; no arbitrary external redirect URLs are accepted.

Only `access_type` and `prompt` are applied from authorization extensions. State, PKCE, callback URL, and client ID remain controlled by the OAuth flow. Google uses `access_type: "offline"` and `prompt: "consent select_account"` to request refresh tokens and account selection, following [Google's OAuth guidance](https://developers.google.com/identity/protocols/oauth2/web-server).

Document provider API enablement, application registration, callback restrictions, required scopes, supported account/workspace types, plan requirements, and any enrollment dependency. Do not assume that dynamic registration is available or that a user has the provider's administrative permissions.

## Tool behavior and approvals

Give every tool a useful description and an accurate JSON input schema. Declare read-only and destructive MCP annotations accurately. For discovered tools, a read-only, non-destructive tool defaults to allow; other tools default to an approval prompt. Static tool definitions use `risk: "read" | "write" | "destructive"` and `defaultDecision: "allow" | "prompt" | "deny"`.

Support paginated tool discovery if the server has more tools than one response can contain. OpenTeam also handles tool-list change notifications. Return provider failures as failures rather than success-shaped text, and keep tokens out of results and logs. Never infer permissions solely from a successful `tools/list` response.

Google compatibility references are pinned in `packages/plugins/_shared/reference/`. When updating them, compare behavior as well as schemas: defaults, pagination, MIME formats, account routing, notifications, and error handling. Bundled model assets need a pinned revision, checksum, license and provenance; installation must not depend on a first-run download. The Google result store demonstrates paging large results without repeating writes. Keep provider features inside the package and reusable transport/result code in `_shared/`.

Use `createToolValidator` from `@openteam/plugin-sdk/json-schema` when validating executable connector inputs. It preserves JSON Schema format validation while handling large base64 `byte` fields without the grouped-regex limits of the default validator. Keep the subpath import separate from browser package editing code.

## Test before contributing

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

[Package discovery](../../packages/plugins/scripts/generate.ts) finds package directories, imports their files, validates the catalog, and generates `_generated/registry.json` during the server build. Do not hand-edit the generated registry. Shared validation is used by both the UI and repository tooling.

| Location | Responsibility |
| --- | --- |
| [`packages/plugins/`](../../packages/plugins) | Individual packages and generated catalog |
| [`packages/plugin-sdk/`](../../packages/plugin-sdk) | Portable definitions, validation, import/export, templates, identities, and policy helpers |
| [`apps/server/src/services/plugin/`](../../apps/server/src/services/plugin) | Installation snapshots, configuration, accounts, grants, invocation, and package management |
| [`apps/server/src/plugins/`](../../apps/server/src/plugins) | HTTP MCP sessions and shared HTTP/packaged OAuth lifecycle |
| [`apps/computer/src/plugin-package-cache.ts`](../../apps/computer/src/plugin-package-cache.ts) | Materialization of executable package files on the Bot computer |
| [`apps/computer/src/mcp-manager.ts`](../../apps/computer/src/mcp-manager.ts) | Packaged/local MCP process lifecycle |
| [`packages/contracts/src/plugin-management.ts`](../../packages/contracts/src/plugin-management.ts) | Shared management API contracts used by clients |

For source distribution, **Sources** accepts a catalog document containing a `plugins` array of definitions; use the [marketplace parser](../../apps/server/src/plugins/catalog.ts) as the format reference. A catalog URL and a single-package import URL serve different purposes.

## Import compatibility

The importer accepts OpenTeam `plugin.json` packages and supported agent/Cursor-style packages, including `.cursor-plugin/plugin.json`. It imports supported skills, MCP declarations, and configuration variables. Enabled packages now execute agent lifecycle hooks and load rules, commands and agent templates. In Bot access, **Instructions and hooks** controls these components along with skills. Disabled packages and bots without that enablement contribute no runtime components. Package cache revisions pin the installed files used for a turn.

Command hooks run as the bot computer's unprivileged execution identity with sanitized environment variables, JSON stdin/stdout, a timeout and a 64 KiB output limit. Exit 2 or an explicit deny blocks a pre-action hook; ask uses the existing review flow; other command failures follow the documented fail-open hook behavior and produce a diagnostic. Prompt hooks use the configured inference provider, with an optional provider-qualified model override. Tool hooks, prompt submission, session lifecycle, compaction observation, response/thought observations and bounded stop follow-ups are supported. Background subagent completion is observed on its separate run; it is not a synchronous parent `subagentStop` callback.

Rules support always-on, glob and explicit `@plugin:rule` selection. Commands expand `/plugin:command` with `$ARGUMENTS`. Agent templates use Task's `plugin_agent: "plugin:agent"`, with prompt, model, foreground/background defaults and `readonly`. Read-only templates have a restricted tool surface and cannot execute command hooks. Explicit arbitrary tool allow/deny lists are rejected with a preview warning rather than silently ignored. IDE-only Tab/workspace hooks are reported as unsupported. Review import warnings; installed command hooks are executable code inside the bot computer, not merely Markdown.

The parser follows the published [Cursor hook contract](https://cursor.com/docs/hooks). Runtime lifecycle, model names and available tools are adapted to OpenTeam; this does not reproduce Cursor's editor or cloud-agent infrastructure.
