# Native capabilities and unified file transfers

The main-agent runtime exposes the thirteen optional capabilities added in the September 14 parity implementation: `upload_file`, `download_file`, eight Mac Contacts/Messages tools, `ListCredentials`, `GetCredentialProviderStatus`, and `import_chrome_cookies`. These are adapters to the captured source-visible tool contracts, not a claim to reproduce xAI's private services.

## Connected-service files

`upload_file` reads bytes from the bot computer and writes to one granted Google Drive or Gmail account. `download_file` retrieves bytes into the bot computer. Discover the schemas through `GetDynamicTools`; identify an account by its connection ID to avoid ambiguity.

- Drive downloads original bytes or exports Google Docs, Sheets, Slides and Drawings to DOCX, XLSX, PPTX and PNG. Uploads create files in an exact folder ID or unambiguous existing folder path.
- Gmail downloads an attachment only after checking its membership in the specified message. Uploads append an attachment to an existing draft while preserving its MIME content and thread. Uploading never sends the draft.
- Transfers are bounded to 64 MiB; Gmail draft MIME is bounded to 25 MiB. Account grants, enablement and file-tool policies are checked at execution. Credential filling binds the connection, arguments, file size and SHA-256. Durable receipts prevent automatic replay of uncertain uploads. Bytes and OAuth tokens travel only on authenticated supervisor connections and do not enter model tool results.
- Concurrent OpenTeam edits to the same Gmail draft are serialized across server processes. A second read detects intervening changes. Gmail's API does not offer an atomic compare-and-swap for the complete draft replacement, so concurrent edits in another client can still race the final PUT.

External `SendToUser` images/attachments use native Slack uploads or Gmail MIME attachments. The existing account send policies apply, including one-time review. Credential filling binds the target, text, account and actual file hashes; a changed file cannot reuse the review. Other connectors need their own binary delivery adapter. Host-to-box copy tools remain separate. Streaming writes verify the byte count and SHA-256 before replacing the destination; interrupted or altered transfers preserve the previous file.

## Mac Contacts and Messages

The desktop app's authenticated host bridge supplies `FindContacts`, `FindIMessageChats`, `ChatItems`, `SearchIMessages`, `IMessageActivity`, `FetchIMessageAttachment`, `SendIMessage`, and `CheckIMessagePermissions`.

In Computer settings, allow Contacts or Messages access for the requesting bot. macOS may also require Contacts permission, Full Disk Access for Messages history, and Automation permission for Messages. These permissions are independent. Revoking OpenTeam access clears remembered grants and invalidates operations still awaiting review or retrieval.

Contacts results include the Mac's region, normalized E.164 numbers, unresolved numbers, and the total match count. With Contacts permission, history results map known handles to names. Messages pages preserve nanosecond cursors and chronological order within each page. Search examines decoded text across history. Reactions, edits, retractions, group events and attachment metadata are normalized. HEIC attachments are converted to JPEG for viewing.

Messages body recovery supports common text-bearing binary plist and typedstream archives. `body.fallback: true` explicitly marks lossy recovery; this is not a complete Apple rich-message archive decoder. Private macOS schemas and attachment formats can change.

Every send requires a native recipient/body review. Text and addresses are passed as process arguments, never inserted into AppleScript source. A durable receipt prevents repeating a send after an ambiguous result or desktop restart. Local history verification distinguishes submission from verification; neither promises recipient delivery. Automatic SMS fallback occurs only when Messages explicitly reports that the recipient is not registered for iMessage.

## Saved logins

Saved logins are connected and managed only in Marketplace → **Login and Credential Management → 1Password**, using a **manual service-account token**. The marketplace page provides sync, renewal, disconnect, and reconnect controls. On 1Password.com, create a service account, select one or more existing vaults, grant read-only access, then paste the token into OpenTeam. No particular vault name or new vault is required. All vaults selected for the token are connected. No local 1Password app, CLI installation, desktop account discovery, or CLI integration is needed.

The server discovers the vaults accessible to the token and validates that every vault is readable before saving any connection. Each vault has its own connection, sync status and disconnect control. A failure to read any granted vault rejects the entire import without partial registration. The user must select read-only permission when creating the token; the SDK does not expose a permission introspection endpoint here, so the server verifies readable vault scope and only performs reads. Token expiry belongs to the provider; OpenTeam does not invent an expiry date. Renewal reopens token entry, replaces access to the same vault.

Ongoing reads use the backend's 1Password SDK and the scoped service-account token, never the user's local CLI or vault. No OAuth app registration, developer client ID, or shared vendor credential is needed. Users need permission to create service accounts in their own 1Password account.

Tokens are encrypted with AES-256-GCM before database storage, using a domain-separated key derived from the existing `OPENTEAM_AUTH_SECRET` (or `BETTER_AUTH_SECRET`) and authenticated connection IDs. Keep the deployment secret stable when restoring the database; changing it requires reconnecting saved logins. Tokens never appear in connection metadata or model results.

1Password does not permit service-account access to built-in Personal, Private, Employee, or default Shared vaults. Existing custom vaults are supported. Service-account vault permissions are immutable at 1Password: changing the selected vaults requires creating a replacement service account token.

Setup supports cancellation and retrying registration. Disconnect removes this deployment's stored access; it does not delete the service account at 1Password.

Each connection tracks item count, last successful sync, provider status and generation. Renewal and disconnection invalidate in-flight fills. Passive filling requires one matching login.
Backend calls have a 30-second deadline. After a lost registration response, refresh connection metadata or paste the token again; this never creates a new service account in 1Password. Error messages use static guidance rather than raw provider output.

`ListCredentials` returns metadata, target rules and revision identifiers, never passwords. Domain matching uses the Public Suffix List including private suffixes; exact host/port rules apply to loopback and nonstandard-port URLs. The credential request is `SendToUser` with `type: "credential-request"` and the discovered credential ID, connection ID, catalog revision, current site and purpose.

Credential filling binds the live browser document, exact origin, and actual empty login fields. Navigation, replacement fields, changed credentials, revocation, or conflicting usernames invalidate the fill. The tool fills fields without submitting the form. Credential matching honors provider website rules, including permitted HTTPS subdomains; it does not implicitly allow other ports or unrelated domains. Private sessions continue to restrict CDP, including encoded or transformed reads of filled passwords.

Credential values stay on the private bridge/browser path. Browser text results redact known values, private fields are masked in screenshots, and unrestricted CDP inspection is disabled after private data enters the session. This is a concrete handling boundary, not a guarantee against every derived encoding or behavior of a malicious website.

## Chrome login import

`import_chrome_cookies` first lists Chrome profile IDs and cookie hosts. Request the exact profile/host pairs to import. The tool imports the requested profiles and hosts directly.

The adapter reads only selected Mac Chrome cookie databases, obtains Chrome Safe Storage from Keychain using macOS authorization, supports the inspected v10 encryption format and v24 host-hash verification, and preserves cookie scope, flags, expiry and partition metadata. Cookie values are delivered privately to the bot browser; the model sees import counts and granted origins. Unknown encryption formats fail explicitly. Chrome on Windows/Linux and other browsers are not implemented by this Mac adapter.

## Native computer viewer

The Swift viewer receives a continuous JPEG stream through the authenticated server connection. The computer encodes up to 15 frames per second, limits each desktop to three viewers, and stops an encoder when its viewer disconnects. The client bounds frame sizes and retains only the latest complete frame. Pausing or backgrounding closes the stream; reconnecting starts a fresh one. Older servers without the stream endpoint retain the PNG fallback.

Screen status and the human-control lease refresh independently. A healthy video stream cannot hide a failed status request or enable input without the current lease. Returning control, dismissal and backgrounding retain the existing lease-release behavior. This transport is an OpenTeam implementation, not Grok's private screen protocol.

## Verification and setup

Fixtures cover provider protocols, DB policy/replay behavior, Contacts normalization, archived message paging, native consent/revocation, credential matching, and real process output redaction. Run `bun --filter @openteam/desktop test:native:e2e` for the standalone test using native SQLite, an authenticated HTTP host bridge, and a fresh Chrome profile with synthetic credentials/cookies. It checks document replacement, autofill, private cookie import and durable send replay without reading the user's stores or sending a real message.

A deployed update requires the new database schema plus rebuilt server, worker, computer and desktop components. Database tests must use a disposable database. Real account OAuth scopes, real macOS permissions, localized Messages errors and live provider writes require deployment/account acceptance; fixture success does not certify those conditions.
