# TestFlight 0.0.1 (34) — September 21, 2026

Build **0.0.1 (34)** is **VALID / IN_BETA_TESTING** for **Team (Expo)**. Apple state, group membership and saved testing notes were read back at **2026-09-21T15:41:24.364Z**.

- App: OpenTeam, `dev.openbot.mobile`, App Store Connect ID `6807991964`.
- Notification extension: `dev.openbot.mobile.notifications`.
- Source commit: `adbeebdf5c352026b43f5bd562b6f9edd8a93c5b`.
- Apple delivery/build ID: `1ffbfb50-e60c-4c4b-b3b1-b8aee9bab353`.
- IPA SHA-256: `ffeed742ce47dc432726be740527a61df6c293bd6b002a2d9497ad2e224cf9ef`.

## Changes

Restores focused reply pages and nested-thread navigation, composer drafts, widget choices and durable submitted receipts. Refines bot-to-bot exchanges, group speaker presentation, identifier wrapping, Markdown spacing, computer controls and loading placement. Smooths message, widget and thinking transitions while preserving the reader's position. Fixes composer first-tap focus and keyboard jumps with a stable bottom inset.

Adjusts the dark header and composer backdrop fades against the supplied recording, including moving content and multiline drafts. Retains the validated neutral glass tint and the existing light appearance. Includes the recent native OAuth/re-auth recovery changes already on main since build 33.

## Validation

The completed [video fixes](VIDEO-FIXES-0921.md) and [moving-glass validation](GLASS-VALIDATION-0921.md) record the references, selected tests and remaining differences. **95 Core tests and 29 selected UI cases passed**, including keyboard focus/dismissal, edge-back and reply gestures, nested threads, rich Markdown, widget receipts, approvals and 1,000-message scrolling. The final glass source matches that validated pass; this release does not repeat the full simulator suite.

A fresh signed Release archive and export succeeded. Package checks verified both signatures and build numbers, production APNs, HTTP allowance, upgrade Keychain identity, VNC and rich-renderer resources, robot assets, and absence of debug testing/tracing paths. All **97 source/resource inputs** match the pushed source commit and remained unchanged during archiving. Apple validation and upload completed without errors. Temporary signing and upload credentials were cleaned up by the release helpers.

Glass interior highlights still differ slightly from the reference. Physical-iPhone push clearing, microphone interruptions, live-provider acceptance and sustained device frame pacing retain their documented acceptance limits. Existing haptics-isolation and unused-cache-variable compiler warnings did not prevent the archive.

Release receipts and IPA: `output/testflight-native-34/`. Matching-frame review and test evidence: `output/glass-validation-0921/` and `output/video-fixes-0921/`.
