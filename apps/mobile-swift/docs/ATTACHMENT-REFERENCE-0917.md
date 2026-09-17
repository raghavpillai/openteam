# Files, photos and profile reference — September 17, 2026

Implements attachment set `1EB092A9-F9E2-4006-AABD-15FD6862C878` in the native Swift app. TestFlight target: 0.0.1 (21).

## Implemented

- File cards show the archive/document icon, filename with dim extension, and file size. Both legacy single attachments and current attachment arrays render; valid entries survive malformed neighbors.
- Tapping a file downloads its original bytes through the app API, then opens a sheet with close, filename and native share controls. Quick Look renders supported formats; archives use the reference's unsupported-preview message.
- Tapping a picture opens a black full-screen gallery with fitted rounded image, caption, centered thumbnail strip, paging, pinch zoom and double-tap zoom. Separate occurrences of the same asset remain separate gallery items. Decoded image retention is bounded.
- The gallery menu has working Forward, Share and Save actions. Forward writes to the durable outbox without replacing a conversation's draft. Share exports the original file. Save requests add-only Photos permission and saves the original bytes.
- Profile routines show a red clock, schedule, paused state and chevron. Profile notifications persist through the server. Share as Template exports a portable BotRecipe JSON file containing profile, instructions and routines; it does not publish a public template. Account identifiers, memories and connector credentials are excluded.
- The photo viewer keeps the underlying composer keyboard dismissed. Ordinary attachment captions are retained; filename-only legacy placeholders are hidden.

## Validation

Native simulator: iPhone 16 Pro Max, iOS 26.5. The final `AttachmentReference` suite passed all 6 tests. It covers light/dark file cards, file preview/share, photo paging/zoom, selected-photo forwarding, draft preservation, Photos save/share, retry after download failure, message hold/swipe reply, long formatted Markdown, profile notification persistence and template sharing. The full Swift core suite contains 52 passing tests.

Screenshots and results are retained in `output/swift-attachments-0917/`. The review page pairs all seven supplied references with native captures. Reference content is used only as inert QA fixture data. The image fixture is a crop of the supplied desktop photograph, not a fake app screen. Light appearance is tested functionally; the supplied reference set contains only dark appearance. System menus, grouped form geometry, status indicators, fixture history and scroll positions are not asserted pixel-identical across iOS versions.

The photo viewer was measured against reference 6: its black background is RGB 0; resting glass is approximately RGB 33 versus reference samples of 31–35. Main photo placement and thumbnail size/position were calibrated at the reference aspect ratio. A Photos-library receipt confirms the saved original PNG's SHA-256 equals the downloaded fixture. The actual JSON produced by the template share flow passes the production `parseBotRecipe` parser.

A separate isolated run used current production server code, PostgreSQL, and the real computer gateway over HTTP. No inference worker or external messaging ran. PNG and ZIP upload/download bytes matched SHA-256; attachment-only sends persisted asset IDs, filenames and captions. The temporary database and services were removed afterward. This is backend contract validation, separate from the simulator's fixture-driven UI tests; it is not physical-iPhone acceptance.

## Open backend finding

**Attachment downloads bypass sign-in when the full content hash is known.** With `OPENTEAM_AUTH_MODE=required`, both PNG and ZIP `GET /api/v0/assets/<64-character assetId>` returned HTTP 200 without an Authorization header. `apps/server/src/main.ts` dispatches this route before its session check. The same bytes were returned with and without authentication. Receipt: `output/swift-attachments-0917/live/receipt.json`.

This is existing server behavior, not introduced by the mobile viewer. Content-addressed URLs should not be treated as private authenticated downloads. An authenticated or explicitly signed-link design needs a server change and compatibility checks for web/desktop image loading. It remains open; this UI release does not claim to fix it.

Broader audit items, including physical-device push delivery and removal after desktop reads, remain in [QA status](QA-STATUS-0917.md).
