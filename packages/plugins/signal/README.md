# Signal

Connect an existing Signal mobile account as a linked device. OpenTeam installs pinned signal-cli and Java runtimes on the Bot computer, then displays a QR code in account settings. No administrator-installed executable or phone number entry is required.

## Connect

1. Install **Signal** from the marketplace and choose **Connect**. The first connection downloads approximately 180–200 MB of verified runtime archives. Allow a few minutes on a slow network.
2. On the phone with Signal, open **Settings → Linked Devices → Link New Device** and scan the code displayed by OpenTeam. Keep the code private. On mobile, display OpenTeam on a second screen to scan it.
3. Wait for **Connected**. Reconnect after an expired or cancelled code to obtain a new one.
4. Start with a Note to Self test. Connected accounts are available to all bots in this OpenTeam installation.

The computer must remain running and connected to collect new messages. This signal-cli integration does not currently import old phone history. Signal’s official apps offer a separate encrypted history-transfer flow; that flow is not implemented here. Keep Signal on the phone active and remove unused linked devices there.

## Tools

| Tool | Behavior |
| --- | --- |
| `list_contacts` | Read paginated contacts, optionally filtered by recipient. |
| `list_groups` | Read paginated groups, optionally filtered by group ID. |
| `list_messages` | Search collected ordinary messages, with arrival-based cursor pagination. |
| `send_message` | Send text to one recipient, group, or Note to Self. A stable request ID prevents duplicate sends. |
| `read_attachment` | Retrieve a downloaded attachment referenced by a collected message. |

Linking, status, cancellation and removal tools are reserved for account settings and never exposed to bots. Identity verification changes are handled by Signal; the connector does not expose blanket trust or registration tools.

`list_messages` indexes incoming messages and sent-message synchronization from other devices. A message sent by this connector is recorded in its persistent send ledger; it does not necessarily produce a received-message event on the same device. The ledger stores a payload fingerprint and outcome, not the outgoing body. Do not treat absence from the message index as permission to resend.

Reuse the same request ID and content to inspect a send's recorded outcome. An `unknown` outcome can mean Signal accepted the message before the connection failed. Inspect the phone before deliberately sending again with a new ID. Automatic retries never resend uncertain messages.

## Privacy and removal

The message index excludes disappearing and view-once content. Edits and deletion events update the index; tombstones prevent replayed originals from restoring deleted messages. The connector does not backfill history or provide a Signal backup.

Signal cryptographic keys, downloaded files, the local index and the send ledger are stored in a private directory per OpenTeam account on the Bot computer. This is ordinary filesystem and SQLite storage, protected by permissions, not an encrypted database. Logical deletion is not secure erasure of SQLite free pages, WAL, provider files or external backups. Signal-cli can download attachments independently of whether the index retains their references.

Disconnect stops collection and retains account state for reconnection. **Remove account** and uninstall stop the runtime and delete that account's entire private directory. Removal fails visibly if the computer cannot confirm deletion. Also remove **OpenTeam** in Signal's Linked Devices settings to revoke the device on Signal; local deletion cannot guarantee remote revocation while offline. Verified shared runtime downloads contain no account data and remain cached.

## Limits and compatibility

Each MCP response must fit 75,000 encoded characters to remain intact through OpenTeam's result limits. Reduce message page size for long messages. Contacts and groups return bounded pages with `nextOffset`; continue until it is null. Directory changes can affect later pages. Individually oversized directory entries and attachments return a controlled size error; binary streaming and attachment uploads are not implemented.

The manifest declares Linux ARM64, Linux x64 and macOS ARM64 runtimes. See [VALIDATION.md](VALIDATION.md) for platforms and scenarios actually tested. Other platforms fail with an unsupported-runtime error. The shared Bot computer normally runs Linux. Its runtime cache must permit execution; a `noexec` Java temporary directory can prevent native Signal libraries from loading. Native inbox triggers and Signal draft review are not provided by this version.

Signal-cli is an unofficial client and requires frequent updates for Signal server changes. The package pins 0.14.10; runtime updates require a reviewed manifest change with new archive sizes and SHA-256 digests. Inspect [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for sources and licenses.

## Development and validation

Run from the repository root with Bun 1.4.2:

```sh
bun run prepare:plugins
bun test packages/plugins/signal/connector/test
bun test packages/plugin-sdk/src/runtime-assets.test.ts packages/plugin-sdk/src/runtime-asset-definition.test.ts
bun test apps/server/test/plugin/device-link.test.ts apps/computer/test/runtime/managed-account-state.test.ts
bun packages/plugins/signal/connector/test/build.ts
bun packages/plugins/signal/connector/test/managed-smoke.ts
```

The ordinary suite uses synthetic accounts and child processes. Optional real-runtime tests set `SIGNAL_TEST_EXECUTABLE` and `SIGNAL_TEST_JAVA_HOME`; they create empty temporary account directories and never use an existing account. Operator-run `connector/test/live.ts` uses an explicitly selected private account directory; `link` requires a phone scan and `verify` sends one labeled Note to Self message. Live state and evidence belong under ignored `output/`, never in the plugin package.

`managed-smoke.ts` installs or reuses the pinned runtimes and checks two real MCP lifecycles against an empty temporary account, without administrator paths or an existing Signal account. It leaves only the public runtime cache. Set `SIGNAL_RUNTIME_CACHE` to choose that cache; add `--provision` to also obtain and cancel a linking code over the network. The code is never printed or scanned.
