# Integration capabilities and limits

Use [Connecting accounts](../integrations/accounts.md) for account selection and troubleshooting, [Google](../integrations/google.md) for Cloud application setup, and [Slack](../integrations/slack.md) for workspace application setup. This reference covers scopes, connector behavior, and version-specific migration details.

## Google access requirements

The bundled connectors use Google's public Gmail, Calendar, and Drive APIs. Configure the APIs and OAuth client with the [Google setup guide](../integrations/google.md#configure-google-access); each plugin account needs its own callback and authorization.

### Default scopes

| Plugin | API to enable | Default OAuth scopes |
| --- | --- | --- |
| Gmail | Gmail API | `https://www.googleapis.com/auth/gmail.readonly`, `https://www.googleapis.com/auth/gmail.compose`, `https://www.googleapis.com/auth/gmail.modify` |
| Google Calendar | Google Calendar API | `https://www.googleapis.com/auth/calendar.calendarlist.readonly`, `https://www.googleapis.com/auth/calendar.events.freebusy`, `https://www.googleapis.com/auth/calendar.events.readonly`, `https://www.googleapis.com/auth/calendar.events` |
| Google Drive | Google Drive API | `https://www.googleapis.com/auth/drive.readonly`, `https://www.googleapis.com/auth/drive.file` |

The Google packages request offline access and explicit account selection. Each connection gets its own refresh token; the server refreshes expired access tokens automatically and serializes concurrent refreshes. Google's External/Testing applications normally issue refresh tokens that [expire after seven days](https://developers.google.com/identity/protocols/oauth2#expiration), so ongoing use may require reauthorization or a change to the application's publishing status under Google's verification requirements. Workspace administrators can restrict access independently.

### Google capabilities and limits

The 1.2.0 packages cover the published Google MCP tool inputs using public REST APIs. They also retain the earlier OpenTeam argument aliases. All write and destructive tools default to asking for approval.

| Plugin | Included capabilities |
| --- | --- |
| Gmail | Normalized message/thread reads, plaintext and HTML, metadata-only views, search and pagination, rich unsent drafts and replies, binary/inline attachments, nested labels with colors and visibility, trash and spam operations. Attachments are limited to 25 MB combined per draft. There is no send tool. |
| Google Calendar | Event creation, editing, deletion and RSVP; Google Meet links, attachments, reminders, guest permissions, visibility, recurrence and supported special event types; timezone-aware scheduling with working hours and weekend preferences; keyword and local semantic search. Start-only edits preserve duration. |
| Google Drive | Structured search and snippets, metadata and permission reads, copies, binary/text uploads and downloads, Google format conversion, document text extraction, and comment threads on native Docs, Sheets and Slides. Spreadsheet reads include every tab. Drive's `drive.file` scope limits writes to files accessible to the application under that scope. |

Calendar semantic search uses a bundled [English embedding model](https://huggingface.co/minishlab/potion-base-2M) on the Bot computer. It needs no model key or hosted search service. The first search indexes the selected calendar; later searches synchronize changes. It matches related concepts, but its ranking is not Google's proprietary ranking. Recurring events are indexed as series; use `list_events` for dated occurrences. The index supports up to 100,000 events. Descending event lists require an `endTime` to bound recurrence expansion. Special event types and Meet availability still depend on Google account features. Reference event inputs default to notifying attendees (`ALL`); specify `notificationLevel: "NONE"` when notifications are unwanted. The older nested `event` input retains its previous notification default of `none`.

Drive supports text extraction from native Docs/Sheets/Slides, PDF, DOC/DOCX, XLSX, ODS/ODT/ODP, PPTX, PNG and JPEG. PDF and image extraction require the current Bot computer image, which includes Poppler, Antiword and Tesseract. Image OCR is English; scanned PDFs support up to 25 pages. Native extraction has a 45-second total time budget. Text PDFs use their text layer. Unsupported formats return an explicit flag. Files are limited to 64 MB per operation, and Google's native export limit also applies. Compressed documents have bounded expansion limits. This replaces the old 64 KB inline restriction.

Large Google tool results return a `resultId`, `jsonFragment` and `nextOffset`. Call **read_result** on the same plugin account until `nextOffset` is null, concatenate the fragments in offset order, then parse the JSON. This preserves the result without rerunning a provider operation. Snapshots are stored with restricted file permissions on the Bot computer, separated by account, and readable for up to 24 hours subject to size/count eviction. Expired snapshots are removed on subsequent result access or capture; stopping the computer does not immediately erase its disk. Do not repeat a write merely to retrieve its output. Credentials remain in the deployment database; the connector only receives the current access token and an account identifier.

For an update from 1.1.0 to 1.2.0, choose **Apply reviewed update**, then **Restart / refresh tools** for each account. Existing OAuth credentials and account grants are retained; no new scopes are required. If document extraction reports a missing executable, update the Bot computer image as well.

Upgrading from the older Google MCP packages changes the connector transport. Apply the reviewed update, re-enter the OAuth client secret, and authorize each existing account again. Account IDs and callback URLs remain stable. Earlier versions used Google's official MCP endpoints, which currently require [Workspace Developer Preview enrollment](https://developers.google.com/workspace/preview); successful sign-in and tool discovery there did not guarantee that data calls were permitted.

## Slack application setup

Follow the [Slack guide](../integrations/slack.md). For a direct test, use `slack_search_users` with `{"query":"YOUR-SLACK-EMAIL"}` or `slack_list_user_channels` with `{"types":"public_channel","format":"ids_only","limit":5}`. Inspect provider errors as well as the connection status.

The manifest and package scopes cover Slack's published MCP tools. To limit access, reduce scopes in both places, reauthorize, and disable tools that need the removed permissions. A different workspace may need a separate internal app. Slack permits internal and Marketplace apps to use its MCP server; [unlisted distributed apps are prohibited](https://docs.slack.dev/ai/slack-mcp-server/). No hosted OpenTeam connector or Slack CLI is needed.

## Linear and Notion

Both use the provider's hosted MCP service with dynamic OAuth registration. [Verify the connected identity](../integrations/accounts.md#verify-the-connected-identity) before granting bot access. Notion skills require separate enablement; their inventory and provenance are in the [package README](../../packages/plugins/notion/README.md).

## 1Password setup

The [1Password package README](../../packages/plugins/1password/README.md) covers native setup, authorization, account selection, local mounts, and bridge behavior. The Environments connector returns metadata and variable names, not vault passwords. Mounts belong to the physical computer and are not automatically available in bot containers.

## Granola setup

Follow [Connecting accounts](../integrations/accounts.md#verify-the-connected-identity) for authorization and account checks. For missing meeting notes, check identity and active workspace before plan or sharing permissions.

Granola supplies meeting search, lists, folders, notes, transcripts, and account information according to the connected account's access. It does not expose recording or note editing through this connector. **Basic** accounts have personal notes from the last 30 days and restrictions on some search, folder, and transcript tools. **Business** includes accessible personal and public notes. **Enterprise** administrators control member MCP access under **Settings → Workspace → General → Apps & connectors → MCP access for members**. This package uses ordinary browser OAuth; Enterprise-Managed Authorization through an identity provider is not implemented.

MCP follows the active workspace selected in Granola and only returns notes belonging to that workspace. Adding multiple OpenTeam accounts does not pin workspaces or combine their contents. For missing notes, confirm identity and workspace first, then plan and sharing permissions. “User has not created a Granola account yet” usually indicates a different login email. See [Granola's current access and troubleshooting documentation](https://docs.granola.ai/help-center/sharing/integrations/mcp).

Granola sign-in also follows your identity provider's MFA policy. If Google reports that your sign-in settings do not meet the organization's **2-Step Verification policy**, use an organization-approved second factor or have the workspace administrator resolve your account's enrollment. OpenTeam cannot fix that error by reconnecting the plugin; authorization has not reached Granola yet.

## Troubleshooting

Start with [account troubleshooting](../integrations/accounts.md#troubleshooting). For connector development or less common failures:

| Symptom | Check |
| --- | --- |
| OAuth client rejected | Client ID, saved secret, client type, and token endpoint authentication method |
| MFA or organization SSO required | Complete the provider's verification before retrying OpenTeam authorization |
| Invalid OAuth state | Start a new authorization and complete it within 15 minutes |
| Authorization succeeds but discovery fails | Refresh tools; check endpoint reachability and provider status |
| Tools return errors | Inspect `isError` and the provider message, not just the Connected status |
| Packaged process cannot start | Command, JSON argument array, working directory, bundled files, runtime dependencies, and setup fields on the bot computer |
