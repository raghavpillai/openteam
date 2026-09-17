# Native iOS QA status — September 17, 2026

This is a triage update, not a rerun or closure of the complete September 16 audit. The native TestFlight app remains a migration beta. Earlier audit tables describe the code at capture time; use the linked follow-ups for fixes made afterward.

The [keyboard background follow-up](KEYBOARD-BACKGROUND-0917.md) fixes black keyboard-corner gaps. Focused native UI checks passed in both themes on chat, sign-in, search, creation and profile screens; all 10 final captures pass the corner-color check.

## Fix first

| Priority | Finding | Current evidence / next fix |
| --- | --- | --- |
| P1 | QA-07: a queued send to a deleted conversation stops unrelated sends | The current `AppStore.flush()` still returns when a pending entry's channel is absent. Isolate that entry, preserve its contents, expose recovery/discard, and continue eligible sends. |
| P1 | QA-09/10: plugin access fails or misrepresents permissions | `loadAccess()` still requests 100 rows against the API's maximum of 60. The Bot access toggle still changes enablement without granting a connected account and can remain on after disabling. Correct pagination and add real per-account access controls. |
| P1 acceptance/deployment | Native push on the main installation | The running `openteam-worker-1` has none of the `OPENTEAM_APNS_*` settings. The current transport requires a signing key, key ID and team ID; TestFlight also requires topic `dev.openbot.mobile`. Deploy compatible server/worker/schema changes, configure APNs, then verify signed-iPhone delivery and background removal after desktop reads. A signed IPA alone does not close this. |

The next group includes thread entry/nested-thread actions and search destinations (QA-03–06), attachment limits/queued previews (QA-11/17), VNC gestures and intermittent right-click (QA-12/18), avatar/group editing (QA-13/14), OAuth return/cancellation and plugin recovery (QA-15/16/19–22).

QA-02 attachment/rich-message gestures and QA-08 notification read cursors were addressed by the [live-server follow-up](LIVE-SERVER-QA.md). The latest-message button and scroll geometry were changed during [haptic validation](HAPTICS-VALIDATION-0916.md); the earlier QA-23 screenshot failure should not be presented as a fresh reproduction without rerunning that exact case. Physical haptic feel and APNs/background acceptance remain separate device checks.

## Local connection

The main server responds at `http://100.94.42.50:8787` from this Mac. Use that address with the phone connected to the same Tailscale network. `/health` returns `ready` for server, database, queue, computer and inference; transcription is configured. `/api/auth/config` returns `required`.

The HTTPS shortcut `https://office-mac-mini.tail658346.ts.net:10000` is now healthy. Its existing proxy targets loopback port 8787; the local installation now publishes that loopback port alongside the original Tailscale binding. Only `openteam-server-1` was recreated, retaining the same image, environment and volumes. Both URLs return ready health and the expected authentication challenge through the actual native API client. Phone connectivity itself still depends on its Tailscale connection. Receipt: `output/swift-destructive-reauth-0917/server-connectivity.json`.

The [live HTTP native-app follow-up](HTTP-CONNECTION-QA-0917.md) found that host API probes had missed an iOS transport-policy conflict. Native builds through 16 blocked HTTP to the Tailscale IP. Build 17 removes the conflicting setting and passes actual iOS UI discovery/authentication-response checks over HTTP and HTTPS. Use build 17 or later for the HTTP address.

## Screens and empty state

Welcome, server setup/validation, username/password sign-in, and the conversation list are implemented native screens. Existing simulator tests were rerun after the UI change: invalid server input, a server with authentication disabled, rejected credentials, retry, and reaching the conversation list all passed (**2 tests, 0 failures**). These tests use isolated HTTP fixtures, not the main owner's credentials. Earlier real-server sign-in evidence is linked above.

The home empty state is now one left-aligned, muted subheadline below the conversation section. The large icon, bold title treatment and extra instructional paragraph are removed. Actual light and dark simulator screenshots were inspected. The product change is confined to `HomeView.swift`; no new test was added for this presentation-only change.

Evidence: [screenshots](../../../output/swift-empty-home-0917/review.html), [sign-in/main results](../../../output/swift-empty-home-0917/SignIn-Main.xcresult), [main-server health receipt](../../../output/swift-empty-home-0917/server-health.json). TestFlight packaging for this change is recorded under `output/testflight-native-13/`.

## Account follow-up

[Account identity and Re-auth](ACCOUNT-REAUTH-0917.md) fixes name persistence for offline startup and replaces the account sign-in metadata/direct server-change editor with a red, destructive Re-auth action that clears all local data offline and returns to server/sign-in. Validation and the TestFlight receipt are retained with that follow-up. This does not change the open priorities above.

## Glass, sections and details follow-up

[The latest visual/navigation review](GLASS-SECTIONS-0917.md) verifies the matching flat background colors, refines dark Liquid Glass, removes the extra mobile Memory management screen, hides Unassigned when there are no sections, adds section long-press actions, and replaces modal chat details with native push navigation. Its focused checks do not close the broader findings above.

## File/photo follow-up — September 17

[Attachment reference implementation and validation](ATTACHMENT-REFERENCE-0917.md) adds native file previews, the photo gallery and Forward/Share/Save, plus profile notification/template actions. The live backend audit also confirms a separate open issue: possession of a full asset hash permits downloading the file without a session even with authentication required. The route runs before the session guard; mobile client authentication does not close this server-side exposure.
