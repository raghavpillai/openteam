# Notification chaos audit — November 15, 2026

This follow-up audits merged desktop fix [#348](https://github.com/raghavpillai/openteam/pull/348), commit `db36072409a3935266f9a9c07e54816ec27cb25b`. It uses an isolated worktree, synthetic notifications, a dedicated iPhone simulator, and a disposable PostgreSQL instance. No production push traffic or release was generated.

## Findings

The desktop flash came from delivery racing with focus and read updates. The merged fix shares local read cursors before server acknowledgement and waits 300 ms before delivery, then checks focus and read state again. Pending delivery is cancelled on focus, read, removal, or session reset. An alert already delivered can still disappear when a real read arrives; the grace period does not impose a minimum banner lifetime.

Computer activity and conversation reads have different roles. The smart-notification preference can pause iPhone alerts while a Mac is active, without marking the message read. Desktop banner suppression uses OpenTeam focus and read state. Cross-device read cleanup is expected to remove an acknowledged alert from Notification Center while preserving newer unread alerts.

This audit found three test-harness defects:

- The database cross-device integration expected immediate desktop delivery. It now checks that delivery is initially pending, waits for the shared delivery interval, and cancels the manager's timers in `finally`.
- On iOS 26.5, tapping a Notification Center item sometimes only hints a swipe. SpringBoard logs explicitly recorded that behavior. The UI helper now follows the notification's swipe/Open action, without forcing app activation. Cold-launch and routing assertions still depend on the OS notification response.
- The chat-switching test checked for Back before asynchronous navigation had completed, then attempted to use a sidebar control absent from the current layout. It now waits for the navigation and channel-list controls before interacting.

No additional production defect has been confirmed in the completed checks. These follow-up changes affect tests only.

## Validation

Environment: Xcode 27.1, iPhone 17 Pro simulator running iOS 26.5, Bun 1.4.2, PostgreSQL 17. The iOS app and tests were built from the merged source.

| Check | Result |
| --- | --- |
| All Swift core tests | 319 passed |
| Notification core subset, included above | 9 passed; includes 10,000 reordered read updates |
| Hosted notification opening tests | 27 passed |
| Database, dispatch, APNs transport, projection, and presence suite | 41 passed, 219 assertions |
| Four database integration files repeated five times | 35 passed, 435 assertions |
| Presence routes, push/APNs, body and text boundaries | 27 passed, 191 assertions |
| Database integration rerun after focused UI tests | 7 passed |
| Focused native push interaction tests | 2 passed |
| Full native push UI attempt | 25 passed, 1 skipped, 2 unsuccessful cases |
| Isolated lifecycle reruns after harness fix / longer allowance | Both passed; reconnect stress 166.657 s, chat switching 62.763 s |
| Unique native push scenarios across the full attempt and reruns | 27 passed, 1 skipped; not a single uninterrupted green suite |
| Worker TypeScript check | Passed after generating the existing plugin registry |
| Whitespace check | Passed |

Database chaos covers concurrent, duplicated, and reordered read acknowledgements, independent message/reaction cursors, unread badge counts, session isolation, Mac presence suppression, phone foreground priority, expired leases, the five-minute idle boundary, and no replay of suppressed activity. APNs transport tests use injected responses rather than Apple's production service.

Native UI checks inspect the actual iOS delivered-notification list and badge. Scenarios include foreground suppression, selective cleanup preserving newer messages/reactions and other chats, offline and failed-snapshot recovery, delayed/lost read acknowledgements, relaunch with persisted read markers, late duplicates, notification cold launch, thread routing, older history windows, and registration/disconnect failures.

The full native attempt imposed a 180-second per-test limit. Repeated reconnect stress was still making progress through its four cycles when it exceeded that limit. The final chat-switching case hit the navigation race above, then stalled during XCTest failure teardown and also exceeded its limit. The owned runner was stopped after preserving the logs; the full result bundle is incomplete. Both cases passed separately with a bounded 600-second allowance, without changing production code. After assertions completed, the rerun's simulator diagnostic collector stalled; only that owned `simctl diagnose` child was stopped. Xcode then finalized the result bundle and exited successfully. The initial failures remain part of this audit's record.

## Remaining device coverage

The simulator did not execute a background push callback in the background-only desktop-read cleanup case. That test explicitly skips with delivery evidence; it is not counted as passing. Foreground reconciliation and selective cleanup have separate native tests.

A signed physical iPhone test is still required for real APNs registration, delivery while suspended, background read cleanup, Focus/notification settings, and service-extension behavior under Apple's delivery deadlines. Physical-device enumeration failed because CoreDeviceService initialization timed out, so this audit does not establish whether a suitable device was connected.

The ordinary worker formatter check also reports existing formatting outside the changed lines; no broad reformat was made.

Local logs, XCTest result bundles, and machine-readable results are in ignored `output/notification-ios-audit/`. Earlier desktop native stress evidence is in `output/notification-rca/`. These artifacts are local evidence, not checked-in fixtures.
