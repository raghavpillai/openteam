# TestFlight 0.0.1 (27) — September 19, 2026

Build **0.0.1 (27)** is **VALID / IN_BETA_TESTING** in the existing **Team (Expo)** internal testing group. Apple group membership and updated testing notes were read back successfully; the final status check was September 19 at 21:58:32 UTC.

- App: OpenTeam, `dev.openbot.mobile`, App Store Connect ID `6807991964`.
- Notification extension: `dev.openbot.mobile.notifications`.
- Apple delivery/build ID: `547a2fb2-60ae-40aa-980a-6fa2b40311af`.
- Source fix: `8ad47f9`.
- IPA SHA-256: `51cf19c089927e7b6eacb82dc307fc885921023db771c5270d176f8db2e7e11e`.

## Changes since build 26

Connect now recovers from unfinished Re-auth cleanup instead of silently returning. Cleanup preserves sandbox roots, clears their contents, and keeps a visible retry error if any step fails. A new session remains blocked until local cleanup succeeds. Updating an installation with a pending reset also retries cleanup at launch. See [the regression and live HTTP QA report](QA-REAUTH-0919.md).

The sign-in tagline is now “Digital workers that run on your compute and work in your apps.” The redundant mobile server-address label is removed.

## Release verification

- **63 core tests and six focused UI tests passed**, covering interrupted reset, offline Re-auth, dark mode, real Keychain/sandbox cleanup, repeated reconnects, relaunch, connection failures/cancellation, and the live HTTP server.
- The live HTTP test reached sign-in at `http://100.94.42.50:8787` and received the expected response to invalid test credentials. No owner credentials were used.
- App and notification extension signatures, bundle IDs, versions, provisioning profiles, production APNs, upgrade Keychain identity, microphone permission, and HTTP allowance passed verification.
- Debug test switches, including interrupted-reset injection, are absent from the exported Release binary.
- All **74 release input hashes** matched after archive/export and after committing the fix.
- Apple validation and upload succeeded without errors. Temporary signing credentials and the temporary signing Keychain were removed after export.

Receipts and the IPA are in `output/testflight-native-27/`, including `verification.json`, `release-inputs.json`, `qa-result.json`, `apple-check.log`, `apple-upload.log`, `apple-processing.json`, and `release-result.json`.

This focused regression pass does not replace physical-phone acceptance or resolve the previously documented microphone/push, large-history performance, and VNC limitations. The updated TestFlight notes retain those limits.
