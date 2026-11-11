# google-sheets

This package uses the public Google Sheets API v4 and a bundled MCP server on the Bot computer. It calls `sheets.googleapis.com` only, with the single scope `https://www.googleapis.com/auth/spreadsheets`.

See [Google setup](../../../docs/integrations/google.md) for UI setup, multiple accounts, scopes, and troubleshooting. Provider scopes and OAuth endpoints are declared in `plugin.json`; tools are implemented in `connector/server.ts`, with A1 parsing in `connector/a1.ts`, value rendering and write planning in `connector/values.ts`, and format/chart builders in `connector/format.ts`. Shared protocol and HTTP code lives in `../_shared/google.ts` relative to the package root. Catalog generation bundles the executable as `connector/server.mjs`, including dependencies.

Configure secrets only in the installed account's UI. The connector reads `GOOGLE_ACCESS_TOKEN`; the host handles client credentials, PKCE, refresh tokens, and account isolation. Connected tools run directly. Provider errors are returned as MCP tool errors.

The 32 tools match the definitions pinned in `../_shared/reference/sheets.json`, plus `read_result`. The bundled skill in `skills/google-sheets/` is written against those definitions. Its text comes from `cursor/plugins` under the MIT license in `LICENSE`.

- Value tools (`read_range`, `write_range`, `append_rows`, `clear_range`) take a tab title and A1 cells: single cells, ranges, whole columns (`A:C`), whole rows (`2:5`) and open-ended ranges (`A5:A`). Structure and format tools take the numeric `sheetId`. `get_spreadsheet` returns both, along with charts, protections and named ranges. It does not return cell data.
- `read_range` returns each range as CSV. Values are formatted by default. `maxChars` (default 100,000, maximum 250,000) caps all sections together and cuts only between whole rows. A cut section includes `nextCells` for continuing the read. It has no `nextCells` if a single row is longer than `maxChars`. Raw responses over 16 MB fail with a request for a row window such as `1:2000`.
- Writes store values literally unless `parseInput` is true. Each write is limited to 10,000 cells. In `write_range`, `null` leaves a cell unchanged and `""` clears it. If a `write_range` extends past a tab's grid, the tab grows to fit and the write is retried once. Appends insert rows by default.
- The write tools reject tab titles containing `/` or `\`. Rename the tab with `rename_sheet_tab` first.
- Colors are `#RRGGBB`. Number format types (number, currency, percent, date, time, scientific, text) are inferred from the pattern. Positions for row and column tools are 1-based.
- Sheets has no revision guard, so the last write wins. Deletes and clears cannot be undone through the API. New spreadsheets are created in the account's Drive root. To move one, use the Google Drive plugin.

Large results use temporary, account-scoped `read_result` pages.
