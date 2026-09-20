# TestFlight 0.0.1 (32) — September 20, 2026

Build **0.0.1 (32)** is **VALID / IN_BETA_TESTING** for **Team (Expo)**. Apple state and group membership were read back at **2026-09-20T05:26:19.938Z**; testing notes were saved and verified.

- App: OpenTeam, `dev.openbot.mobile`, App Store Connect ID `6807991964`.
- Notification extension: `dev.openbot.mobile.notifications`.
- Source commit: `cf04df05fc1c839a627d23de1139fe8f9a4f9004`.
- Apple delivery/build ID: `d59aca2c-2d6b-4375-b714-27f6259105e9`.
- IPA SHA-256: `a07eefc398cc2d00f1dce21d4293a9fddfe8de00f81e172ad2a9073c2d225e01`.

## Changes

Restores persistent per-conversation drafts, contiguous older-context navigation, group speaker identities, read-only bot exchanges, form escalation and detailed receipts, secret metadata/scope, routine-event navigation and reaction counts. Delivery retries remain internal; the user-managed outbox entry is removed. Legacy cloud/template cards remain intentionally unsupported.

Native reusable message cells, bounded row/document caches and coalesced draft writes reduce long-history work. Message presentations belong to the page so cell recycling cannot close media/computer screens. Safe-area hit testing preserves composer taps, and display-synchronized footer following restores smooth thinking-loader expansion/collapse while keeping the final reply above the composer.

## Validation

See [Message parity and performance QA](QA-MESSAGE-PARITY-0920.md) for scope, failures found and corrected, evidence and limits. There are 43 distinct passing selected UI scenarios, 88 Swift Core tests and 14 production-server contract tests. Three authenticated UI scenarios used the current production server, PostgreSQL and a real configured model provider over HTTP. They verified delivery, parent/deduplication readback, relaunch persistence, rich messages, attachments, reactions and hold/swipe behavior.

The simulator's 1,000-message workload improved from 273.457 to 4.709 CPU seconds and 642.85 to 97.08 MB peak app memory. Mixed rich content improved from 16.000 to 5.185 CPU seconds and 298.75 to 117.10 MB. Both meet the unchanged budgets. These are comparative simulator measurements, not physical iPhone FPS; app memory excludes WebKit processes. Frame inspection and exact reference bubble geometry checks cover message/loader motion separately.

Both signatures, release versions, production APNs, HTTP allowance, upgrade Keychain identity, robot assets and absence of simulator test launch paths passed packaging checks. All 92 recorded source/resource inputs remain unchanged; shared notification sources also match the prior verified release and source commit. Apple validation/upload completed without errors. Release scripts removed temporary signing/upload credentials.

The regular server remains reachable at `http://100.94.42.50:8787`. Isolated QA services were stopped. Physical-device display pacing, felt haptics, microphone/camera, real APNs background delivery and external OAuth consent remain separate acceptance checks. This build does not claim blanket app-wide pixel identity.

Release receipts and IPA: `output/testflight-native-32/`. QA screenshots, raw videos, per-frame tracks and side-by-side comparisons: `output/mobile-parity-fixes-0920/`.
