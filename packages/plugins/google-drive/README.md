# google-drive

This package uses Google's public API and a bundled MCP server on the Bot computer. It does not use Google's Developer Preview MCP service.

See [Google setup](../../../docs/integrations/google.md) for UI setup, multiple accounts, scopes, and troubleshooting. Provider scopes and OAuth endpoints are declared in `plugin.json`; tools are implemented in `connector/server.ts`. Shared protocol and HTTP code lives in `../_shared/google.ts` relative to the package root. Catalog generation bundles the executable as `connector/server.mjs`, including dependencies.

Configure secrets only in the installed account's UI. The connector reads `GOOGLE_ACCESS_TOKEN`; the host handles client credentials, PKCE, refresh tokens, and account isolation. Connected tools run directly. Provider errors are returned as MCP tool errors.

The connector serves the Drive file tools pinned in `../_shared/reference/drive-files.json`, plus `read_result`:

- Find: `search` with typed filters (exact name, MIME type, folder by ID or name, owner, writer, starred, shared with me, visibility, created and modified dates) and optional text of the top three results; `list_folder`; `list_recent_files`.
- Read: `read_file` returns Docs as Markdown, every Sheets tab as CSV, and Slides and stored text files as text, with a line range and a character cap. `download_file` returns stored bytes up to 10 MB. `export_file` renders Docs, Sheets, Slides and Drawings as PDF, Office, text, Markdown, HTML, CSV, PNG or SVG, up to Google's 10 MB export limit.
- Create and change: `create_folder`; `create_file` from text, optionally converting Markdown into a Google Doc or CSV into a Google Sheet, directly in a folder; `update_file_content`; `move_or_rename` and `update_file`; `copy_file`; `trash_file` (recoverable; there is no permanent delete).
- Access and comments: `get_file_metadata`, `get_file_permissions`, `share_file` (a named user, group or domain; never anyone with the link; no notification email unless requested), `list_comments`, `add_comment` and `reply_to_comment`, which can resolve or reopen a thread.

The package bundles the `google-drive` skill in `skills/google-drive/`; it describes how bots use these tools. Its text comes from `cursor/plugins` under the MIT license in `LICENSE`. The earlier `search_files`, `read_file_content` and `download_file_content` tools remain, and shared tool names still accept their earlier inputs (content snippets, base64 uploads, automatic conversion when those inputs are used).

The scopes are `drive.readonly` and `drive.file`. Bots can read anything the account can see, but `drive.file` limits changes (content replacement, moves, renames, sharing, trashing and comments) to files and folders the connector created or that were opened with this app. Google answers other changes with a 403, which the connector reports as a permission result not to retry.

`read_file_content` extracts text from native Docs/Sheets/Slides, PDF, DOC/DOCX, XLSX, ODS/ODT/ODP, PPTX, PNG and JPEG. The current computer image includes Poppler, Antiword and Tesseract; update older images to enable PDF/DOC/OCR. OCR is English, scanned PDFs are limited to 25 pages, and text PDFs use the text layer. Native extraction has a 45-second total time budget. Files have a 64 MB operation limit, native exports retain Google's export limit, and compressed archives have extraction bounds. Unsupported formats return an explicit flag. Uploads above 5 MB use Google's resumable protocol.

Large results return lossless JSON fragments through `read_result` on the same account, with temporary snapshots up to 24 hours. Follow `nextOffset`; never repeat a write to recover output.
