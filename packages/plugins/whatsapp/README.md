# WhatsApp

This packaged MCP connector links a personal WhatsApp account with `wacli` 0.26.0. It includes search/read tools, text and file sends, quoted replies, reactions, message edits, chat state changes, bounded history backfill, and two OpenTeam skills. It uses WhatsApp's unofficial linked-device protocol; it is not a Meta Cloud API integration or an incoming OpenTeam chat channel.

## Connect

Install the plugin, save account settings, and choose Connect. Scan the live QR in OpenTeam account settings using your phone's **Linked devices → Link a device** scanner. QR linking uses the shared desktop/iOS device-link flow; phone-code linking is not exposed. No developer app, Go/Python installation, or API key is required. The computer must run Linux x64 or ARM64 with glibc; both binaries are included and verified before execution. The desktop/iOS app can be used for setup because execution happens on the bot computer.

The native client is configured with the device label **OpenTeam Plugin** and explicit **CHROME** device props, matching its WEB protocol user agent. The upstream DESKTOP default otherwise falls back to the generic other-web-client QR type. Existing links retain their original label; the phone-visible label on a fresh link still needs live verification.

The five manifest-declared lifecycle tools are host-only. `connection_status` remains available to Bots without QR secrets. Each approval has an exact session ID, a fixed deadline of at most ten minutes including bootstrap, and strictly increasing challenge generations. Rotation replaces the image; invalidation or image expiry hides it while polling continues. Get new code uses the host restart barrier to stop the previous approval first. Delayed events cannot revive a cancelled or expired session. A phone error alone does not identify passkey or transport failures; cancel and wait when WhatsApp reports a linking restriction.

OpenTeam publishes ready only after native authentication, the bootstrap-to-sync handoff, a connected sync process, and its real Unix send socket. An interrupted unapproved process does not automatically provision another code. Already linked processes resume sync after restart/update without asking for a QR.

The MCP connection can be available before WhatsApp is paired. Check `connection_status` for actual account authentication and sync state. The initial history arrives from the phone on a best-effort basis. `auth` finishes bootstrap before the connector starts `sync --follow`, because upstream's auth-follow mode does not serve delegated sends. Reads do not take the writer lock or mark chats read. Writes use the running sync connection; uncertain writes are never retried by the wrapper. Backfill serializes against other writes and briefly stops/resumes sync to acquire the store lock.

Each account uses `OPENTEAM_PLUGIN_STATE_DIR` directly for keys, native databases and `.send.sock`. The host scopes it to the stable account ID, preserves it across disconnects/updates, and deletes it on account removal. The production 32-hex directory leaves the socket path at 80 bytes. On first updated startup, the connector atomically renames the complete legacy `~/.local/share/openteam/whatsapp/<24-hex-account-hash>` store into an empty managed root. An active native writer lock, symlinks, ambiguous populated stores, or cross-filesystem rename refuses migration without copying keys. No legacy copy remains after successful migration. If a legacy installation is removed offline before its first updated startup, its old directory needs separate cleanup; the generic host only owns managed state. Portable launches without the managed environment retain the legacy location.

An explicit new pairing after a recorded remote logout archives revoked session files privately before creating new keys; retained history stays in place. The verified executable cache is `~/.cache/openteam/whatsapp/v0.26.0/`. Native reconnect and at most three consecutive wrapper restarts recover unexpected sync failures. Known storage, version, passkey and account-restriction failures do not automatically restart. Disconnect stops native children; reconnect resumes authenticated accounts.

## Account settings

- **Read-only access:** removes send/edit/reaction/chat-change/backfill tools. Account-settings linking, sync, and local media downloads remain available. This is a tool-level mode; syncing still writes the local archive.
- **Attachment folder:** defaults to `/workspace` on the bot computer. Upload paths are resolved and confined to it, with session files excluded. Downloads use generated filenames under `whatsapp/<account-key>/`. Downloads return an absolute local path. Transfer uploads from your own device using OpenTeam file tools first.
- **Maximum stored messages:** 100,000 by default, configurable between 1,000 and 1,000,000. Sync also stops at 512 MB of message database storage. These limits stop ingestion rather than evicting history. They do not cap all downloaded media or session storage.

Add another OpenTeam account for a different WhatsApp number. Account names can change without changing the stored account ID or linked session. Do not point multiple connectors at one manually shared store.

## Skills and provenance

The canonical [OpenClaw WhatsApp skill](https://github.com/openclaw/openclaw/blob/c321c038b59c1e67f4729023b5e680d3c061c9ca/extensions/whatsapp/skills/wacli/SKILL.md) covers contact lookup, search, verification, backfill, and sends. Its original bytes and MIT license are preserved under `upstream/`, pinned and hashed in `upstream.json`. The upstream [wacli repository skill](https://github.com/openclaw/wacli/blob/535a8b969cc83c3aad57f66be77e8fd4a7fcaaa3/.agents/skills/wacli/SKILL.md) was also reviewed; it focuses on repository/store maintenance. The installed OpenTeam skills adapt the useful workflows to account-scoped MCP tools, without the global CLI installation, OpenClaw chat-routing assumptions, or repository release instructions. Existing user authorization governs sends; only unresolved recipient/content ambiguity needs clarification.

Binary release URLs, source revision, archive checksums, and packaged executable checksums are in `connector/release.json`. No executable is downloaded or compiled during installation. See `NOTICE.md` for licenses.

Maintainers can restore and verify those binaries with `python3 packages/plugins/whatsapp/scripts/package-binaries.py`. Run it from the repository root with Bun available; it downloads only the pinned release archives and refuses checksum mismatches. The compressed-byte check also detects a different Brotli compression result, which requires a deliberate manifest review. Brotli keeps both bundled architectures within the current runtime's stricter encoded-file limit as well as the package's decoded-byte limit.

## Limits and removal

Messages describe retained local history, not a complete WhatsApp archive. Cursor reads may be invalidated by live changes. Phone-supplied history, expired attachments, passkey-gated pairing, and delivery receipts have upstream limitations. Successful sends indicate server acceptance rather than recipient delivery. There are no incoming routine triggers, group-administration tools, status broadcasts, automatic replies, or bulk-send workflows in this version.

Text sends to the linked account's own number require explicit `allow_self: true`. WhatsApp can acknowledge them without delivering them, so receipt needs verification on the phone. Use another authorized recipient for outgoing delivery tests. Messages from the phone's official Message Yourself chat can test incoming sync.

Remove the linked device in WhatsApp's Linked devices screen to revoke it remotely. Disconnect preserves managed state. Account removal/uninstall stops the connector and deletes managed keys and retained history; it does not delete the primary WhatsApp account or exported files in the attachment folder. No erasure tool is exposed to Bots.

## Validation

From the repository root, run `bun run prepare:plugins`, then `bun test packages/plugins/whatsapp/connector/test`. The tests cover protocol discovery and calls, account isolation, safe argument construction, read-only tool availability, QR rendering, binary checksums, session/sync transitions, cancellation/shutdown, bounded subprocess output, file confinement, and package export/import. The installed-process test uses an offline provider simulator through the real account adapter, packaged MCP process, managed state and host QR projection. It covers generation changes, bootstrap, stale sessions, cancellation, interrupted-process recovery, changed-package updates and removal. The CI workflow runs on native Linux x64 and ARM64 and includes shared host/database gates. Live linking requires user approval on a phone; do not use ordinary automated tests to send real WhatsApp messages.
