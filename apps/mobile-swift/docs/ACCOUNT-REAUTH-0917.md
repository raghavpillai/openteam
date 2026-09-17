# Account identity and Re-auth — September 17, 2026

Account now displays the stored account name and read-only server/connection details. The sign-in-method row and direct Change server action are removed. Re-auth opens server selection, followed by credentials when the server requires them. Its footer says “Sign in again or change your server.”

The native startup path previously refreshed the account name in memory without saving it back to Keychain. It now persists the validated identity for subsequent offline launches. A missing or whitespace-only response cannot erase an existing name; a revoked session or mismatched account cannot restore it. A migrated installation that has never fetched a name shows “OpenTeam owner” until it connects successfully; the app cannot recover a name that was never stored.

Re-auth opens while offline. It keeps the current session, conversations, drafts and outbox until the candidate server accepts the credentials and returns a valid bootstrap. Cancellation restores the original server. Successful same-account re-auth retains drafts; another server/account loads its own cache. Existing push-device retirement is preserved when changing identity, and a cancelled retirement cannot clear a subsequently rebound session. If the old server has a registered push installation that cannot be retired, the switch reports the existing retirement error and keeps the original account.

Evidence is in `output/swift-account-reauth-0917/`. Core tests cover persisted identity followed by offline restoration, empty-name responses, revoked sessions and account mismatch. UI checks cover offline Account, cancelled re-auth, invalid servers, wrong credentials/retry, same-account drafts, separate server caches, authentication-disabled servers, and light/dark layout. Existing sign-in/session-expiry and notification-retirement checks are included.

Initial simulator attempts were obstructed by a stuck SafariViewService password-save prompt and a SpringBoard XCTest accessibility crash. Only the owned QA simulator was restarted. The tests explicitly dismiss the system password prompt and query native labeled rows through their accessibility elements. Final acceptance: 48 core tests and 10 relevant UI tests pass, with the latest result for each case recorded in `output/swift-account-reauth-0917/validation-summary.json`. Screenshots are collected in `output/swift-account-reauth-0917/review.html`. TestFlight receipts are recorded alongside the release artifacts.

This focused account update does not close the remaining findings in [QA-STATUS-0917.md](QA-STATUS-0917.md).

Release: TestFlight **0.0.1 (14)** is available for Team (Expo), with Apple state `VALID` / `IN_BETA_TESTING` and updated testing notes. Receipt: `output/testflight-native-14/RELEASE.md`.
