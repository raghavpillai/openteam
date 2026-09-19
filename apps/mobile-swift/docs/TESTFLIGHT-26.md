# TestFlight 0.0.1 (26) — September 19, 2026

Apple accepted the signed native iOS upload with no validation or upload errors. Build **0.0.1 (26)** is **VALID / IN_BETA_TESTING**, and membership in the existing **Team (Expo)** internal group was read back from Apple on September 19 at 19:06:57 UTC. The updated testing notes were also saved and read back successfully.

- App: OpenTeam, `dev.openbot.mobile`, App Store Connect ID `6807991964`.
- Notification extension: `dev.openbot.mobile.notifications`.
- Apple delivery ID: `d6e7b4e6-cc1d-4768-8008-d29a0bf3337a`.
- Available to: the existing **Team (Expo)** internal testing group.
- IPA SHA-256: `adec1c7e3413ffb62c9003531a845dfa007a5b7bd719c0f2a138114c3dc60468`.

## Changes since build 25

The plugin authentication monitor remains attached to a visible status row, so authorization status refreshes correctly. Voice transcription has its own deadline long enough for server processing and cancels when leaving a chat, preventing late responses from changing the saved draft. See [live transcription QA](QA-TRANSCRIPTION-0918.md) and [the broader QA pass](QA-PASS2-0918.md).

## Release verification

- All **60 Swift core tests passed** for this build; the preceding transcription pass completed 40 focused checks, including real speech recognition and durable message sending through the mobile UI.
- Both app and extension signatures, bundle IDs, build numbers, provisioning profiles, and production notification entitlements passed verification.
- HTTP server support, microphone permission text, the existing upgrade Keychain identity, and robot notification artwork are present.
- Debug-only UI, push, haptic, and synthetic speech test switches are absent from the release executable.
- All **74 release input hashes** still matched after archive/export.
- Apple archive validation and upload returned success with no errors.

Receipts and the IPA are in `output/testflight-native-26/`, including `verification.json`, `release-inputs.json`, `core-tests.log`, `apple-check.log`, `apple-upload.log`, `apple-processing.json`, and the final `release-result.json`. Temporary signing credentials and the signing Keychain were removed after export.

This remains an internal migration beta. Physical-device microphone/push acceptance, large-history performance, and the remaining VNC behavior have not been signed off; the testing notes retain those limitations.
