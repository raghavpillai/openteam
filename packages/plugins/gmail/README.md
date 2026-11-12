# Gmail

This package uses Google's public API and a bundled MCP server on the Bot computer. It does not use Google's Developer Preview MCP service.

See [Google setup](../../../docs/integrations/google.md) for UI setup, multiple accounts, scopes, and troubleshooting. Provider scopes and OAuth endpoints are declared in `plugin.json`; tools are implemented in `connector/server.ts`. Shared protocol and HTTP code lives in `../_shared/google.ts` relative to the package root. Catalog generation bundles the executable as `connector/server.mjs`, including dependencies.

Configure secrets only in the installed account's UI. The connector reads `GOOGLE_ACCESS_TOKEN`; the host handles client credentials, PKCE, refresh tokens, and account isolation. Connected tools run directly, except sending: a bot puts outgoing mail in a draft card that you can edit, and OpenTeam sends it from this account with the host-only `send_reviewed_email` tool when you press Send (or at once, if you allowed those recipients for that Bot or turned its drafts off). See [Email](../../../docs/integrations/email.md) for how review cards work. Provider errors are returned as MCP tool errors.

The connector provides the published Google tool names pinned in `../_shared/reference/gmail.json`, plus `get_profile`, `search_messages`, and `read_result`. It supports normalized plaintext/HTML reads, metadata-only views, paginated searches/drafts, HTML and multipart reply drafts, binary/inline attachments up to 25 MB combined, and label colors/visibility/nesting. Drafts made with the Gmail draft tools stay unsent. Existing OpenTeam aliases are retained.

Large results use account-scoped, temporary `read_result` pages. Follow `nextOffset` until null without repeating the original operation. Reference schemas and attribution are in `../_shared/reference/`; MIME construction and message decoding stay in this package's `connector/messages.ts`.
