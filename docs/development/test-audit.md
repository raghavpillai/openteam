# Test audit — 2026-10-18

The audit inventoried 640 TypeScript, Swift, and Python automated test files (88,661 lines) under `apps`, `packages`, and `scripts`. Repository-wide scans covered compatibility markers, test bodies, imports, source-text assertions, and duplicate bodies; candidate removals were reviewed against neighboring tests and current implementations. Existing local changes were preserved. Historical copies under ignored research/output directories were excluded.

The cleanup changes 58 test files, deletes 18 of them, and removes 102 test definitions, plus legacy branches within retained tests. Parameterized definitions can represent multiple executed cases. Production code is unchanged.

## Removal decisions

| Category | Removed | Coverage retained |
| --- | --- | --- |
| Old persisted formats | Sidebar section migration, old compaction archives, old-server snapshots, v1 send-journal digests, preview-only iOS caches, old mobile settings, database-only memory migration | Current-format persistence, restart recovery, tamper rejection, account isolation, and compaction lifecycle |
| Historical upgrades | Anthropic OAuth credential migration, old office/agent directory permissions, old Tailscale routes, old web-provider storage/endpoints, historical collaboration-package upgrades and OAuth error-state recovery | Current provider identity isolation, fresh-store cross-UID permissions, current settings, ownership checks, and OAuth recovery/concurrency |
| Legacy inputs | Bare inference model IDs, shortened plugin command/agent aliases, old Drive snippets/create inputs, old Calendar ranges, Plaid `on_success`, singular iOS attachments, old hosted-logo fallback, old summary thinking tags | Canonical inputs, validation, malformed-input rejection, provider request semantics, attachment captions, and unsafe URL rejection |
| Source-text assertions | UI parity/style/wiring snapshots, merge-era guards, implementation-name assertions for loading, Electron, VNC, notifications, and search | Executable unit/integration tests and browser/UI workflows; direct CSP and package configuration assertions remain |
| Duplicate or self-asserting cases | Desktop robot-name normalization, an extra fractional compaction threshold case, a palette assembled inside the test, and old catalog byte lengths computed inside the test | Contract-level avatar normalization, the multi-window compaction boundary matrix, and production prompt-size bounds |

The deleted source-only suites are the desktop account/media, app merge, bot profile, chat performance, composer, durable-delivery wiring, group lifecycle, rich-message, routine UI, settings controls, shared-controller wiring, window chrome, auth UI, A2A animation, and message-motion files, plus the server semantic-merge file. The other two deleted files are `LegacyMobileUpgradeTests.swift` and `collaboration-upgrade.integration.test.ts`.

Tests were not removed just because their names contain “compatibility” or “legacy.” Supported Bun/Electron crypto interoperability, current client/server version negotiation, rejection of obsolete inputs, current non-dreaming memory mode, stale form bindings, and persisted screen assignments still protect active behavior. Similar tests at different execution boundaries were retained when they catch different failures. Real failures were not deleted to make the suite pass.

## Verification

- All 15 workspace test packages outside `@openteam/computer`: 2,233 passed, 170 skipped, zero failures with `bun x turbo run test --filter='!@openteam/computer' --concurrency=2`.
- Changed computer suites: 100 passed, 2 skipped across 9 files.
- All 143 computer test files run in separate Bun processes: 627 passed, 50 skipped, 0 failed; 0 failing file processes.
- Swift core: 119 passed with `swift test -c release`.
- Plaid Hosted Link Python: 15 passed.
- Modified TypeScript files parse successfully; unused-import scan and scoped `git diff --check` pass.

The initial full workspace baseline failed in the unchanged large-file stream-copy test with a localhost connection refusal and later terminated with SIGTRAP in the computer suite. Both implicated files pass together in isolation (5 tests). The full computer-suite rerun reproduces both failures. Running all 143 computer test files in separate Bun processes succeeds, indicating a shared-process/order-dependent issue. That existing runner issue remains unresolved.

Database-, Linux-, browser-, and external-service-gated integration tests retain their existing skip conditions. Native iOS UI and standalone browser/Electron workflows were not executed as part of this cleanup.
