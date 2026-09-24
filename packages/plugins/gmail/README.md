# Gmail

This package uses Google's public API and a bundled MCP server on the Bot computer. It does not use Google's Developer Preview MCP service.

See [Google setup](../../../docs/integrations/google.md) for UI setup, multiple accounts, scopes, and troubleshooting. Provider scopes and OAuth endpoints are declared in `plugin.json`; tools are implemented in `connector/server.ts`. Shared protocol and HTTP code lives in `../_shared/google.ts` relative to the package root. Catalog generation bundles the executable as `connector/server.mjs`, including dependencies.

Configure secrets only in the installed account's UI. The connector reads `GOOGLE_ACCESS_TOKEN`; the host handles client credentials, PKCE, refresh tokens, and account isolation. Read tools default to allow and mutations default to approval. Provider errors are returned as MCP tool errors.

Version 1.2.0 provides the 23 published Google tool names, `get_profile`, `search_messages`, and `read_result`. It supports normalized plaintext/HTML reads, metadata-only views, paginated searches/drafts, HTML and multipart reply drafts, binary/inline attachments up to 25 MB combined, and label colors/visibility/nesting. Drafts remain unsent. Existing OpenTeam aliases are retained.

Large results use account-scoped, temporary `read_result` pages. Follow `nextOffset` until null without repeating the original operation. Reference schemas and attribution are in `../_shared/reference/`; MIME construction and message decoding stay in this package's `connector/messages.ts`.
