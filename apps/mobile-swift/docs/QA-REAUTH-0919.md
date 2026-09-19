# Re-auth connection regression — September 19, 2026

Tapping Connect after Re-auth could silently do nothing. The server at `http://100.94.42.50:8787` was healthy; both `/health` and `/api/auth/config` responded successfully. Tailscale also reported the phone online and reachable. The app had a separate local-reset failure path that matched the reported behavior.

## Cause and fix

Re-auth sets a persistent marker before clearing local data. If cleanup failed, both server discovery and sign-in returned immediately while that marker remained set. Editing the address cleared the explanatory error. Cleanup also tried to remove system-created sandbox directories themselves, which can be denied even when their contents are writable.

Cleanup now empties those directories while preserving their roots. It still attempts the other files/roots after a failure, reports failure if anything could not be removed, and keeps the marker until every cleanup step succeeds. Connect retries pending cleanup before contacting the server. Cleanup failures remain visible when editing the form or navigating backward; a new session cannot bypass an incomplete wipe.

## Verification

- **63 core tests passed**, including protected sandbox roots, clearing previous accounts and staged attachments, retry after partial failure, hidden files, and symlink targets remaining untouched.
- **Five authentication UI tests passed**: interrupted-reset recovery; offline Re-auth with draft removal and fresh credentials; dark-mode Re-auth on a server without authentication; real Keychain/sandbox reset across relaunch plus two subsequent sign-ins; unreachable, incompatible, and canceled connection attempts.
- **One live HTTP UI test passed** against `http://100.94.42.50:8787`: server health and auth discovery, arrival at sign-in, and an expected authentication rejection for deliberately invalid test credentials. No owner credentials or user data were changed.
- The protected-root test failed with a permission error before the fix. The app regression failed before the fix when it required the username field to become visible and hittable. Checking existence alone had incorrectly accepted an off-screen form; the new regression checks usability as well.
- Before/after screenshots were inspected: the interrupted-reset case now reaches the visible sign-in form, and a cold launch after Re-auth has an empty server field and no restored account.

Evidence is in `output/reauth-recovery-0919/`: `Failure.xcresult`, `Fixed.xcresult`, `LiveHTTP.xcresult`, the core logs, and exported screenshots. The simulator-only interrupted-reset switch is excluded from device Release builds and is checked absent from the exported IPA.

The app tests ran on a dedicated iPhone simulator. This verifies the reported state transition and live server response; it does not claim a connection was exercised directly on the user's physical phone.
