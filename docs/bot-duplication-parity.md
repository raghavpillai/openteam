# Bot duplication parity

Verified September 12, 2026 against installed Grok Bot desktop 0.47.0, the supplied Grok iOS screenshots, and the [official bot guide](https://docs.x.ai/grok-bot/bots). Fresh Grok Duplicate actions and OpenBot desktop/native iOS actions were exercised with synthetic bots.

## User-visible behavior

| Detail | Grok reference and OpenBot behavior |
| --- | --- |
| Menu | Duplicate is available on desktop and iOS. Both OpenBot clients use the server duplication endpoint. |
| Name | Trim the source name and append lowercase ` copy`. Duplicating a copy produces ` copy copy`. Repeating the action on the same source creates separate bots with identical names; there is no numeric suffix. |
| Long names | Preserve the entire name, including Unicode. A 100 UTF-16-unit Grok name ending in 🚀 was accepted and duplicated without truncation. OpenBot now preserves long names through API validation, profile editing, and file reconciliation. |
| Gray label | This is the editable profile **title**, not a Duplicate status. `Duplication investigator` is copied unchanged; narrow roster rows truncate its presentation. An empty title stays empty. |
| Profile | Copy title, description, explicit instructions, avatar configuration, and custom image bytes. Each custom avatar belongs to the new bot. Editing the copy leaves the source unchanged. |
| Settings | Retain notification and durable per-bot settings. Make the new bot visible in the sidebar. |
| Empty chat | Show **No messages yet**, with no greeting or source messages. Leave the roster preview blank. |
| Date | Preserve the original creation timestamp, including the new DM channel. An empty copy displays that date instead of the time Duplicate was clicked. |
| Routines | Copy definitions and enabled/paused state with fresh identities. Exclude execution history and the run ledger. Enabled copies remain enabled. |
| Skills/connections | Keep shared skills and account connections available, copying per-bot enablements and access restrictions. Do not duplicate credentials or invocation history. |
| History/memory | Fresh bot, conversation, runtime context, and DM. No source chat, attachment records, learned local memory, pending work, or group memberships. Shared workspace files remain shared. |

The fresh Grok reference test duplicated an existing local test bot, observed the copied title/image/notification setting, both paused routines, an empty conversation, and the original roster time. A second test renamed the disposable copy to a long Unicode name and duplicated it through the sidebar to verify full-name preservation. The two new Grok test bots were left with their routines paused; no chat messages were sent during this follow-up.

Grok's older cloud-to-local probe lost server-only routines. OpenBot follows the verified local flow and documented routine-copy behavior; it does not reproduce that runtime-specific loss. The original local research is recorded in `output/duplicate-0912/research.md`. This verification does not claim every Grok deployment has identical runtime behavior.

## Changes in this follow-up

- Removed the 80-character bot-name cap and 75-character clone-name truncation. Kept unrelated group/routine name limits.
- Gave a duplicate's DM the source creation date and aligned empty previews and chat wording.
- Added authenticated custom-avatar rendering throughout mobile bot surfaces. Requests use the copy's ID and the current server's session; image revisions invalidate the URL. Shape avatars remain the fallback.
- Made mobile **Reset to default** clear a custom image even when its underlying shape/color already match the default.
- Expanded integration coverage for long Unicode names, repeated/nested copies, original DM dates, and independent edits after reconciliation.

The existing server implementation already copies authoritative configuration transactionally, uses an explicit file allowlist, preserves routine states, skips onboarding, and handles idempotent retries. Those behaviors were rechecked rather than replaced.

## Verification

- **56 tests passed, 596 assertions**, including real PostgreSQL/file-backed duplication, client routing, profile/list parity, and mobile avatar URL/authentication coverage.
- Mobile, desktop, and server TypeScript checks passed after the final edits. Contracts had also passed its focused check.
- Repeated the 56-test suite and mobile/desktop/server typechecks in a clean checkout containing only the duplication changes before committing; all passed.
- Final iOS production bundle export succeeded.
- Used the actual desktop renderer and native iOS simulator menus against an isolated current-source server. Each created a separate copy with the same name, copied title, custom image, original date, two routine states, and empty history.
- Confirmed **No messages yet** in both clients and visually checked the copied image/title/routine rows on iOS. A transient error during concurrent voice-input edits cleared after a clean reload; the final native check passed.
- Used native **Reset to default** on one disposable copy. Only that copy lost its image; the source and sibling kept theirs.

Local logs and database assertions are retained under the ignored `output/duplicate-parity-0912/` directory: `tests-final.log`, `mobile-export-final.log`, `ui-verification.json`, `ui-verification.log`, and `avatar-reset-native.json`.

The UI test used synthetic data, an isolated database, and a simulated computer boundary. No model worker or actual scheduled routine was run. Deployment and validation against a physical iPhone were outside this change.

## Reproduce the regression suite

Deploy the current database schema to an isolated test database, then run from the repository root:

```sh
OPENTEAM_TEST_DATABASE_URL='<isolated PostgreSQL URL>' bun test \
  ./apps/server/test/bot-duplication.integration.test.ts \
  ./apps/mobile/test/bot-avatar-source.test.ts \
  ./apps/mobile/test/list-ui-parity.test.ts \
  ./apps/desktop/test/bot-profile-ui-parity.test.ts \
  ./packages/client-core/test/client.test.ts
```

Use the explicit `./` paths so Bun does not discover copied test files under ignored QA output directories.
