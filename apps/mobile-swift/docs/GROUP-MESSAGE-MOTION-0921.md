# Group chats, exchanges, and message motion — September 21, 2026

This pass uses the supplied September 21 dark recording, with group-chat geometry
measured from a settled frame at 192.35 seconds and the read-only exchange at
120 seconds. Robot artwork is excluded. All new UI runs use an isolated HTTP
fixture and a dedicated iPhone 16 Pro Max / iOS 26.5 simulator.

## Corrections

- **Cold-load unread position:** the old view chose the opening unread boundary
  from the bootstrap preview before history loaded. If only the latest message
  was present, NEW appeared before that message instead of the first unread bot
  reply. The view now freezes the opening read cursor, resolves against loaded
  history, and preserves the boundary while new responses arrive. The new test
  failed before the change (`UnreadRed`) and passes after it.
- **Live exchange reconciliation:** pushing the bot-to-bot page cleared the active
  channel. Event refresh then fetched only bootstrap previews rather than the
  channel's history, potentially losing intermediate exchange replies. The parent
  now retains its active channel while the exchange is open. A burst test places
  two exchange replies before an unrelated latest main-chat message: neither
  exchange reply is in the bootstrap preview. The test failed before the fix
  (`ExchangeRed`). It also checks filtering and preservation of the main draft.
- **Exchange motion:** the read-only list now shares the stable message identities
  and one-time arrival wrapper used by direct chats and replies. Cached contents
  reveal on the next settled layout rather than a fixed extra settling delay;
  the spinner is delayed for an actual load. New entries use the existing fade,
  upward movement, and scale, while loaded history does not replay entry motion.
- **Group message inset:** the gap after the bot mark was 7 points, putting bot
  bubbles at x=45; the reference bubbles start at x=43. A 5-point gap restores the
  reference inset, consistent with the exchange layout.
- **Speaker type:** sender names used medium weight. The reference shows regular
  weight. Removing that extra weight also brings the measured label width closer.

## Comparison controls

The previous group fixture omitted both the second timestamp break and the NEW
separator. That shortened the transcript and created a misleading spacing
comparison. The fixture now includes both, using inert message text reconstructed
from the recording. Dates are not scored because the fixture timezone differs.

Before the inset change, all eight measured bubble heights already matched the
reference. Vertical positions differed by at most about 1.3 points. This pass
therefore keeps the existing general message spacing rather than changing it to
compensate for missing fixture content. Sender labels, insets, and the unread
boundary are assessed separately. The report retains unmodified reference and
simulator captures; it does not recolor them or score the excluded artwork.

The dark group fixture provides matching text and layout. Light-mode runs validate
the same changes and behavior, but use different content from the supplied light
recording; they are not whole-frame pixel-equivalence measurements. A static
exchange reference establishes appearance, not the precise timing of a new
exchange reply. Reusing the already calibrated message-entry animation makes
behavior consistent, but does not prove identical reference timing.

## Validation scope

Artifacts are under `output/group-motion-0921/`, including original xcresults,
recordings, screenshots, accessibility trees, source hashes and measurement code.
The two intentionally failing regressions are retained.

The older group-computer test expected GET `/screen/frame` and connected viewer
controls. The app now requests a VNC session through POST `/screen/vnc`; this
fixture does not implement an RFB stream. Its routing test now checks the native
computer destination, owner title, and current status/session endpoints. It still
checks that new group responses update the selected desktop and do not switch an
already open desktop, and that human messages leave the last bot responder
selected. This is routing validation, not live VNC acceptance.

No commit, push, or TestFlight upload is part of this pass. Unrelated workspace
changes remain intact.

## Final results

Nine distinct targeted UI cases have passing results on the final applicable
sources: eight in `Final.xcresult` and the corrected computer-routing case in
`Routing.xcresult`. `Final` retains the original stale routing failure; this is
not represented as a single all-green run. Two additional cases were repeated
successfully in `Motion`, and the exchange burst case again in `MotionHEVC`.
Coverage includes keyboard/send/activity transitions, group avatars in both
appearances, cold unread placement, exchange live updates, read-only exchange and
markdown presentation, nested reply draft/context, thread push feedback, widget
completion, and last-responder computer routing.

All source hashes captured for `MotionHEVC` still match the workspace. The raw
intentional regression failures, original stale routing failure, and corrected
passing result are retained for audit.

The final HEVC capture contains usable intermediate push frames: at 19.285s the
exchange message is visible during the push, unlike the old blank/spinner frame
at 20.800s. The reference shows its message at comparable push progress at
118.970s. Incoming back-chevron positions are approximately 232, 230, and 243
points respectively, so these are similar progress, not identical timestamps.
The new capture still has later frame gaps. It supports removal of the blank
entry stage, but does not establish exact animation duration, frame rate, or
continuous smoothness. The original `Final.mov` recording failed during the test
runner restart and is not evidence; the gallery links the valid shorter capture.

Eight matched group bubble heights agree with the reference; all bot bubble
insets now agree at x=43 points. Maximum measured vertical bubble-position
error is 1.33 points. The first sender label width now agrees at 46 points, but
its top ink remains approximately 1.67 points above the reference. This small
remaining type-alignment difference is recorded rather than claimed as perfect.

Review artifacts:

- `output/group-motion-0921/index.html`: comparison gallery.
- `output/group-motion-0921/group-comparison.png`: full group comparison.
- `output/group-motion-0921/group-detail.png`: sender weight/inset detail.
- `output/group-motion-0921/unread-comparison.png`: misplaced vs corrected NEW.
- `output/group-motion-0921/exchange-push-comparison.png`: comparable push frames.
- `output/group-motion-0921/verification.json`: results and source verification.
- `output/group-motion-0921/group-measurements.json`: measured bounds.

These checks use local HTTP fixtures, not a production server. They do not
certify live VNC, push delivery, device haptics, or TestFlight behavior.
