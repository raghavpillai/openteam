# TestFlight 0.0.1 (30) — September 19, 2026

Build **0.0.1 (30)** is **VALID / IN_BETA_TESTING** for **Team (Expo)**. Apple state and group membership were verified at 2026-09-20T02:10:14.249Z. Updated testing notes were read back successfully.

- App: OpenTeam, `dev.openbot.mobile`, App Store Connect ID `6807991964`.
- Notification extension: `dev.openbot.mobile.notifications`.
- Source commit: `61d6083`.
- Apple delivery/build ID: `01fc4061-0219-4ea7-94ce-33db2ef22904`.
- IPA SHA-256: `e015f62ddef4fd62892deb78dfe1afae5ea8db91c1a7436da8390163f6523c60`.

## Change and validation

The home New conversation + is smaller and the chat attachment + uses a lighter stroke to match the supplied GrokBot reference. Their 44-point touch targets, actions, haptics and materials are preserved. See [plus icon comparison](QA-PLUS-0920.md) for measured before/after sizes and screenshots.

Two existing simulator UI tests passed with zero failures, covering both appearances, home and chat captures, centered headers, composer hit targets, sending and keyboard dismissal. This is a focused icon change, not a new full-app or physical-device QA sign-off.

App and extension signatures/build numbers, production APNs, HTTP allowance, upgrade Keychain identity and the absence of debug-only launch switches passed release verification. All 84 release input hashes remained unchanged through packaging. Apple validation and upload succeeded without errors. Signing and upload credentials were removed from temporary storage by the release tools.

Evidence and IPA: `output/testflight-native-30/`. Simulator captures and the comparison: `output/plus-icon-0920/`. Includes build 29's native history-loading spinner and stable chat-opening position.
