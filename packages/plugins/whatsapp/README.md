# WhatsApp

This packaged MCP connector links a personal WhatsApp account with `wacli` 0.26.0. It includes search/read tools, text and file sends, quoted replies, reactions, message edits, chat state changes, bounded history backfill, and two OpenTeam skills. It uses WhatsApp's unofficial linked-device protocol; it is not a Meta Cloud API integration or an incoming OpenTeam chat channel.

## Connect

Install the plugin, save account settings, and choose Connect. Ask a Bot to link WhatsApp. Scan its QR in your phone's **Linked devices → Link a device**, or request phone-number pairing and enter the returned code in WhatsApp. No developer app, Go/Python installation, or API key is required. The computer must run Linux x64 or ARM64 with glibc; both binaries are included and verified before execution. The desktop/iOS app can be used for setup because execution happens on the bot computer.

New links identify the device as **OpenTeam Plugin** in WhatsApp. Existing device labels may require unlinking and pairing again to update.

Chat QR images are snapshots. Each challenge includes its generation and timestamps; retrieve `pair_device` again for the current image after expiration or a requested rescan. WhatsApp can respond to a scan by rotating its pairing secret and showing "Check your connection" on the phone. The connector records `qr_secret_rotated` and sets `requires_rescan` so the Bot can retrieve and show the replacement within the same attempt. `connection_status` includes `pairing_running`, a bounded timeline of setup/connection events, QR generation metadata, and the last native exit code. It never includes raw challenge payloads or native log messages. A reconnect invalidates the previous challenge immediately. Unapproved pairing attempts stop after ten minutes. Phone error text alone does not identify a passkey or transport failure.

The MCP connection can be available before WhatsApp is paired. Check `connection_status` for actual account authentication and sync state. The initial history arrives from the phone on a best-effort basis. `auth` finishes bootstrap before the connector starts `sync --follow`, because upstream's auth-follow mode does not serve delegated sends. Reads do not take the writer lock or mark chats read. Writes use the running sync connection; uncertain writes are never retried by the wrapper. Backfill serializes against other writes and briefly stops/resumes sync to acquire the store lock.

Each account ID maps to a separate private directory under `~/.local/share/openteam/whatsapp/`. Device keys and history persist across MCP restarts and package updates and are not included in package exports. An explicit new pairing after a recorded remote logout archives the revoked session files privately within that account directory before creating new device keys; retained message history stays in place. The verified binary is cached under `~/.cache/openteam/whatsapp/v0.26.0/`. Sync is active while the account connector is running, with reconnect handled by wacli and at most three consecutive wrapper restarts for unexpected failures before a successful connection. Known storage, version, passkey, and account-restriction errors do not automatically restart. Stopping/disconnecting the account stops its child processes; reconnect resumes authenticated accounts.

## Account settings

- **Read-only access:** removes send/edit/reaction/chat-change/backfill/logout tools. Pairing, sync, and local media downloads remain available. This is a tool-level mode; syncing still writes the local archive.
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

To revoke access, use `logout_account` or remove the device from WhatsApp's Linked devices screen. Disconnecting/uninstalling the plugin stops its connector but does not revoke the device or delete stored history. Local erasure requires a separate explicit cleanup of the intended account directory and downloaded files; no erasure tool is exposed to Bots.

## Validation

From the repository root, run `bun run prepare:plugins`, then `bun test packages/plugins/whatsapp/connector/test`. The tests cover protocol discovery and calls, account isolation, safe argument construction, read-only tool availability, QR rendering, binary checksums, session/sync transitions, cancellation/shutdown, bounded subprocess output, file confinement, and package export/import. Live linking requires user approval on a phone; do not use ordinary automated tests to send real WhatsApp messages.
