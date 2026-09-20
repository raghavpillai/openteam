# TestFlight 0.0.1 (28) — September 19, 2026

Build **0.0.1 (28)** is **VALID / IN_BETA_TESTING** in the existing **Team (Expo)** internal testing group. Group membership and updated testing notes were read back from Apple after processing.

- App: OpenTeam, `dev.openbot.mobile`, App Store Connect ID `6807991964`.
- Notification extension: `dev.openbot.mobile.notifications`.
- Apple delivery/build ID: `06640d79-4cdf-4d05-bfbe-d3459a27f83f`.
- Source release commit: `cc185d1` (includes group Computer routing in `99f4dbc`).
- IPA SHA-256: `8c231507e0647bb63a88f042e2c2206093d79f511f6b42a98f84e7946df70424`.

## Changes since build 27

Updated message arrival and thinking-indicator animations, keyboard/scroll transitions, message grouping and spacing, glass colors and composer controls. The bot-run Stop button is removed while voice input remains available during runs.

Group avatars now have contour cutouts and `+N` overflow counts. Chat header pills remain centered with short and long names. The group Computer button opens the latest eligible bot responder's desktop, with the first available group member as the fallback before any reply. A new reply does not switch an already-open desktop. See [the group/header/routing QA](QA-GROUP-AVATARS-0920.md), [chat controls](QA-CHAT-CONTROLS-0920.md), and [chat motion](QA-CHAT-MOTION-0919.md).

## Release verification

- All **79 core tests passed**. The two group UI scenarios passed, exercising responder changes, actual bot-specific screen/frame requests, and ten centered-header cases across light and dark mode.
- Release archive/export, app and extension signatures, bundle IDs/build numbers, production APNs, upgrade Keychain identity, permission descriptions, and HTTP allowance passed verification.
- Debug test and robot-lab launch switches are absent from the exported Release binary.
- All **84 release input hashes** remained unchanged through archive/export and upload.
- Apple validation and upload succeeded with no errors. Temporary signing credentials and the temporary signing Keychain were removed after export.
- Apple confirmed the uploaded build is valid, active, and assigned to Team (Expo); updated testing notes were verified by reading them back.

Receipts and the IPA are retained in `output/testflight-native-28/`, including `verification.json`, `release-inputs.json`, `qa-result.json`, `apple-check.log`, `apple-upload.log`, `apple-processing.json`, `verified-apple-status.json`, and `release-result.json`.

This release does not claim a new full-app or physical-iPhone acceptance pass. Group Computer routing was verified against the running local contract fixture. Previously documented physical-device microphone/push acceptance, large-history performance, and VNC device limitations remain in the testing notes.
