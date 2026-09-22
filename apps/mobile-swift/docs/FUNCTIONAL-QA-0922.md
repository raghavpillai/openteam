# iPhone functional QA — September 21–22, 2026

Completed: **171 distinct simulator checks passed, 1 simulator-only background-callback check skipped, 0 unresolved executed-test failures.** Swift core: **100 passed**. RN/client contracts: **278 passed** (2,512 assertions across 56 files). These counts use each test’s final acceptance result, not the sum of retries. One obsolete PNG-viewer test is marked superseded rather than counted as a pass.

Four product defects were fixed and revalidated. Changes are local; this QA run does not upload TestFlight or certify hardware/provider-specific behavior. Artifacts referenced below are under `output/mobile-functional-0922/` from the repository root.

## Environment and boundaries

Two dedicated iPhone 16 Pro Max simulators, iOS 26.5, ran the native Swift app with optimized Debug builds (`-O`). The native source baseline is `b71b539abb6717ae5495fb7437fc226ac22f6f1f`, plus the fixes recorded below. The checkout advanced to `faee5749ee1094ed3efbdff6048291ef65be25f7` during the audit for unrelated desktop/computer changes; that commit does not modify the native app. Native source hashes were verified unchanged after the final signed build. Xcode UI tests drove actual taps, typing, holds, swipes, native sheets, Photos/share controls, and Notification Center. Completed UI batches have a screen recording, source hashes, log, `.xcresult`, exported attachments, and test summary under the artifact root. `test-ledger.json` retains every completed attempt rather than hiding earlier failures.

Failure/retry, OAuth lifecycle, widgets, approvals, and editor edge cases use isolated contract fixtures. Separate live tests exercise authenticated production APIs, a real worker, PostgreSQL, model inference, transcription, and VNC. All created bots, messages, routines, and files belong to disposable QA databases/workspaces. The user's normal installation was not used for test writes. Its Tailscale HTTP endpoint was checked for health, native server discovery, and an invalid-login error only.

The live provider server uses the installed `openteam-local-server:unified-oauth-ddceb67` image; the worker and computer gateway use current workspace source. The Linux runtime is `openteam-local-computer:cua-session-fixes-20260921`. Provider credentials were supplied through existing secure local configuration and ephemeral container memory, not checked into source or displayed. A dedicated Docker network routes VNC to the QA desktop instead of the main installation's desktop ports.

## Coverage exercised through Simulator

- Sign-in/server discovery over HTTP; saved Keychain sessions; offline account details; Re-auth cleanup and reconnect; settings navigation/preferences.
- Bot and group creation/editing; section menus; group avatars, unread boundaries, latest-responder desktop targets, and read-only bot exchanges.
- Text send/retry/lost acknowledgement, persistent drafts, deleted-channel isolation, older-message navigation, search destinations, holds/reactions/copy, edge-back priority, swipe replies, nested replies, and context restoration.
- Image/document upload and identification, file limits, previews, offline media cache, 24-item galleries, photo saving, share/forward, and picker cancellation.
- Markdown/rich document interactions; single/multiple/custom widget answers, dismissed/completed receipts, retry identity, and keyboard/reading anchors during widget changes.
- Approval state/recovery, account access and pagination, plugin install/uninstall retry, enablement versus account grants, OAuth cancellation/reopen/expiry and lost-response reconciliation.
- Routine dropdown editor, persistence/conflicts, pause/resume/delete/manual run, plus real clock-driven execution after closing the app.
- Voice recording/stop/discard/retry, delayed transcription and cancellation, actual ASR, native notifications/read clearing, VNC controls/reconnect, and 15 haptic-dispatch scenarios.

Only tests that actually ran are included in the attempt ledger. Visual-only reference capture suites and hardware/provider-specific checks are not implied by these results.

## Product defects found

1. **Group creation could lose the first member selection.** Autofocusing Search expanded the creation sheet from its initial partial height while the first tap landed. Start the group sheet at its final large detent. The regression now asserts both member selections before proceeding and checks that both survive create failure/retry. This fix passed the simulator test.
2. **Voice input was unreachable with an existing draft.** The mic became Send and the attachment menu lacked the former voice action. Restore Record voice note in the attachment menu when text/attachments already exist and transcription is configured. The empty composer retains its three attachment options. The real transcription, draft insertion, discard, and durable-send regression passed after this fix.
3. **Computer startup exposed an unsized surface.** Keep the viewer and its accessibility surface hidden until both the VNC connection and remote dimensions are ready; show the native loading state in the meantime. The final live desktop test passed, including 1.6:1 sizing before/after opening the keyboard, trusted text/newline/backspace input, clipboard typing, and returning the control lease.
4. **Trackpad tap-then-drag could become pointer movement.** Keep a bounded 500 ms / 22-point tap sequence instead of relying solely on UIKit's tap count after recognizer resets. Cancellation, multi-touch, holds, and movement clear the sequence. A separate expired-tap test checks that ordinary pointer movement does not accidentally hold the remote mouse button. Both tests passed against the actual Linux desktop, alongside touch drag, hold/right-click, wheel scrolling, pinch/pan, and disconnect recovery.

## Real scheduled execution

The app created `Scheduled QA 597EAF43` using Frequency → Interval → minutes → 5. The UI displayed “Every 5 minutes.” The test terminated the app and waited for the real clock; it did not advance database timestamps or manually dispatch the job.

- Due: `2026-09-22T03:10:04.805Z`.
- Scheduled execution created: `2026-09-22T03:10:05.311Z`.
- Completed: `2026-09-22T03:10:06.754Z`.
- Exactly one completed scheduled execution was observed. The disposable routine was then paused.
- Reopening the app showed “Scheduled QA completed.”

This test uses the real scheduler, API, worker, database, routine run, parent handoff, and persisted message. Only the model boundary is deterministic. Separate live-model tests validate actual inference. Editor tests additionally cover weekly/monthly/hourly schedules, timezone preservation, grouped/custom schedule retention, revision conflicts, create errors, pause/resume, delete cancellation, confirmed deletion, manual run/history, and lost-response recovery.

Evidence: `scheduler-created.json`, `scheduler-completed.json`, `LiveScheduleAndRetry3.xcresult`, and `captures/live-backend-scheduled-result-after-relaunch.png`.

## Harness corrections kept separate from product fixes

- Updated the deterministic computer boundary for the current authenticated-health and task-capabilities protocol.
- Replaced stale cron-textfield automation with the actual schedule dropdowns.
- Updated obsolete thread-badge selectors to reply quotes. The long-history quote check also now verifies focused reply context and restoration of the main timeline, rather than expecting a main-timeline Latest button on the reply page. The server assertions still require the correct parent, branched metadata, channel, and exactly one persisted reply.
- Made the live reply row helper recognize focused reply-page header/composer identifiers.
- Wait for the newly created chat before searching for its greeting; the inbox can contain the same greeting in older conversation previews.
- Started the separate live-notification bridge required by the real notification test.
- The haptics preference and notification toggle tests now tap the actual nested native switch and assert its value. Registration retry, toggle retirement/re-enable, and sign-out retirement passed.
- The saved-session test needs simulator ad-hoc signing for real Keychain access. The initial unsigned batch could not access Keychain; the signed rerun passed, including normal relaunch, destructive Re-auth, cold launch, and reconnect.
- The old PNG/REST computer test was replaced with handoff failure/retry assertions; actual pointer/keyboard transport is tested through VNC.
- Plugin uninstall reconciliation refreshes the lazy form. The recovery test now scrolls back to the uninstall row before retrying; the server must confirm removal.
- The desktop keyboard probe now explicitly restores its minimized Chrome window and waits for the window manager before requesting fullscreen. This is test setup, separate from app input delivery.

One bot-creation test incurred repeated XCTest animation-idle waits (433.579 seconds total), but its UI actions, failure/retry, backend result, and haptic assertions passed. That automation duration is not a user-response-time measurement.

Earlier failed/interrupted bundles are retained. A zero-test suite after an XCTest restart is not treated as acceptance.

## Lifecycle and input recovery

The native simulator passed initial chat loading at the latest message, empty-chat send, keyboard/send/activity transitions, both launch appearances, returning from background without replaying launch, and startup failure recovery. The voice fixture held a transcription response for 70 seconds; it still completed successfully (78.615 seconds for the entire UI test). Leaving the chat during transcription kept the original draft; stop/error/retry preserved the recording. All 15 haptic-dispatch checks passed. Physical vibration is separate.

## Additional live evidence

Real speech recognition returned: “Please remind me to bring the blue notebook to our meeting tomorrow at 9.” The measured ASR request took 3.391 seconds. The test verified that it remained a draft until Send, was durably stored after Send, and could be appended to an existing typed draft. Silent audio produced the retryable No speech error twice, and discard restored editing.

Authenticated live replies, held/swiped replies, attachment upload/preview/reaction/replies, rich Markdown gestures, and relaunch persistence passed. Live desktop read events removed iOS Notification Center entries selectively (2 → 1 → 0), with a badge matching the server snapshot. Native HTTP discovery and an actual server authentication response passed against `http://100.94.42.50:8787`.

## Long-history measurements

The performance suite ran after the other QA UI runs finished and the disposable live services/second QA simulator were shut down. The user's normal apps and unrelated simulator were left untouched. Three measured iterations each perform six scroll gestures, restoring the same start position outside the measurement. Workloads are 1,000 multiline text messages and 200 mixed messages, including 20 table/math/quote documents.

| Workload | Six-gesture wall time, mean | Native CPU time, mean | Native peak memory, mean |
| --- | ---: | ---: | ---: |
| 1,000 text messages | 18.441 s | 4.061 s | 101.8 MB |
| 200 mixed messages | 19.390 s | 4.650 s | 119.0 MB |

These are Simulator/XCTest measurements, not per-frame latency or physical-device FPS. Wall time includes automation/idle waits; native memory excludes WebKit subprocesses. No before/after performance baseline was recorded in this run, so these numbers do not establish a percentage improvement or regression. Raw measurements are in `performance-metrics.json` and `performance-summary.json`.

Additional checks exercise typing after repeated rich-history window changes, distant reply context, stable anchors during incoming messages and page prepending, tall-message keyboard avoidance, and return to latest messages.

## Remaining device-only validation

A simulator cannot establish physical microphone quality, actual vibration, camera capture, or signed-device APNs transport/background wake behavior. Audio samples for the real transcription tests are injected into the recording path, then encoded/uploaded through the production route and real ASR service. Notification delivery is injected with `simctl push`; registration, real Notification Center removal, desktop read APIs, event streams, and badge reconciliation are checked separately. One background-only callback test explicitly skipped because iOS Simulator did not execute the callback.

Third-party OAuth failure/cancel/reopen/expiry/recovery paths use a local provider fixture. This does not certify every external provider/account's production OAuth configuration. Simulator performance numbers are not a physical iPhone FPS guarantee.

## Evidence and cleanup

- `test-ledger.json`: all attempts, timestamped final outcomes, and the explicitly superseded PNG test.
- `review.html`: searchable test table and selected simulator captures.
- `DesktopFinalAcceptance.xcresult`: successful live VNC startup/keyboard/clipboard/control-return acceptance.
- `AccountRecoveryAcceptance.xcresult`: account/plugin recovery and signed notification acceptance (one device-only skip).
- `LifecycleAndVoice.xcresult`: all nine startup/chat/transcription checks passed.
- `WidgetsAndInteractions.xcresult`: all 19 video-reference widget/reply/group tests, all 15 haptic tests, four section/glass tests, and two attachment-menu tests passed. Its earlier VNC probe failure is resolved in DesktopFinalAcceptance.
- `PerformanceIsolated.xcresult` and `HistoryReplyAcceptance.xcresult`: all seven final history checks passed, with raw performance measurements retained.
- Completed UI batches retain their original `.mov`, test log, `.xcresult`, exported attachments and source hashes. Earlier failed or interrupted attempts remain visible.

Owned QA fixtures, API/worker processes, Linux computer/server/database containers, and the QA Docker network were stopped/removed. The newly created secondary simulator was deleted; the existing primary QA simulator was shut down. The unrelated simulator and user's normal four Docker services were left running. No QA ports or copied encrypted transcription configuration remain. `final-cleanup.json` records this check. The normal Tailscale endpoint `http://100.94.42.50:8787` still returns ready, including database, queue, computer, inference and configured transcription.
