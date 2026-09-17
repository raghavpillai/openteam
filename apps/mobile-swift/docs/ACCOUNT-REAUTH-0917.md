# Account identity and destructive Re-auth — September 17, 2026

Re-auth is red in light and dark mode. Its footer reads “Clear all local data, then sign in again or change your server.” This supersedes build 14's cancellable account-switch flow at the user's request.

Tapping Re-auth stops account activity, removes the saved native and all legacy React Native OpenTeam Keychain entries, clears all account caches, drafts, queued messages, staged/downloaded files, settings, notification ledgers and delivered notifications, then opens the blank server/sign-in flow. Server conversations and the server account are not deleted. Existing iOS notification permission remains managed by the system.

Reset does not require the old server. Push registration retirement is attempted independently; a failed retirement cannot block local cleanup. A cleanup failure leaves a retry marker and keeps the app signed out; the next launch retries cleanup before session migration. Stale draft callbacks and network responses cannot restore the old account. A newly signed-in account gets a fresh notification installation.

The stored name remains available offline until Re-auth is invoked. Welcome, server selection and username/password sign-in use the normal app flow; there is no Cancel route back into the erased session.

## Verification

Final acceptance: **49 core tests and 12 distinct UI tests** (14 executions, including a repeat of the offline reset on the final source). No failures or skipped cases. The real persisted-session test confirms normal restart restoration before Re-auth and a clean sign-in after Re-auth plus relaunch. An isolated iOS Keychain audit additionally verifies deletion of legacy access tokens and dynamic per-server entries, handling string/data account attributes, preserving unrelated key namespaces and safe repeated cleanup. The native-push tests cover registration retry, ordinary retirement and local reset when retirement fails.

Evidence: `output/swift-destructive-reauth-0917/`, including a light/dark visual review, fixture UI results, actual Keychain/relaunch coverage, core persistence tests and a host AppStore audit of offline outbox/attachment erasure. The host audit isolates file storage and substitutes only the iOS legacy-Keychain facade; the simulator persistence test uses the real Keychain and app sandbox.

Live native API validation passes against both `http://100.94.42.50:8787` and `https://office-mac-mini.tail658346.ts.net:10000`. Both require the phone to be on the same Tailscale network. The HTTPS route was repaired by adding a loopback Docker port alongside the existing Tailscale binding. Only the server container was recreated, with its existing image, environment and volumes. Tailscale Serve and the worker/computer/database containers were retained.

This focused update does not close the broader findings in [QA-STATUS-0917.md](QA-STATUS-0917.md). Signed-device push acceptance still requires main-server APNs deployment/configuration.

Release artifacts and TestFlight receipts: `output/testflight-native-16/`.

Reproduce the isolated legacy-Keychain check with `python3 apps/mobile-swift/scripts/audit-legacy-keychain.py --simulator <owned-simulator-UDID> --output output/keychain-reset-check`. It creates and removes a separate audit app and tests only a unique fixture Keychain service. The initial host-Keychain attempt could not access a user Keychain; accepted coverage runs inside iOS with an app identity.

Released as **TestFlight 0.0.1 (16)** for Team (Expo), Apple state `VALID` / `IN_BETA_TESTING`, build ID `342e1f06-724a-43f3-ae79-55cd8c6edc49`. Updated testing notes were read back from Apple. Intermediate build 15 is withdrawn; previous accepted builds remain available.

HTTP correction: the initial live API probes above ran on the Mac. A subsequent native iOS UI check found a transport-policy regression in build 16. [The HTTP follow-up](HTTP-CONNECTION-QA-0917.md) documents the reproduction and build 17 fix; host probes alone did not establish iOS HTTP connectivity.
