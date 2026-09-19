# Native capabilities and unified file transfers

The main-agent runtime exposes the thirteen optional capabilities added in the September 14 parity implementation: `upload_file`, `download_file`, eight Mac Contacts/Messages tools, `ListCredentials`, `GetCredentialProviderStatus`, and `request_cookie_origin_approval`. These are adapters to the captured source-visible tool contracts, not a claim to reproduce xAI's private services.

## Connected-service files

`upload_file` reads bytes from the bot computer and writes to one granted Drive, OneDrive, or Gmail account. `download_file` retrieves bytes into the bot computer. Discover the schemas through `GetDynamicTools`; identify an account by its connection ID to avoid ambiguity.

- Drive downloads original bytes or exports Google Docs, Sheets, Slides and Drawings to DOCX, XLSX, PPTX and PNG. Uploads create files in an exact folder ID or unambiguous existing folder path.
- OneDrive supports file IDs or root-relative paths, ordered upload sessions, and explicit overwrite behavior.
- Gmail downloads an attachment only after checking its membership in the specified message. Uploads append an attachment to an existing draft while preserving its MIME content and thread. Uploading never sends the draft.
- Transfers are bounded to 64 MiB; Gmail draft MIME is bounded to 25 MiB. Account grants, enablement and file-tool policies are checked at execution. Review binds the connection, arguments, file size and SHA-256. Durable receipts prevent automatic replay of uncertain uploads. Bytes and OAuth tokens travel only on authenticated supervisor connections and do not enter model tool results.
- Concurrent OpenTeam edits to the same Gmail draft are serialized across server processes. A second read detects intervening changes. Gmail's API does not offer an atomic compare-and-swap for the complete draft replacement, so concurrent edits in another client can still race the final PUT.

External `SendToUser` images/attachments use native Slack uploads or Gmail MIME attachments. The existing account send policies apply, including one-time review. Review binds the target, text, account and actual file hashes; a changed file cannot reuse the review. Other connectors need their own binary delivery adapter. Host-to-box copy tools remain separate.

## Mac Contacts and Messages

The desktop app's authenticated host bridge supplies `FindContacts`, `FindIMessageChats`, `ChatItems`, `SearchIMessages`, `IMessageActivity`, `FetchIMessageAttachment`, `SendIMessage`, and `CheckIMessagePermissions`.

In Computer settings, allow Contacts or Messages access for the requesting bot. macOS may also require Contacts permission, Full Disk Access for Messages history, and Automation permission for Messages. These permissions are independent. Revoking OpenTeam access clears remembered grants and invalidates operations still awaiting review or retrieval.

Contacts results include the Mac's region, normalized E.164 numbers, unresolved numbers, and the total match count. With Contacts permission, history results map known handles to names. Messages pages preserve nanosecond cursors and chronological order within each page. Search examines decoded text across history. Reactions, edits, retractions, group events and attachment metadata are normalized. HEIC attachments are converted to JPEG for viewing.

Messages body recovery supports common text-bearing binary plist and typedstream archives. `body.fallback: true` explicitly marks lossy recovery; this is not a complete Apple rich-message archive decoder. Private macOS schemas and attachment formats can change.

Every send requires a native recipient/body review. Text and addresses are passed as process arguments, never inserted into AppleScript source. A durable receipt prevents repeating a send after an ambiguous result or desktop restart. Local history verification distinguishes submission from verification; neither promises recipient delivery. Automatic SMS fallback occurs only when Messages explicitly reports that the recipient is not registered for iMessage.

## Saved logins

Computer settings → Saved logins connects explicitly selected 1Password accounts and vaults. This is independent of the 1Password Environments plugin. Enable CLI integration in the 1Password desktop app; OpenTeam manages the CLI executable when needed. Only the explicitly configured account/vault is queried.

On macOS, setup prefers a verified system 1Password CLI v2.35 or newer. Otherwise it downloads the pinned vendor release (currently 2.35.0, matching the inspected reference), checks the archive, vendor code signature and reported version, and atomically caches it under the desktop app's private data directory. Both Apple Silicon and Intel are supported. Downloads are bounded, concurrent setup shares an installation, cancellation stops unused downloads, and a failed or damaged cache can be retried. Readiness is checked before setup mutations. Metadata commands have a 30-second deadline and 1 MiB output limit; mutations have a 180-second deadline and service-account tokens are bounded to 16 KiB.

Provisioning runs through a bundled native launcher that verifies the vendor signature again, restricts command arguments to account/vault/service-account setup, scrubs inherited 1Password authentication settings, and denies access to OpenTeam's data store. CLI stderr does not enter UI, tool or conversation output. The launcher is built as part of the desktop app and unpacked outside Electron's archive. A development build requires the macOS command-line build tools. Real desktop/biometric approval still belongs to 1Password.

The selected vault receives a read-only service account through the existing mint-ticket/backend registration flow. Setup supports renewal, cancellation and retrying interrupted registration. Disconnect removes this deployment's access; it does not delete the service account at 1Password. The Environments plugin continues to use the vendor app's own MCP executable, which 1Password installs and updates. Packaged box connectors use the box's bundled Bun runtime; they do not depend on a user-installed host CLI.

Each connection has a database-backed **Always allow** permission, off by default, plus Sync,
item count, last successful sync, expiry and provider error status. Permission changes synchronize
across enrolled desktops and invalidate in-flight fills and older per-item grants. Turning it on
allows approved website matching rules; passive filling still requires one matching login.
Expiry defaults to 90 days in this deployment; the captured Grok client does not establish its
private server default. The seven-day expiring indicator is a local display policy.

Backend calls have a 30-second deadline. A lost or invalid registration response retains the
same private token and ticket in the running desktop process for completion retry, without
minting again. An uncertain mint requires reconciliation in 1Password before restarting.
Explicit permission/approval failures can be retried normally. Settings shows the recovery
action appropriate to the actual setup state and static provider guidance rather than raw stderr.

`ListCredentials` returns metadata, target rules and revision identifiers, never passwords. Domain matching uses the Public Suffix List including private suffixes; exact host/port rules apply to loopback and nonstandard-port URLs. The credential request is `SendToUser` with `type: "credential-request"` and the discovered credential ID, connection ID, catalog revision, current site and purpose.

Review binds the live browser document, exact origin, and actual empty login fields. Navigation, replacement fields, changed credentials, revocation, or conflicting usernames invalidate the fill. The tool fills fields without submitting the form. Connection-wide permission honors provider website rules, including permitted HTTPS subdomains; it does not implicitly allow other ports or unrelated domains. Legacy per-item permissions remain limited to exact origins. Private sessions continue to restrict CDP, including encoded or transformed reads of filled passwords.

Credential values stay on the private bridge/browser path. Browser text results redact known values, private fields are masked in screenshots, and unrestricted CDP inspection is disabled after private data enters the session. This is a concrete handling boundary, not a guarantee against every derived encoding or behavior of a malicious website.

## Chrome login import

`request_cookie_origin_approval` first lists Chrome profile IDs and cookie hosts. Request the exact profile/host pairs to import. Native review identifies every selected profile and site and can remember the bot-specific grants. Computer settings can revoke remembered access.

The adapter reads only selected Mac Chrome cookie databases, obtains Chrome Safe Storage from Keychain after approval, supports the inspected v10 encryption format and v24 host-hash verification, and preserves cookie scope, flags, expiry and partition metadata. Cookie values are delivered privately to the bot browser; the model sees import counts and granted origins. Unknown encryption formats fail explicitly. Chrome on Windows/Linux and other browsers are not implemented by this Mac adapter.

## Verification and setup

Fixtures cover provider protocols, DB policy/replay behavior, Contacts normalization, archived message paging, native consent/revocation, credential matching, and real process output redaction. Run `bun --filter @openteam/desktop test:native:e2e` for the standalone test using native SQLite, an authenticated HTTP host bridge, and a fresh Chrome profile with synthetic credentials/cookies. It checks document replacement, autofill, private cookie import and durable send replay without reading the user's stores or sending a real message.

A deployed update requires the new database schema plus rebuilt server, worker, computer and desktop components. Database tests must use a disposable database. Real account OAuth scopes, real macOS permissions, localized Messages errors and live provider writes require deployment/account acceptance; fixture success does not certify those conditions.
