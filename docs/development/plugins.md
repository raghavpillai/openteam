# Build a plugin

Package skills, tools, or both as a plugin to reuse them or share them with others. For instructions only you will use, a [private skill](../usage/skills.md#create-a-skill) is simpler.

## Choose a plugin type

| Type | Contains |
| --- | --- |
| Skills | Instructions and supporting files |
| Remote MCP | A connection to an MCP server over HTTP that your OpenTeam server can reach |
| Packaged MCP | An MCP server that runs on the bots' computer |
| Hybrid skills + packaged MCP | Skills together with a packaged MCP server |

A packaged MCP server must include everything it needs to run. OpenTeam doesn't compile code or install dependencies when it installs a plugin.

## Create a plugin

1. Open **Marketplace**, then choose **Manage → Develop plugins**.
2. Choose a **Plugin type**, then **Create plugin**.
3. In **Package definition**, set a unique key, a name, a version, and a description.
4. Edit the definition, including its skills and files, or use **Load / reload folder** to load them from disk. Then choose **Validate and save**.

Saving a draft doesn't change any installed copy of the plugin.

## Test it

1. Choose **Install for testing**.
2. Open the plugin from **Marketplace** and set up an account if it needs one. Then run a small read with **Test a tool**, on the plugin's page under **Settings → Advanced settings**.
3. Try the real workflow in chat.

Check what happens with missing credentials, service errors, and reconnecting. For tools that change data, test with data you don't mind losing.

Write clear tool descriptions and input schemas, since bots rely on them to pick the right tool. Make it clear when a tool changes data or sends information to an external service.

## Share it

Choose **Export ZIP** to package the plugin. Exports never include connected accounts or credentials, so keep secrets in account setup rather than in plugin files.

To release an update, publish the new package with the same key, and raise the version so people can tell releases apart. When the changed package reaches someone's server, for example as an imported ZIP, they review the changes and choose **Apply reviewed update** on the plugin's page under **Settings → Advanced settings**. Plugins in this repository ship with OpenTeam instead: when a server updates, each installed one moves to the newer version automatically and its connected accounts reconnect. Raise the version, or the change won't be applied. Granola and Notion, which fetch their files when installed, and any plugin replaced by an uploaded package, still need a reviewed update.

To contribute a plugin to the OpenTeam repository, follow the [package guide](../../packages/plugins/README.md).

## Managed runtimes and device linking

Packaged connectors may declare `runtimeAssets` for large native prerequisites. Each named asset has platform-keyed `sources` (`linux-arm64`, `linux-x64`, `darwin-arm64`, etc.), with HTTPS `url`, `sha256`, exact `bytes`, `maxExtractedBytes`, `format` (`tar.gz` or `file`), and a confined relative entry `path`. `executable` sets executable permission. Required assets must exist for the computer platform; `optional: true` permits an asset to be absent when another distribution already bundles it.

The computer downloads pinned bytes before MCP launch, checks the digest and size, extracts safely into a private content-addressed cache, and verifies cached files and executable modes before reuse. Concurrent account connections share downloads; cancelling one account does not cancel other users. Each connector receives `OPENTEAM_RUNTIME_<NAME>` entry-point paths. Declare upstream notices and supported platforms in the plugin package. ZIP exports retain these descriptors; unlike bundled JavaScript dependencies, large managed prerequisites require a first-connection download. Runtime cache contents contain no account state.

Set `persistentState: true` to receive `OPENTEAM_PLUGIN_STATE_DIR`, a private directory scoped to the stable account ID. Disconnect preserves it. Account removal and uninstall delete it after stopping the process; failure to confirm removal is an error. Keep all provider keys, message databases and downloaded account files under this directory. Never place them in package files or the shared runtime cache.

Managed account names use the first 32 hexadecimal SHA-256 characters of the account ID. With the production `/agent-data/plugin-runtimes/accounts` parent, the directory is 69 bytes and a `.send.sock` child is 80 bytes, within Unix socket limits. Existing 64-character directories migrate together via rename before launch. Conflicting old/new directories and symlinks fail closed; offline removal handles both owned paths. Custom cache roots must still leave room for a connector's native socket names.

An update cannot retire a connector with private storage, or switch off its `persistentState` descriptor, while its account rows exist. Uninstall the plugin to clean up those accounts before installing that change. Updates and configuration saves also reject accounts with pending removal; concurrent lifecycle changes invalidate stale saves.

For phone/device approval, declare `deviceLink` with `startTool`, `finishTool`, `statusTool`, `cancelTool`, `removeTool`, and user-facing `instructions`. This requires stdio transport with host-managed authorization (`auth: "none"`). These tools are hidden from bots by their manifest declaration and should also set MCP `_meta["openteam/hostOnly"] = true`.

The start tool returns `{sessionId, qrCodeDataUrl, expiresAt}` (PNG data URL, expiry as epoch milliseconds). The finish tool accepts `{sessionId}`, starts an asynchronous approval waiter and returns promptly. Status returns `{linked, linking, recovering?, authorizationError?}`. `recovering: true` means a previously linked collector is retrying after interruption; the host keeps checking its existing running process and restores ready state when it recovers. This does not provision a new code or restart a stopped process. The cancel tool accepts the matching session ID. Removal stops account use without deleting or deregistering the user's primary provider account. OpenTeam displays the temporary code in account settings, polls for completion, and fences stale results after disconnect, cancellation or account changes. Background checks may resume an existing linked collector; they never provision a fresh linking code.

For rotating QR providers, start additionally returns `sessionExpiresAt` and `challengeGeneration` (a nonnegative safe integer, initially zero). The approval deadline is fixed and at most ten minutes away; `expiresAt` belongs to the current image and must not exceed that deadline. Status must include the same `sessionId` throughout approval, including `linked: true` completion. It can return `challenge: {generation, qrCodeDataUrl, expiresAt}` with a strictly newer generation to replace the image, or `qrCodeDataUrl: null` to invalidate it. Increment the generation for invalidation too. Status cannot extend the session deadline. The public `deviceLink` remains present, with a null image, while an image is expired, consumed or invalidated, so clients continue polling during bootstrap. Keep `linking: true` until the account is fully ready; advertise `linked: true` only when authenticated sync/send can run. Legacy static providers may omit status session IDs; explicit mismatches are always ignored. A dynamic approval cannot complete or mutate through a missing or different session ID.

Challenge replacements use the current account/runtime generation and database revision; stale responses cannot overwrite a newer session or publish it ready. **Get new code** stops the old waiter, advances the runtime generation, clears temporary approval state and starts a fresh session. QR images appear in account settings on desktop and iOS; no bot-driven setup UI is needed. Phone-code fallback requires a separately designed shared input/challenge capability and is not part of this PNG QR contract.

The Signal package is the reference implementation. Its provider-specific code remains in its own directory; the host implements only these generic contracts.
