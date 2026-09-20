# TestFlight 0.0.1 (31) — September 19, 2026

Build **0.0.1 (31)** is **VALID / IN_BETA_TESTING** for **Team (Expo)**. Apple state and group membership were verified at **2026-09-20T02:40:13.507Z**; testing notes were saved and read back.

- App: OpenTeam, `dev.openbot.mobile`, App Store Connect ID `6807991964`.
- Notification extension: `dev.openbot.mobile.notifications`.
- Source commit: `93a3c6574f00b4994a071e018f93e3ee9ad16d58`.
- Apple delivery/build ID: `90a8450e-793b-4ff2-8ddc-23caada59686`.
- IPA SHA-256: `8e329dc9ff4c2ca362bb480e16f7e2abbbf740b236810cb45fff13e1b087641d`.

## Change and validation

Replaces the custom Settings cards with native grouped SwiftUI list rows and navigation. Account and Plugins now open when tapping blank space or the chevron, not just their labels. The Close symbol is legible in both appearances. See [Settings navigation QA](QA-SETTINGS-NAVIGATION-0920.md).

Five distinct UI cases passed across eight executions, including four coordinate positions per row, both appearances, two iPhone sizes, back/close/reopen, Re-auth, HTTP reconnect and plugin connection recovery. Swift Core had 79 passing tests; RN/shared suites had 407. Before-fix coordinate tests reproduced both reported navigation failures. Final simulator screenshots are in `output/rn-swift-parity-0920/`.

Both bundle signatures, build numbers, production APNs, HTTP allowance, upgrade Keychain identity, robot artwork and absence of debug-only launch paths passed packaging checks. All 84 archived source input hashes stayed unchanged. Apple validation and upload completed without errors. Temporary signing/upload credentials were removed by the release scripts.

The main server's health and auth-config endpoints returned HTTP 200 through both `127.0.0.1:8787` and `100.94.42.50:8787`; authentication is required. This read-only health check is not a new end-to-end live-account QA run.

This remains an internal migration beta. The [current React Native–Swift audit](RN-SWIFT-PARITY-0920.md) records 12 remaining functional differences and separate large-history performance, computer gesture and physical-device acceptance gaps. Build 31 fixes Settings navigation; it does not close those audit findings.

Release receipts and IPA: `output/testflight-native-31/`, including `release-result.json`, `verification.json`, `release-inputs.json`, `apple-status.json` and `distribution.log`.
