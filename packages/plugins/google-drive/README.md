# google-drive

This package uses Google's public API and a bundled MCP server on the Bot computer. It does not use Google's Developer Preview MCP service.

See [Using and developing plugins](../../../docs/plugins.md#google-access-requirements) for UI setup, multiple accounts, scopes, and troubleshooting. Provider scopes and OAuth endpoints are declared in `plugin.json`; tools are implemented in `connector/server.ts`. Shared protocol and HTTP code lives in `../_shared/google.ts` relative to the package root. Catalog generation bundles the executable as `connector/server.mjs`, including dependencies.

Configure secrets only in the installed account's UI. The connector reads `GOOGLE_ACCESS_TOKEN`; the host handles client credentials, PKCE, refresh tokens, and account isolation. Read tools default to allow and mutations default to approval. Provider errors are returned as MCP tool errors.

Version 1.2.0 provides all eight published Google tool names plus `read_result`: structured search with content snippets, metadata/permissions, copies, text/binary uploads and downloads, Google format conversion, document extraction and native document comments. Spreadsheet extraction includes all tabs. Uploads above 5 MB use Google's resumable protocol.

Supported text extraction includes native Docs/Sheets/Slides, PDF, DOC/DOCX, XLSX, ODS/ODT/ODP, PPTX, PNG and JPEG. The current computer image includes Poppler, Antiword and Tesseract; update older images to enable PDF/DOC/OCR. OCR is English, scanned PDFs are limited to 25 pages, and text PDFs use the text layer. Native extraction has a 45-second total time budget. Files have a 64 MB operation limit, native exports retain Google's export limit, and compressed archives have extraction bounds. Unsupported formats return an explicit flag.

The former 64 KB inline limit is removed. Large results return lossless JSON fragments through `read_result` on the same account, with temporary snapshots up to 24 hours. Follow `nextOffset`; never repeat a write to recover output. `drive.file` restricts writes to files accessible to the application under that scope.
