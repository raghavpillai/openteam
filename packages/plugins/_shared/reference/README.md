# Google connector reference

`gmail.json`, `calendar.json` and `drive.json` pin the public `tools/list` responses from:

- https://gmailmcp.googleapis.com/mcp/v1, retrieved September 12, 2026; descriptions and input schemas refreshed October 21, 2026
- https://calendarmcp.googleapis.com/mcp/v1, refreshed October 14, 2026
- https://drivemcp.googleapis.com/mcp/v1, retrieved September 12, 2026

They contain public interface metadata, no credentials or account data. Google provides the definitions; OpenTeam implements the operations against the generally available REST APIs. Reference input names, enums and descriptions are retained, with documented compatibility aliases and local extensions. This does not make the adapters Google's official MCP servers.

The October 21, 2026 Gmail refresh covers the tools the plugin implements, including the newer `update_draft` and `delete_draft`. It was taken from Google's current definitions as a connected client received them, where HTML tags had been stripped from two texts: `htmlBody` keeps only its sentences before the stripped markup, and the attachment `inline` text stays as pinned. Annotations and output schemas still date from September 12. The plugin serves draft texts without the `viewUrl` promise, because Google's draft link format is not known; threads and messages carry Google's Gmail web `viewUrl`.

Reference documentation: https://developers.google.com/workspace/gmail/api/reference/mcp , https://developers.google.com/workspace/calendar/api/v3/reference/mcp , https://developers.google.com/workspace/drive/api/reference/mcp . Google licenses documentation under CC BY 4.0 and code samples under Apache 2.0; see https://developers.google.com/terms/site-policies . Attribution and provenance must accompany exports that embed these definitions. The generate script includes this notice in Google packages.

`drive-files.json` pins the `tools/list` definitions served for the `google-drive` package in [cursor/plugins](https://github.com/cursor/plugins/tree/1e5c90a4b6f249917bd21fe361b3a2a7deb741b8/third_party/google-drive), retrieved October 14, 2026. That package's MIT-licensed skill is bundled unchanged in the Google Drive plugin and is written against these definitions. OpenTeam implements them against the public Drive v3 API and never calls the hosted server. The Google Drive plugin also keeps the `drive.json` tools; where a tool name appears in both files, the `drive-files.json` definition is served and the earlier inputs remain accepted as documented aliases.

Refresh intentionally, review schema/behavior changes, implement them, and run the contract and behavioral tests before changing package versions. Never infer runtime parity from a matching name or input schema alone.

## Docs, Sheets and Slides

`docs.json`, `sheets.json` and `slides.json` pin the `tools/list` definitions served for the `google-docs`, `google-sheets` and `google-slides` packages in [cursor/plugins](https://github.com/cursor/plugins/tree/main/third_party), retrieved October 14, 2026. Each OpenTeam package bundles that package's MIT-licensed skill in its own `skills/` folder, with the license alongside; the skills are written against these tool names and inputs. `readOnlyHint` records whether each tool only reads. OpenTeam implements the operations against the generally available Docs, Sheets and Slides REST APIs; the hosted server those packages point to is never called.

