# google-docs

This package uses Google's public Docs API v1 (`https://docs.googleapis.com`) and a bundled MCP server on the Bot computer.

See [Google setup](../../../docs/integrations/google.md) for UI setup, multiple accounts, scopes, and troubleshooting. Provider scopes and OAuth endpoints are declared in `plugin.json`; tools are implemented in `connector/server.ts`, with document walking, text search and deletion checks in `connector/structure.ts`. Shared protocol and HTTP code lives in `../_shared/google.ts` relative to the package root. Catalog generation bundles the executable as `connector/server.mjs`, including dependencies.

Configure secrets only in the installed account's UI. The connector reads `GOOGLE_ACCESS_TOKEN`; the host handles client credentials, PKCE, refresh tokens, and account isolation. The only scope is `https://www.googleapis.com/auth/documents`; no Drive API calls are made. Connected tools run directly. Provider errors are returned as MCP tool errors.

The tool names, descriptions and inputs match the pinned definitions in `../_shared/reference/docs.json`, which the bundled `google-docs` skill in `skills/google-docs/` is written against. The skill text comes from `cursor/plugins` under the MIT license in `LICENSE`. There are 17 tools plus `read_result`. `read_document` and `find_text` only read. The other tools write through `documents.batchUpdate`, except `create_document`, which uses `documents.create`.

- Indexes are zero-based UTF-16 code units within one tab, end exclusive. Tools that take `tabId` default to the first tab. `read_document` returns each paragraph's range, named style, list membership (text prefixed with `•`), non-default paragraph format, styled text spans and inline objects. It also returns tables with each cell's content range, headers and footers, the tab inventory and the `revisionId`. Inline objects such as images occupy index positions; their places in the text show as U+FFFC, so text offsets still line up with indexes. `maxChars` counts the serialized elements and cuts on an element boundary.
- `find_text` searches body paragraphs and table cells, never across a cell boundary, and returns up to 20 matches.
- `insert_text` without `index` reads the tab, then appends a plain paragraph in one batchUpdate guarded by the revision it read. List membership, inherited paragraph overrides and character styles are cleared on the new paragraphs. An empty final paragraph is filled instead of left blank. Control and private-use characters that Docs strips on insert are removed first, so `insertedRange` is exact.
- `create_list` resolves `firstItemText`/`lastItemText` from a fresh read. It rejects a first anchor that starts more than one paragraph, removes existing bullets and their indent, then applies the preset. Its result adds the resolved `range`.
- `delete_content` reads the tab and refuses ranges the Docs API would reject: half a surrogate pair, part of a table, row or cell boundary, a segment's or cell's final newline, or the newline before a table or section break.
- `set_header_footer` works on the first tab's default header or footer. It creates the segment when missing and replaces its text otherwise. Text is static; the API cannot insert page-number fields.
- Images must be publicly fetchable PNG, JPEG or GIF URLs. Google fetches them once at insertion.
- A stale `requiredRevisionId` fails the whole write; nothing is applied.

Large results return lossless JSON fragments through `read_result` on the same account. Follow `nextOffset`; never repeat a write to recover output.
