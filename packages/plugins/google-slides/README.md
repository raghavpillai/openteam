# google-slides

This package uses the public Google Slides API (`https://slides.googleapis.com/v1`) through a bundled MCP server on the Bot computer. It does not use a hosted or Developer Preview MCP service.

See [Google setup](../../../docs/integrations/google.md) for UI setup, multiple accounts, scopes, and troubleshooting. The only scope is `https://www.googleapis.com/auth/presentations`; the connector calls no other Google API. Tools are implemented in `connector/server.ts` with layout, text-measurement, lint, HTML and contrast modules beside it. Shared protocol and HTTP code lives in `../_shared/google.ts` relative to the package root. Catalog generation bundles the executable as `connector/server.mjs`, including dependencies.

Configure secrets only in the installed account's UI. The connector reads `GOOGLE_ACCESS_TOKEN`; the host handles client credentials, PKCE, refresh tokens, and account isolation. Connected tools run directly. Provider errors are returned as MCP tool errors.

The tool names, descriptions and inputs are pinned in `../_shared/reference/slides.json`, matching the bundled skill in `skills/google-slides/`, whose text comes from `cursor/plugins` under the MIT license in `LICENSE`. The 23 tools plus `read_result` cover:

- Reading: `read_presentation` (slides, element objectIds, tables, groups, speaker notes, layouts, revisionId; `maxChars` cuts on slide boundaries and `nextSlide` resumes), `read_slide_layout` (absolute boxes in points, paint order, fills, text styles, wrapped-height estimates and lints) and `get_slide_thumbnail` (a PNG image item plus its size).
- Building: `create_presentation`, `add_slide` (predefined or deck layouts, title/body placeholders filled in the same batch), `compose_slide` (a layout tree or an HTML/CSS subset with a theme, written in one batch), `insert_grid`, `insert_text_box`, `insert_shape`, `insert_line`, `connect_shapes`, `insert_image` and `insert_table`.
- Editing: `set_shape_text`, `replace_text`, `set_text_style`, `set_table_cell_fill`, `set_slide_background`, `update_element_position`, `move_slide`, `duplicate_object` and `delete_object`.
- `check_contrast` computes WCAG ratios locally without an API call.

Coordinates are points from the slide's top-left (12700 EMU per point); the real page size is read from the presentation. `requiredRevisionId` becomes the batch's `WriteControl`, so a concurrent edit fails the write with nothing applied. Tools that read before writing (`add_slide`, `set_shape_text`, `connect_shapes`, `update_element_position`, and `compose_slide` with `clear`) guard the write with that read's revision when none is given.

Limits and approximations:

- The Slides API exposes no text metrics. Wrapped heights use Arial advance widths with per-family scale factors, single line spacing of about 1.17 em, the paragraph's spacing and indents, and the default 7.2 pt inset. `compose_slide` pads widths by 5% when sizing boxes. Treat `text_overflow` and `textFit` as estimates and confirm with a thumbnail.
- Placeholder text styles and fills are resolved through their layout and master placeholders. Theme colors are reported as `theme` and inherited slide backgrounds as `inherited`; neither is contrast-linted.
- Images are aspect-fitted and centered by Slides inside the requested box. `insert_image` reads the slide back to report the fitted size; `compose_slide` reports the box the image was fitted into.
- Connection sites follow ECMA-376 for rectangles, rounded rectangles, text boxes, diamonds, ellipses and triangles; other shapes use the rectangle's four sites.
- Thumbnails are downloaded from Google's short-lived `googleusercontent.com` link without the OAuth token and are limited to 25 MB.
- `create_presentation` cannot choose a folder; use the Google Drive plugin to move the file.
- Large results return lossless JSON fragments through `read_result` on the same account.
