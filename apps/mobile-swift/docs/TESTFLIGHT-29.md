# TestFlight 0.0.1 (29) — September 19, 2026

Build **0.0.1 (29)** is **VALID / IN_BETA_TESTING** for **Team (Expo)**. Apple state and group membership were verified at September 20, 01:29:58 UTC. Updated testing notes were read back successfully.

- App: OpenTeam, `dev.openbot.mobile`, App Store Connect ID `6807991964`.
- Notification extension: `dev.openbot.mobile.notifications`.
- Source commit: `9ddf7ea`.
- Apple delivery/build ID: `43d01e8f-b761-4aab-b1a3-62da0bf57a4b`.
- IPA SHA-256: `b7bd984d62801ef37a0f2f84cdeeb6c375e1fc6956509f3fe30e6fd015e84334`.

## Change and validation

Opening a conversation now shows a native activity spinner until its initial history is loaded and positioned. The first visible history is already at the latest message. Previously loaded chats reopen immediately while refreshing. See [chat-opening QA](QA-CHAT-OPENING-0920.md).

Three simulator UI tests passed: seven-second delayed history and cached reopening in both appearances; empty-chat readiness and first send; existing keyboard, send, thinking-indicator and scroll-to-latest behavior. Frame analysis recorded zero vertical movement of the latest-message patch in 59 dark and 73 light frames immediately after reveal.

App and extension signatures/build numbers, production APNs, HTTP allowance, upgrade Keychain identity and the absence of debug-only launch switches passed release verification. All 84 release input hashes remained unchanged through packaging. Apple validation and upload succeeded without errors. Signing and upload credentials were removed from temporary storage by the release tools.

Evidence and IPA: `output/testflight-native-29/`. Simulator captures and recording: `output/chat-open-0920/`. The existing physical-device and production-network acceptance limits remain; this is a focused chat-opening regression pass, not a new full-app QA sign-off.
