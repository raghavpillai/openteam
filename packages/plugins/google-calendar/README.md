# google-calendar

This package uses Google's public API and a bundled MCP server on the Bot computer. It does not use Google's Developer Preview MCP service.

See [Google setup](../../../docs/integrations/google.md) for UI setup, multiple accounts, scopes, and troubleshooting. Provider scopes and OAuth endpoints are declared in `plugin.json`; tools are implemented in `connector/server.ts`. Shared protocol and HTTP code lives in `../_shared/google.ts` relative to the package root. Catalog generation bundles the executable as `connector/server.mjs`, including dependencies.

Configure secrets only in the installed account's UI. The connector reads `GOOGLE_ACCESS_TOKEN`; the host handles client credentials, PKCE, refresh tokens, and account isolation. Read tools default to allow and mutations default to approval. Provider errors are returned as MCP tool errors.

Version 1.2.0 provides all nine published Google tool names plus `read_result`. Event tools include Google Meet, reminders, attachments, attendee/guest controls, recurrence, visibility, RSVP comments and supported special event types. Edits preserve unrelated fields, use the event ETag to detect concurrent changes, and preserve duration when only the start changes. Scheduling handles timezones, daylight-saving transitions, working hours and weekend preferences.

`search_events` uses the bundled, MIT-licensed English model under `models/potion-base-2M/`; see its `PROVENANCE.md`. It indexes up to 100,000 event series and incrementally synchronizes changes, including cancellations. It needs no hosted model key. Ranking differs from Google's proprietary implementation. Use `list_events` for exact filters and recurring occurrences; descending lists require an end time.

Reference inputs default to notifying attendees (`ALL`); use `notificationLevel: "NONE"` deliberately for quiet edits. Legacy nested `event` inputs retain `none`. Google account features govern Meet and special event types. Large results use temporary, account-scoped `read_result` pages.
