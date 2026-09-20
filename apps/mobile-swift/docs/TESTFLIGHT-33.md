# TestFlight 0.0.1 (33) — September 20, 2026

Build **0.0.1 (33)** is **VALID / IN_BETA_TESTING** for **Team (Expo)**. Apple state, group membership and saved testing notes were read back at **2026-09-20T09:44:23.748Z**.

- App: OpenTeam, `dev.openbot.mobile`, App Store Connect ID `6807991964`.
- Notification extension: `dev.openbot.mobile.notifications`.
- Source commit: `1b7991865f8b0d61594416e7439aff6e32d79d7b`.
- Apple delivery/build ID: `ffdaf198-86df-439c-998a-dc384fbdee72`.
- IPA SHA-256: `1afa88a33cf8ca8000add07cdd951a1bf0b2acb22f0a1921407c0f083d9609c2`.

## Changes

Matches the supplied GrokBot references more closely for dark chat Liquid Glass over content, the top fade, send/back glyphs, blue composer cursor and send-button press feedback. Resting fills and the already-matched attachment plus are preserved. Fixes intermittent first-tap keyboard focus by giving native text taps and the surrounding input padding separate focus targets.

This build also includes the authenticated native VNC viewer migration already committed on main since build 32. Its bundled viewer and license resources are verified in the exported app.

## Validation

[Chat glass and color matching](QA-CHAT-GLASS-0920.md) records sampled values, remaining optical differences, screenshots and the 12 passing targeted simulator scenarios. The four changed app files exactly match that QA pass's source hashes. Checks cover both appearances, repeated first-tap and padding focus, keyboard dismissal, send/activity motion, 44-point controls, scrolled glass, multiline input, settings/creation and file preview/native sharing.

The current Swift Core suite passed **87 tests with zero failures**. The signed Release archive and export succeeded. Both signatures, build numbers, production APNs, HTTP allowance, upgrade Keychain identity, robot assets, VNC assets and absence of debug test paths passed package checks. All **95 source/resource inputs** match the pushed source commit and remained unchanged during archiving. Apple validation and upload completed without errors. Release helpers cleaned up temporary signing and upload credentials.

The native material retains small refraction/rim differences from the reference, documented in the visual report. This release adds no new physical-iPhone, microphone, live-provider, OAuth or background-APNs acceptance claim. Compiler warnings remain in existing haptics isolation and unused cache-variable code; the archive completed successfully.

Release receipts and IPA: `output/testflight-native-33/`. Visual evidence and side-by-side comparisons: `output/glass-match-0920/review/`.
