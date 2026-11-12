# Routine fixes and compatibility coverage

This work implements the confirmed defect families from [the original 75-case triage](issue-275-triage.md). The original reproduction scripts characterize commit `c0bf70b3c3f9a21953e96575bed560cca801f027`; their assertions intentionally describe broken behavior and are not the acceptance suite for this branch. The table below gives each original case a current disposition. Multiple cases share one regression-tested cause.

## Publication verification after integrating main

Integrated `origin/main` at `2090e228ca7a43aefc3f38d708e8e1e5b3b2eb48`, retaining both imports in the editor's only merge conflict. The component harness now also stubs main's shared `ButtonPrimitive`; no routine logic was changed for the merge.

Reran the complete acceptance set on a new disposable PostgreSQL database with actual `db:push` and raw schema SQL: **331 tests passed across 41 isolated files, zero failures and zero skips**. All 12 typecheck tasks, all four architecture checks, server/worker/renderer builds, worker Node syntax checking, and whitespace checks passed. [Post-integration per-file results and source fingerprint](issue-275-pr-results.json) identify the publication state. The upgrade/repair evidence and limitations below remain applicable; this does not claim live-provider or browser-layout testing.

## Pull request readiness audit

The original issue was re-read and its exact New York 03:00/18:09 trigger matched to the parser and database regression. The parser expects 23:09 UTC; the database test imports, dispatches the second listener exactly once, reapplies stale files, and verifies that due time and committed history do not rewind. Both are included in the passing acceptance set. The parser and original-listener variant checks were rerun during this audit: two passed, zero failures (14 other checks were filtered out).

All **75 original investigation rows** have a disposition: **61 implemented scenarios/constraints, 10 preserved controls, three deliberately retained compatibility policies, and one documented delete-acknowledgment limitation**. These are scenarios, not 61 independent defects. The retained policies are combined minimum spacing, file-import owner caps, and file-import high-volume listener scope. The delete case still eventually performs the requested deletion; it does not guarantee atomic file/SQL acknowledgment. These entries must not be described as newly fixed bugs.

At that audit, the complete changed source file set and its content hash matched the **331-pass** repeat acceptance result; publication verification above records the subsequent main integration. The additional agent findings and parent execution finding are covered by the linked repeat suites below. The work is ready for pull request review and staging within that scope; that audit was performed before publication, and it is not a claim of merge-CI or live-provider certification. The documented legacy recovery, DST, filesystem atomicity, historical-anchor, and client-restart limits remain.

## Repeat verification with three independent subagents

The earlier repeat acceptance run passed **331 targeted tests across 41 isolated test files, zero failures and zero skips**, on a fresh PostgreSQL database installed with production `db:push`, including raw SQL constraints and search triggers. [Per-file results and the source fingerprint](issue-275-repeat-results.json) describe this verified state. The three independent reviewers covered scheduling, file reconciliation, and editor behavior; the parent added execution-outcome checks.

This pass found and fixed additional defects missed by the previous run:

- **Equivalent triggers shifted cadence:** PostgreSQL JSON key ordering made unchanged mixed event/time triggers look edited. Identity now canonicalizes object keys while preserving listener arrays and values.
- **Immediate create retries duplicated routines:** after a file projection survived SQL rollback, a retry before watcher reconciliation could create a second resource. Creation now recovers its durable disk receipt under the existing locks before looking up that receipt.
- **Copies could steal recovery identity:** copied orphan definitions scanned before the original could claim its UUID and creation receipt. Projected owner/folder metadata now identifies copies, including cross-bot and identical copies. A sole renamed folder still recovers the original.
- **Editor response races lost state:** late responses could regress the accepted revision or Pause state, and conflict recovery could let a later edit overwrite external instructions. Accepted snapshots are monotonic, content saves wait behind controls, and conflicts preserve local input while fencing content writes. An explicit **Reload latest** action fetches current content before discarding a conflicted draft.
- **Grouped callbacks hid failure:** a completed synthetic shell receipt could mask the failed model turn that actually processed it. Group settlement now follows that turn through active and terminal states, including older journal-only folded receipts, and records its failure/completion time.

New coverage includes [15 scheduling checks](../../packages/messaging/test/routine-retest-scheduling.integration.test.ts), [10 file identity checks](../../packages/messaging/test/routine-retest-sync.integration.test.ts), [11 actual-component editor checks](../../apps/desktop/test/routine-retest-editor.test.ts), and [six callback outcome checks](../../apps/worker/test/routine-retest-execution.integration.test.ts). These are test counts, not distinct bug counts. Editor checks execute the actual component with controlled React hooks, APIs, and timers; they do not verify browser layout.

All **12 workspace typecheck tasks** and four architecture checks passed again. Server, worker, and desktop renderer production bundles succeeded, and the worker bundle passed Node syntax checking. Electron and CLI bundles passed in the previous readiness pass; they were not rebuilt in this repeat pass. Changed-file whitespace checks passed.

The actual schema deployment upgraded the original HEAD schema with paused and active grouped fixtures; hashes of all pre-existing routine fields and history were identical before and after. The repair CLI previewed one change, applied one, then found zero changes on repeat; the paused fixture was excluded. Test subprocesses were isolated and serial, with a 30-second test-harness budget; production transaction deadlines were unchanged.

**Ready for review and staging within the tested scope.** A live UI/provider smoke check remains unverified. Calendar DST behavior, incomplete historical anchor information, editor-context-only creation nonce persistence, optimistic filesystem checks, and unrelated baseline failures retain the limits documented below.

**Legacy recovery ambiguity:** if several folders claim a missing routine UUID and old projections lack owner/folder metadata, the original cannot be identified safely. Reconciliation gives an actionable warning and same-key creation recovery blocks instead of attaching arbitrary instructions to the receipt. Retain internal `projection` metadata on the original folder and remove it from copied definitions to disambiguate. This bounded case requires intervention; it is not automatic historical identity recovery.

## Previous readiness check

**Ready for review and staging.** The final acceptance run passed **256 targeted checks across 33 isolated test files, zero failures and zero skips**, using a fresh database installed through the production `db:push` command, including raw SQL constraints and search triggers. [Per-file results and source fingerprint](issue-275-readiness-results.json) identify the verified state.

All **12 workspace typecheck tasks** and four architecture checks passed. Server, worker, desktop renderer, Electron main/utility/preload, and CLI builds succeeded; Node syntax checks passed for the worker and CLI bundles. These are build checks, not signed-release or live-browser certification.

The actual deployment command upgraded the original HEAD schema containing paused, active grouped, and deleted fixtures. Hash comparisons verified that all existing routine fields and history were unchanged and both new columns were nullable. Repeating deployment preserved every routine field. The actual repair CLI produced one preview change, applied that one change, and produced zero changes on repeat; paused/deleted fixtures were excluded.

Final review also found and fixed four bounded gaps:

- A second rollback during file-based creation recovery could erase the original call receipt. Recovery now retains it through both rollbacks.
- Run now could execute cached instructions from a quarantined definition. It now rejects invalid definitions while valid paused routines remain manually testable.
- Hiding and re-showing an existing editor during a save could pair stale displayed content with a newer revision. Outstanding drafts/status are retained; clean records still reload normally.
- A recovered create's edited body could fail server validation before Pause reached the resource. Control state is applied first, and its resulting revision is retained even if content saving fails. Conflicting external instructions cannot be overwritten by a stale draft.

Harness fixes were necessary for a trustworthy final run: the seeded interval corpus now has 24 independent clock/fixture cases, preserving all inputs and assertions; two batch-heavy fixtures have a 30-second setup/I/O budget; and the peer-message fixture closes the watcher it explicitly starts. Product transaction deadlines and correctness assertions were unchanged. The entire 33-file set was then rerun cleanly after those fixes.

For production: apply the two nullable columns first, deploy the updated server/writers/workers together, review the repair dry run, then apply the reviewed repair. A live UI/provider smoke check remains unverified. Calendar DST semantics and historical full-trigger-only edit reconstruction retain the documented limits below; broader baseline/test-harness failures are not represented as passing checks.

## Resulting behavior

- File imports calculate the earliest occurrence across every listener, validate every accepted schedule without truncating it, and pass the installation zone explicitly. Calendar and relative interval listeners retain their own cadence.
- Committed database run state survives stale files, concurrent reconciliation, downtime, manual/event activity, and unrelated edits. Committed occurrences are recognized across instruction revisions. A backlog advances instead of returning to the front of every dispatch page.
- Invalid definitions stay visible and disabled with an actionable error. One bad file cannot stop healthy routines; broken history does not invalidate a valid definition. Settlement cannot erase an invalid authored edit. Restoring valid content clears the error while respecting an explicit pause.
- Projected creation identity survives rollback/import/retry. Copying definitions into new or existing folders retains the folder-authoring workflow and never transfers the source's UUID or creation receipt.
- Routine editor saves preserve exact triggers, pinned/floating zones, event listeners, and Advanced presentation on unrelated edits. Stale presentation cannot restore obsolete scheduling instructions. Correct existing time windows retain their serialization; the reported 45-minute case produces the expected occurrences across midnight.
- Stop fences callbacks, queued continuations, and unclaimed parent handoffs. Stopped contexts release background waits. Folded receipts cannot mask a failed processing turn or release group overlap while their consumer is still running.
- Recovery rotates past its first 100 live executions, isolates failed items, retries committed group handoffs, and keeps healthy event destinations working while failures remain retryable. Queued event runs execute their saved instruction revision.
- UUID lookup is deterministic, invalid Teams regular expressions are rejected, malformed callback contexts are ignored, interval catch-up is arithmetic, and event history/schedule summaries describe the actual trigger.

## Compatibility choices

Existing file-import caps, high-volume-listener policy, and the combined five-minute spacing rule are unchanged. These were policy questions, not demonstrated wrong-intent execution, and tightening them could unexpectedly disable existing user configurations. Exact simultaneous schedule occurrences remain coalesced. Independent relative listeners now share a stable definition anchor; manual/event runs do not reset it. Explicit schedule changes and resume establish a new anchor.

A newly edited Advanced combination that cannot express both an N-day step and selected weekdays/month days shows an actionable validation error instead of silently discarding a restriction. Unchanged legacy definitions remain editable. Calendar windows restart their selected pattern each day; arbitrary minute intervals should not be interpreted as an unrestricted elapsed cadence across days.

Same-key retries continue returning the original creation receipt. The editor retains the original payload and nonce across uncertain retries, recovers that resource, then applies subsequent edits. That nonce lives in the editor context; this change does not add a client journal across application restarts.

The failed-delete/rollback scenario still eventually performs the user's requested deletion. Its acknowledgement ambiguity is documented rather than reclassified as unwanted deletion. Files and SQL still are not one atomic transaction; durable projection identity addresses the demonstrated duplicate-create path.

Exact origins of historical multi-interval schedules were never persisted. Upgrade inference uses saved due times/history; single intervals preserve their saved phase. New, edited, and resumed definitions persist explicit anchors. Historical state cannot recover information the old version never stored.

## Upgrade and repair

Deploy the additive nullable `Routine.scheduleAnchorAt` and `Routine.validationError` schema fields through the existing database deployment process before starting the updated code. The repair is also performed lazily during normal reconciliation/dispatch.

For an explicit preview, with the intended database connection already supplied securely in `DATABASE_URL`:

```sh
bun scripts/repair-routine-scheduling.ts
```

Review the IDs, old/new due times, and inferred anchors, then use `--apply` to persist that plan against current locked rows. The command re-reads state under each routine lock; it does not blindly apply a stale preview. It excludes paused, deleted, invalid, and already-migrated routines. Already-due work stays for normal dispatch, which handles committed occurrences idempotently. It never dispatches work, rewrites instructions, or edits execution history. Repeating apply makes no further changes.

## Regression coverage

- [File/import regressions](../../packages/messaging/test/routine-file-sync-regressions.integration.test.ts): original listener variants, actual second-listener dispatch, stale state, a controlled concurrent read/commit interleaving, backlog fairness, invalid/unreadable files, rollback identity, folder copies, quarantine, and phase migration.
- [Scheduler database regressions](../../packages/messaging/test/routine-scheduling-regressions.integration.test.ts) and [cadence oracles](../../packages/messaging/test/routine-scheduling-regressions.test.ts): metadata/manual cadence, downtime, mixed zones, first detection, immutable queued prompts, exact identity, and isolated event/projection faults.
- [Execution/recovery regressions](../../apps/worker/test/routine-275-regressions.integration.test.ts): Stop ordering, failed batches, real local shell completion, folded group callbacks, recovery paging/isolation, and dry-run/idempotent repair.
- [Editor preservation](../../apps/desktop/test/routine-editor-preservation.test.ts), [escaped error rendering](../../apps/desktop/test/routine-definition-error.test.tsx), and [client nonce transport](../../packages/client-core/test/routine-create-idempotency.test.ts): destructive round trips, zones, mixed listeners, Advanced cadence/filter limits, error refresh, and uncertain creates.
- Existing concurrency, time lifecycle, time-zone, group execution, and streaming worker coalescing/revival tests remain in acceptance coverage.

Tests use disposable PostgreSQL and stub queue/model transport. A real local shell process and completion callbacks are exercised; live external providers and interactive browser behavior were not exercised.

The earlier lost-notification watcher failure reproduced on both the original HEAD and this branch, but further investigation traced it to a stale fixture: sidebar hiding was removed in #224, so reconciliation deliberately keeps `hiddenFromSidebar` false.

The corrected test exercises the supported `notifyOnAgentUpdates` setting through repeated changes, deletion recovery, and shutdown, while checking that a legacy hiding field cannot hide the Bot. It passes with production code unchanged. Temporarily disabling the fallback scan makes the corrected test fail, confirming that it still detects broken lost-event recovery. Historical result files retain the failure observed before that fixture correction. After the correction, all **418 checks across 63 isolated files passed, with zero failures and zero skips**, including the original 331 routine acceptance checks and the broader compatibility set. Messaging typechecking and whitespace checks also passed.

## Initial verification results

- Focused acceptance: **90 passed, zero failures**, across 15 files with disposable PostgreSQL (506 assertions), including existing worker streaming/coalescing and group execution tests.
- Broader unit run: **497 passed, 111 integration cases skipped, zero failures**. Additional listener-matrix and concurrency/backlog cases were subsequently checked in the focused acceptance run.
- Typecheck: **12 workspace tasks passed**, including desktop, messaging, worker, server, client/core contracts and dependencies.
- All four architecture checks passed; changed-file whitespace checks passed.
- Independent timing sweeps: **751 calendar, grouped-calendar, and phased-interval cases across two seeds**, with zero mismatches within the original eight-day oracle horizon.
- Repair CLI dry-run smoke check passed on an empty disposable database; the database regression verifies preview immutability, selective apply, preserved due/paused state/history, and repeat-apply idempotency.

To run the newly added defect regressions, apply the schema to an empty disposable database and provide its connection via `OPENTEAM_TEST_DATABASE_URL`, then run:

```sh
bun test \
  packages/messaging/test/routine-file-sync-regressions.integration.test.ts \
  packages/messaging/test/routine-scheduling-regressions.integration.test.ts \
  packages/messaging/test/routine-scheduling-regressions.test.ts \
  apps/worker/test/routine-275-regressions.integration.test.ts \
  apps/desktop/test/routine-editor-preservation.test.ts \
  apps/desktop/test/routine-definition-error.test.tsx \
  packages/client-core/test/routine-create-idempotency.test.ts
```

## Extended testing after implementation

The subsequent acceptance run passed **225 tests across 32 files, zero failures, 1,823 assertions**, including all earlier focused routine checks, the new stress cases, existing request-stop/resume tests, and subagent compatibility tests. All **12 workspace typecheck tasks** and four architecture checks passed again. A final no-database run passed **566 unit checks**, with 160 integration cases skipped and zero failures.

This pass found and corrected additional boundaries:

- **Stop during continuations:** actual Stop now resolves the original routine context even when its current turn is a continuation. Stopping a completed continuation also stops workers still owned by that original context.
- **Already-claimed handoffs:** publication checks the durable handoff receipt, so stopping the root fences a notification already claimed by the parent. Ordinary unstopped handoffs continue to deliver. The same publication fence covers peer messages as well as user-visible messages.
- **Unimported file edits:** runtime projection and control-only updates preserve pending valid edits, unfinished/invalid edits, copied definitions, and intentional file deletion before the watcher imports them. Explicit definition saves can still author a new definition. Import acknowledgment rechecks that its snapshot has not changed before updating metadata, preserving extension fields.
- **Lifecycle/import ordering:** pending instruction edits cannot undo a newer explicit pause; explicit file-enabled changes remain supported. Toggle-only API calls cannot silently clear quarantine or resume an invalid definition.
- **Legacy cadence:** inferred origins use observable schedule/resume revisions rather than a future next occurrence. Metadata revisions do not shift cadence. Enabled legacy schedules with missing due times recover using the same inference in sync, dispatch, and the repair command.
- **Editor save ordering:** stale autosaves use the latest desired Pause/Resume state. Pause during delayed creation is applied after the resource ID is recovered, even if unsaved content is now invalid. Control-only conflict recovery preserves externally updated instructions and retains the recovered ID on failure.

New coverage:

- [17 sync stress cases](../../packages/messaging/test/routine-file-sync-stress.integration.test.ts): concurrent sync and dispatch, rollback history, pause/edit ordering, copied definitions, snapshot acknowledgment, and transactional pre-upgrade/additive-column compatibility.
- [10 scheduler stress cases](../../packages/messaging/test/routine-scheduler-stress.integration.test.ts): 24 seeded interval groups through 96 downtime dispatches; 16 legacy migration permutations; six-zone clock checks; actual DST dispatch and simultaneous coalescing; quarantine controls; missing due times.
- [Six Stop-ordering and repair-paging checks](../../apps/worker/test/routine-stop-ordering.integration.test.ts): actual server Stop paths, already-claimed user/peer delivery, worker ownership, and two concurrent repair callers covering 205 rows over multiple pages while preserving protected rows.
- [Independent editor calendar oracle](../../packages/messaging/test/routine-editor-schedule-oracle.test.ts): 96 leap/month/year cases, 24 post-transition windows, and minimized spring/fall DST cases. Additional deferred-promise tests in [editor preservation](../../apps/desktop/test/routine-editor-preservation.test.ts) cover save/creation/control ordering.

After the final peer-publication fence, a separate Stop/peer/group compatibility run passed **20 checks, zero failures**. One earlier run under concurrent typecheck/unit load exceeded the unchanged five-second deadline in the six-member room test; on a fresh database without that concurrent load, the same test passed in 361 ms. No timeout was increased and no assertion was weakened.

**DST limitation:** Advanced calendar phases follow cron's gap/overlap rules. For example, on New York's spring transition a missing phase can shift into the following hour; the resulting sequence can include a 15-minute gap in a nominal 45-minute pattern. This is not an elapsed-time guarantee across a clock change. Existing calendar schedules were deliberately not converted to `@every` intervals, which would change their wall-clock/window semantics. Use the interval scheduling mode for elapsed cadence; deciding whether to offer both interpretations in Advanced remains a product choice.

**Broader-suite findings:** an initial database-enabled sweep ran 591 tests: 584 passed, three skipped, four failed. The WakeParent end-to-end test times out during its foreground child fixture, and the cross-device notification fixture attempts delivery from a default provisioning bot. Both failures also reproduced with original HEAD source substituted through an isolated loader; the loader was verified against a helper absent from HEAD. The historical watcher failure is accounted for by the stale-fixture correction described above. The fourth check, CLI/APNs bundling, fails module resolution through `Bun.build` inside the test runner. The standalone production CLI build succeeds in the final readiness check. This integration test remains unverified; the observed test failure does not establish that production dependencies are missing. These checks are not represented as passing routine acceptance tests.

The filesystem snapshot check remains optimistic; it is not atomic compare-and-swap against arbitrary external writers. Old complete-trigger-only edit origins are still unrecoverable where historical revisions never recorded them. Interactive browser tests and live external-provider transport remain outside the exercised coverage.

## Every original case

“Implemented” refers to the fix family and linked acceptance coverage above, not a claim that every old bug-expecting script now exits successfully.

| Original suite/case | Scenario | Current disposition |
| --- | --- | --- |
| extent/1 | daily schedules | Implemented: C1 |
| extent/2 | weekly plus daily | Implemented: C1 |
| extent/3 | pinned schedules in different zones | Implemented: C1 |
| extent/4 | long interval before short interval | Implemented: C1 |
| extent/5 | calendar before interval | Implemented: C1 |
| extent/6 | phased intervals | Implemented: C1 |
| extent/7 | eight schedules | Implemented: C1 |
| extent/8 | non-time listener preceding the only time listener still schedules correctly | Preserved control |
| extent/9 | one cron expression with multiple hours is unaffected | Preserved control |
| extent/10 | later invalid and too-frequent schedules pass file validation but fail API validation | Implemented: C3 |
| extent/11 | API-created bot routine starts correct, then unchanged file sync corrupts nextRunAt | Implemented: C1/C2 |
| extent/12 | pause stays paused; resume of a single schedule is rewound to the paused period | Implemented: C2 |
| extent/13 | editing a single schedule is rewound to before the edit | Implemented: C2 |
| extent/14 | downtime catch-up is undone for single cron; historical occurrences run again on later passes | Implemented: C2 |
| extent/15 | downtime catch-up is undone for single interval; historical occurrences run again on later passes | Implemented: C2 |
| extent/16 | manual run shifts a single relative interval only after file sync | Implemented: C2 |
| extent/17 | event delivery shifts a mixed routine's relative interval only after file sync | Implemented: C2 |
| extent/18 | timezone updates of a single unpinned cron are rewound by file sync | Implemented: C2 |
| extent/19 | invalid later file schedule aborts dispatch before a healthy unrelated routine | Implemented: C3 |
| extent/20 | group-owned multi-cron routine survives bot file sync and dispatches the second listener | Preserved control |
| extent/21 | separate grouped-schedule validation gap: two valid listeners can fire less than five minutes apart | Existing policy retained for compatibility |
| extent/22 | a helper-only file-sync fix must pass the installation zone explicitly | Included in full-trigger/zone repair |
| extent/23 | separate helper limitation: relative grouped intervals lose the longer interval's cadence, including group owners | Implemented stable independent interval cadence |
| chaos/1 | a syntax error soft-deletes an existing routine even though its definition file still exists | Implemented: C3 |
| chaos/2 | an unreadable automation file blocks the entire sync-then-dispatch pass repeatedly | Implemented: C3 |
| chaos/3 | an unreadable runs.json soft-deletes a routine whose automation.json is valid | Implemented: C2/C3 |
| chaos/4 | legacy schedule fallback silently strips all other listeners after a malformed group edit | Implemented: C3 |
| chaos/5 | crash after dispatch commit but before file projection creates a permanent duplicate-key dispatch trap | Implemented: C2 |
| chaos/6 | ordinary concurrent reconciliation and dispatch can erase a committed run and poison future dispatch without any crash | Implemented: C2 |
| chaos/7 | create rollback leaves an active ghost routine; retrying the same call ID creates a duplicate | Implemented: D1 |
| chaos/8 | delete rollback removes the file; later sync deletes the routine despite the DB rollback | Requested deletion preserved; acknowledgement limitation documented |
| chaos/9 | control: overlapping executions record one skip and preserve its lastRunAt through sync | Preserved control |
| chaos/10 | 50 backlogged routines monopolize every dispatch page and create overlap skips while a healthy bot starves | Implemented: C2 |
| chaos/11 | file import bypasses the 50-routines-per-owner API limit | Existing policy retained for compatibility |
| chaos/12 | control: eight concurrent schedulers dispatch one occurrence exactly once | Preserved control |
| chaos/13 | 100 live executions starve recovery of a completed execution on another routine | Implemented: X4 |
| chaos/14 | year-old five-minute interval exceeds dispatch transaction timeout instead of catching up in constant time | Implemented: S2 |
| execution-chaos/1 | one unavailable event listener blocks delivery to a healthy bot on every retry | Implemented: X4 |
| execution-chaos/2 | a group dispatch handoff failure leaves a queued round stuck until startup-style round recovery | Implemented: X5 |
| execution-chaos/3 | a late shell callback resumes an explicitly stopped and cancelled automation | Implemented: X1 |
| execution-chaos/4 | a callback queued before WakeParent remains claimable after the automation handed off | Implemented: X1 |
| execution-chaos/5 | a callback with an unknown automation run ID is routed into the user-facing foreground | Implemented: V1 |
| execution-chaos/6 | a failed batched continuation is marked successful because a folded newer run was marked completed | Implemented: X2 |
| execution-chaos/7 | an invalid Teams regex is accepted as enabled and silently never matches | Implemented: V1 |
| execution-chaos/8 | one failed follow-up launch rolls back root settlement and blocks recovery for another bot | Implemented: X4 |
| execution-chaos/9 | file imports bypass the API refusal of unscoped high-volume GitHub listeners | Existing policy retained for compatibility |
| final-sweep/1 | interval-first grouped schedules retain an invalid due time after a timezone change | Implemented: C4 |
| final-sweep/2 | first timezone detection pins later floating schedules to the first pinned listener's zone | Implemented: C4 |
| final-sweep/3 | first timezone detection misses floating cron listeners when an interval is first | Implemented: C4 |
| final-sweep/4 | a long valid cron accepted by the schedule API is truncated and soft-deleted by file sync | Implemented: C3 |
| final-sweep/5 | desktop prompt-only edit: Sunday represented as 7 becomes Saturday | Implemented: U1 |
| final-sweep/6 | desktop prompt-only edit: a monthly-plus-weekly rule loses its weekday | Implemented: U1 |
| final-sweep/7 | desktop prompt-only edit: an advanced rule loses its month-day constraint | Implemented: U1 |
| final-sweep/8 | desktop edit makes a valid hourly */60 cron unsavable by clamping its step to 59 | Implemented: U1 |
| final-sweep/9 | desktop prompt-only edit replaces an explicitly pinned schedule's timezone with the device zone | Implemented: U1 |
| final-sweep/10 | desktop-generated triggers ignore a settings timezone override and stay pinned across later changes | Implemented: U2 |
| final-sweep/11 | stale desktop presentation hides a file schedule edit and restores the old time on the next prompt edit | Implemented: U1 |
| final-sweep/12 | desktop prompt-only edit of a mixed event/time routine silently removes its event listener | Implemented: U1 |
| final-sweep/13 | advanced every-N-days weekday restrictions still generate weekend runs | Implemented: U3 |
| final-sweep/14 | two valid desktop cards can expand beyond the server's eight-listener limit | Implemented: U3 |
| final-sweep/15 | group routine overlap protection ends while its background shell is still running | Implemented: X5 |
| final-sweep/16 | control: bot routines retain overlap protection while a background shell is running | Preserved control |
| final-sweep/17 | worker settlement rewrites event-run history as scheduled-run history | Implemented history/summary accuracy correction |
| final-sweep/18 | sweep: desktop round trips introduce no failure classes beyond the minimized cases | Preserved control |
| final-sweep/19 | sweep: independent calendar and phased-interval invariants, seed 275 | Preserved control |
| final-sweep/20 | sweep: independent calendar and phased-interval invariants, seed 276 | Preserved control |
| revision-chaos/1 | coalescing a new event changes a queued bot run's prompt without changing its recorded revision | Implemented: X3 |
| revision-chaos/2 | control: coalescing a group event preserves the queued execution's original instruction | Preserved control |
| revision-chaos/3 | a prompt-only update resets a group interval's due time without any file reconciliation | Implemented: C2 |
| revision-chaos/4 | an uncertain create retried with edited input silently returns the original routine | Implemented editor recovery; original same-key receipt preserved |
| revision-chaos/5 | a UUID-shaped folder can make a different routine resolve when addressed by UUID | Implemented: I1 |
| revision-chaos/6 | a run fired by a later schedule is described to the model as firing on the first schedule | Implemented history/summary accuracy correction |
| advanced-cadence/1 | Advanced Every 45 minutes alternates 45- and 15-minute gaps | Implemented: U3 |
| advanced-cadence/2 | Advanced Every N days discards selected month days | Implemented: U3 |
| advanced-cadence/3 | Advanced summaries omit selected months | Implemented history/summary accuracy correction |
