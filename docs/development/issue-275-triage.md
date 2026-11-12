# Routine defect triage

Implementation and post-fix coverage are recorded in [Routine fixes and compatibility coverage](issue-275-fixes.md). This document preserves the baseline investigation.

Issue [275](https://github.com/raghavpillai/openteam/issues/275) is real. Its useful initial fix is all-listener scheduling plus durable runtime-state ownership across file reconciliation. Several earlier reports are variants, controls, or separate execution/editor problems. They should not become one oversized patch.

Tested commit: `c0bf70b3c3f9a21953e96575bed560cca801f027`. The original issue reproduction and all six preserved suites reran against disposable PostgreSQL. The 75 rows below include controls and generated sweeps; they are not 75 independent defects. Passing characterization assertions means the described behavior reproduced, not that production is healthy. Queue transport and model/computer execution are stubbed; the real scheduler, file sync, messaging, claim and recovery code run where specified.

## Initial routines fix

1. **C1 — Compute across the entire trigger.** Normalize every listener, take the earliest occurrence, and pass the installation zone explicitly. Keep legacy first-schedule fields as presentation/fallback metadata only.
2. **C2 — Preserve authoritative runtime state.** Files may author definitions, but an unchanged or stale projection must not overwrite committed next-run, last scheduled occurrence, or cadence state. Preserve cadence on name/prompt-only saves. Make existing-occurrence recovery idempotent.
3. **C3 — Validate and isolate import failures.** Reuse full-trigger validation, preserve accepted cron text, and isolate every file read/parse failure. Keep invalid definitions visible and disabled with an error. Treat history-file errors independently; do not silently execute obsolete last-good instructions.
4. **C4 — Remove first-listener assumptions from zone handling.** Consider every calendar listener during changes and initial migration. A pinned first listener must not determine another listener's old floating zone.
5. **Repair existing state.** Provide an idempotent reconciliation of affected routines and occurrence records, including future due times incorrectly pointing to the first listener. Preview the changes, preserve execution history and intentional pauses, and avoid recreating already-recorded occurrences.

Accept this change only after bot-created and UI-created multi-schedule routines fire every expected occurrence across sync/restart, and resume/edit/downtime/zone changes cannot rewind runtime state. Re-run the existing starvation and duplicate-key cases after this correction before creating separate fairness fixes for those consequences.

## Separate fixes worth scheduling

- **U1 — Preserve editor definitions.** Save name/prompt changes without regenerating the trigger. Preserve pinned zones, Sunday aliases, compound calendar rules, and mixed listeners. Verify presentation against the current trigger.
- **X1 — Fence terminal automation contexts.** A stopped root must block late callback routing, claims and parent notifications. Drop obsolete queued continuations after handoff.
- **X2 and X3 — Record the execution that actually ran.** Folded receipts must not hide a failed processing turn; a queued execution must execute its recorded instruction revision.
- **X5 — Recover group execution lifecycles.** Retry committed-but-unadvanced room rounds and account for background work before releasing overlap protection. Add a real shell lifecycle integration check to the persisted-shell reproduction.
- **D1 — Make projection and retry recovery durable.** Preserve operation identity across rollback, import and retry so an uncertain create cannot become two active jobs. This needs journaling/reconciliation; shared locking alone cannot make files and SQL atomic.
- **X4 — Bound and isolate recovery.** Rotate the recovery scan beyond 100 live entries and isolate each failed follow-up/listener. The archived-DM fan-out fixture is a fault state, not evidence that normal retirement leaves such listeners enabled.
- **I1 — Resolve identity deterministically.** Prefer an existing UUID over a matching folder alias. A regression must assert UUID identity, not depend on which ambiguous row PostgreSQL happens to return.
- **S2 — Advance intervals without iterating missed ticks.** The measured timeout is machine-dependent; the underlying linear catch-up is the defect.
- **U2 and U3 — Correct editor scheduling policy and serialization.** Honor the resolved settings zone; preserve weekday/month-day restrictions; implement the promised 45-minute cadence; validate the expanded eight-listener limit.

## Decisions to make before implementation

- **S1 — Interval contract.** Recommend independent listener cadence with stable per-listener anchors; manual/event runs should not reset scheduled cadence. Recommend rejecting combinations that violate the documented five-minute floor and coalescing exact simultaneous occurrences once. These are scheduling-contract decisions, not evidence that cron-parser's standard semantics should change.
- **V1 — Import policy.** Decide which API caps and high-volume listener guardrails also apply to file-authored routines, and how existing configurations migrate. Treat unknown callback IDs and invalid regexes as explicit validation errors. The probes did not establish an external authorization vulnerability.
- **R1 — Uncertain creation forms.** Reusing a key should return its original receipt. Changed inputs after uncertain success should produce a conflict/recovery path that locates and updates the created routine; do not blindly rotate the key and create another job.

## Claims to narrow or defer

Invalid definitions are soft-deleted reversibly; this is not deletion of execution data. Quarantine/error semantics deserve improvement, but continuing old instructions after an invalid edit is not an automatic fix. The delete-rollback case eventually performs the user's requested delete, so it is an acknowledgement-consistency concern rather than a separate wrong-intent deletion defect.

The fifty-routine starvation case depends on repeated runtime rewinds and should be retested after C2. The helper-zone probe is a repair constraint, not an additional current call-site failure. Unknown callback IDs and an archived active DM are injected/internal fault states. Keep their validation/isolation lessons without claiming ordinary product reachability or an authorization exploit.

**H1 — Low-priority accuracy:** event-vs-schedule history labels, month-restricted summary text, and descriptions naming only the first schedule. Their reproductions are useful but lower priority than wrong execution, lost definitions, or blocked recovery.

## Every reported scenario

Each row maps the observed behavior to a fix scope. Repeated workstream codes intentionally group several scenarios under one shared change.

### extent

Reproduction: [repro-issue-275-extent.ts](../../scripts/repro-issue-275-extent.ts).

| Case | Reported scenario | Decision | Workstream | Assessment |
| --- | --- | --- | --- | --- |
| 1 | daily schedules | Include in #275 | C1 | Same first-time-listener calculation defect; this is a scope variant, not an independent bug. |
| 2 | weekly plus daily | Include in #275 | C1 | Same first-time-listener calculation defect; this is a scope variant, not an independent bug. |
| 3 | pinned schedules in different zones | Include in #275 | C1 | Same first-time-listener calculation defect; this is a scope variant, not an independent bug. |
| 4 | long interval before short interval | Include in #275 | C1 | Same first-time-listener calculation defect; this is a scope variant, not an independent bug. |
| 5 | calendar before interval | Include in #275 | C1 | Same first-time-listener calculation defect; this is a scope variant, not an independent bug. |
| 6 | phased intervals | Include in #275 | C1 | Same first-time-listener calculation defect; this is a scope variant, not an independent bug. |
| 7 | eight schedules | Include in #275 | C1 | Same first-time-listener calculation defect; this is a scope variant, not an independent bug. |
| 8 | non-time listener preceding the only time listener still schedules correctly | Control | none | The first time listener is found even when an event listener precedes it; event-only groups correctly have no next run. |
| 9 | one cron expression with multiple hours is unaffected | Control | none | Multiple hours inside one cron work; disabled routines correctly remain unscheduled. |
| 10 | later invalid and too-frequent schedules pass file validation but fail API validation | Include in #275 | C3 | Validate every listener through the same normalization used by the API, including the minimum interval. |
| 11 | API-created bot routine starts correct, then unchanged file sync corrupts nextRunAt | Include in #275 | C1/C2 | Confirms normal API-created routines are affected by unchanged file sync; same two core defects. |
| 12 | pause stays paused; resume of a single schedule is rewound to the paused period | Include in #275 | C2 | Sync overwrites a valid runtime scheduling decision with historical file state. Preserve durable cadence and occurrence state. |
| 13 | editing a single schedule is rewound to before the edit | Include in #275 | C2 | Sync overwrites a valid runtime scheduling decision with historical file state. Preserve durable cadence and occurrence state. |
| 14 | downtime catch-up is undone for single cron; historical occurrences run again on later passes | Include in #275 | C2 | Sync overwrites a valid runtime scheduling decision with historical file state. Preserve durable cadence and occurrence state. |
| 15 | downtime catch-up is undone for single interval; historical occurrences run again on later passes | Include in #275 | C2 | Sync overwrites a valid runtime scheduling decision with historical file state. Preserve durable cadence and occurrence state. |
| 16 | manual run shifts a single relative interval only after file sync | Include in #275 | C2 | The pre-/post-sync discrepancy is real. Recommend manual runs leave scheduled cadence unchanged; document that policy. |
| 17 | event delivery shifts a mixed routine's relative interval only after file sync | Include in #275 | C2 | Same discrepancy for event runs. Keep event history separate from the scheduled-cadence anchor. |
| 18 | timezone updates of a single unpinned cron are rewound by file sync | Include in #275 | C2 | Sync overwrites a valid runtime scheduling decision with historical file state. Preserve durable cadence and occurrence state. |
| 19 | invalid later file schedule aborts dispatch before a healthy unrelated routine | Include in #275 | C3 | Invalid later schedules also break failure recording. Quarantine the definition and keep unrelated routines dispatching. |
| 20 | group-owned multi-cron routine survives bot file sync and dispatches the second listener | Control | none | Group-owned calendar routines bypass bot file reconciliation; this bounds the original defect. |
| 21 | separate grouped-schedule validation gap: two valid listeners can fire less than five minutes apart | Policy decision | S1 | The combined schedule violates the documented five-minute floor. Recommend rejecting too-close combinations while coalescing exact coincidences. |
| 22 | a helper-only file-sync fix must pass the installation zone explicitly | Repair constraint | C1 | Pass the installation zone explicitly to the shared helper; its fallback can represent a pinned first listener. This is not another production failure. |
| 23 | separate helper limitation: relative grouped intervals lose the longer interval's cadence, including group owners | Policy decision | S1 | Independent relative schedules need stable listener-specific anchors. Recommend independent cadence; do not pretend a helper substitution supplies it. |

### chaos

Reproduction: [repro-issue-275-chaos.ts](../../scripts/repro-issue-275-chaos.ts).

| Case | Reported scenario | Decision | Workstream | Assessment |
| --- | --- | --- | --- | --- |
| 1 | a syntax error soft-deletes an existing routine even though its definition file still exists | Include in #275 | C3 | Soft deletion is reversible, not data deletion. Keep invalid definitions visible and disabled with an error; do not silently run obsolete instructions. |
| 2 | an unreadable automation file blocks the entire sync-then-dispatch pass repeatedly | Include in #275 | C3 | The structural file fault escapes the per-routine catch and aborts sync before dispatch. Isolate reads and advance recovery past bad folders. |
| 3 | an unreadable runs.json soft-deletes a routine whose automation.json is valid | Include in #275 | C2/C3 | History projection failure must not invalidate an otherwise valid authored definition. Recover or flag the ledger independently. |
| 4 | legacy schedule fallback silently strips all other listeners after a malformed group edit | Include in #275 | C3 | Apply legacy fallback only when no explicit trigger exists; never replace an explicitly invalid group with its first cron. |
| 5 | crash after dispatch commit but before file projection creates a permanent duplicate-key dispatch trap | Include in #275 | C2 | Stale projection rewinds a committed occurrence and repeatedly collides with its unique execution key. Same runtime-authority family. |
| 6 | ordinary concurrent reconciliation and dispatch can erase a committed run and poison future dispatch without any crash | Include in #275 | C2 | Real interleaving erases committed runtime state without any injected data corruption. Same authority/coordination defect. |
| 7 | create rollback leaves an active ghost routine; retrying the same call ID creates a duplicate | Separate fix | D1 | Rollback plus file import loses request identity, and retry creates two active jobs. Add durable operation/projection recovery. |
| 8 | delete rollback removes the file; later sync deletes the routine despite the DB rollback | Defer | D1 | The eventual delete still matches the requested operation. This establishes acknowledgement inconsistency, not a separate wrong-intent deletion bug. |
| 9 | control: overlapping executions record one skip and preserve its lastRunAt through sync | Control | none | Ordinary overlapping execution handling records one skip as intended. |
| 10 | 50 backlogged routines monopolize every dispatch page and create overlap skips while a healthy bot starves | Include in #275 | C2 | Starvation is driven by repeated historical rewinds. Fix that cause, then retest fairness before claiming another independent bug. |
| 11 | file import bypasses the 50-routines-per-owner API limit | Policy decision | V1 | API and file limits differ. Decide whether trusted file imports share the cap; preserve existing configurations through migration. |
| 12 | control: eight concurrent schedulers dispatch one occurrence exactly once | Control | none | The existing locks dispatch a single occurrence once across eight concurrent callers. |
| 13 | 100 live executions starve recovery of a completed execution on another routine | Separate fix | X4 | The unpaged 100-row recovery scan repeatedly selects live entries and overlooks terminal work. Rotate or paginate the scan. |
| 14 | year-old five-minute interval exceeds dispatch transaction timeout instead of catching up in constant time | Separate fix | S2 | Catch-up is linear in missed ticks; an independent capture confirmed Prisma P2028 here. Use arithmetic advancement; the timeout threshold is machine-dependent. |

### execution chaos

Reproduction: [repro-issue-275-execution-chaos.ts](../../scripts/repro-issue-275-execution-chaos.ts).

| Case | Reported scenario | Decision | Workstream | Assessment |
| --- | --- | --- | --- | --- |
| 1 | one unavailable event listener blocks delivery to a healthy bot on every retry | Separate fix | X4 | Per-listener error isolation is useful, but this fixture manually archives an active bot's DM. Normal retirement also disables its routines. |
| 2 | a group dispatch handoff failure leaves a queued round stuck until startup-style round recovery | Separate fix | X5 | After a post-commit advance error, periodic recovery leaves the queued room round untouched. Retry the handoff during recovery. |
| 3 | a late shell callback resumes an explicitly stopped and cancelled automation | Separate fix | X1 | A real late callback can pass Stop fences and queue a parent notification. Check root stop state at routing, claim and handoff. |
| 4 | a callback queued before WakeParent remains claimable after the automation handed off | Separate fix | X1 | Merge with terminal-context fencing. It proves unnecessary continuation; most dynamic tools already reject an ended handoff. |
| 5 | a callback with an unknown automation run ID is routed into the user-facing foreground | Separate fix | V1 | A fabricated ID in trusted callback input falls into the foreground route. Validate it; this is not evidence of external unauthorized access. |
| 6 | a failed batched continuation is marked successful because a folded newer run was marked completed | Separate fix | X2 | A completed folded receipt masks the failed processing turn. Derive outcome from the actual executing continuation and batch relationships. |
| 7 | an invalid Teams regex is accepted as enabled and silently never matches | Separate fix | V1 | Reject invalid patterns on save with a useful error. This is event validation, not the first-listener scheduling root. |
| 8 | one failed follow-up launch rolls back root settlement and blocks recovery for another bot | Separate fix | X4 | Cross-bot abort is the defect. Rolling back settlement with a failed follow-up is reasonable; isolate and retry each recovery item. |
| 9 | file imports bypass the API refusal of unscoped high-volume GitHub listeners | Policy decision | V1 | Share this policy across imports if required. File/API guardrail inconsistency is confirmed; an authorization bypass was not established. |

### final sweep

Reproduction: [repro-issue-275-final-sweep.ts](../../scripts/repro-issue-275-final-sweep.ts).

| Case | Reported scenario | Decision | Workstream | Assessment |
| --- | --- | --- | --- | --- |
| 1 | interval-first grouped schedules retain an invalid due time after a timezone change | Include in #275 | C4 | Time-zone recalculation is gated by the first-derived schedule kind. Recompute from all relevant listeners. |
| 2 | first timezone detection pins later floating schedules to the first pinned listener's zone | Include in #275 | C4 | A pinned first listener's zone is not the original installation zone for later floating listeners. Preserve each listener's semantics. |
| 3 | first timezone detection misses floating cron listeners when an interval is first | Include in #275 | C4 | Same first-derived metadata defect: migration misses floating calendar listeners behind an interval. |
| 4 | a long valid cron accepted by the schedule API is truncated and soft-deleted by file sync | Include in #275 | C3 | A valid accepted expression is truncated on import. Preserve it or reject consistently at input; never truncate executable configuration. |
| 5 | desktop prompt-only edit: Sunday represented as 7 becomes Saturday | Separate fix | U1 | Preserve the exact original trigger on unrelated edits instead of reconstructing a narrower schedule. |
| 6 | desktop prompt-only edit: a monthly-plus-weekly rule loses its weekday | Separate fix | U1 | Preserve the exact original trigger on unrelated edits instead of reconstructing a narrower schedule. |
| 7 | desktop prompt-only edit: an advanced rule loses its month-day constraint | Separate fix | U1 | Preserve the exact original trigger on unrelated edits instead of reconstructing a narrower schedule. |
| 8 | desktop edit makes a valid hourly */60 cron unsavable by clamping its step to 59 | Separate fix | U1 | Preserve the exact original trigger on unrelated edits instead of reconstructing a narrower schedule. |
| 9 | desktop prompt-only edit replaces an explicitly pinned schedule's timezone with the device zone | Separate fix | U1 | Preserve the exact original trigger on unrelated edits instead of reconstructing a narrower schedule. |
| 10 | desktop-generated triggers ignore a settings timezone override and stay pinned across later changes | Separate fix | U2 | Creation explicitly pins to the device zone, bypassing the configured override and later zone following. Use the user's resolved setting. |
| 11 | stale desktop presentation hides a file schedule edit and restores the old time on the next prompt edit | Separate fix | U1 | Invalidate or verify presentation when the authored trigger changes; stale UI metadata must not restore old scheduling instructions. |
| 12 | desktop prompt-only edit of a mixed event/time routine silently removes its event listener | Separate fix | U1 | Preserve the exact original trigger on unrelated edits instead of reconstructing a narrower schedule. |
| 13 | advanced every-N-days weekday restrictions still generate weekend runs | Separate fix | U3 | The day-step branch interacts with cron DOM/DOW OR semantics. Preserve selected restrictions or reject unsupported combinations. |
| 14 | two valid desktop cards can expand beyond the server's eight-listener limit | Separate fix | U3 | Validate expanded listeners, not just editor card count, and explain the limit before save. |
| 15 | group routine overlap protection ends while its background shell is still running | Separate fix | X5 | The persisted running-shell fixture shows missing overlap accounting. Add real shell lifecycle coverage before finalizing the fix. |
| 16 | control: bot routines retain overlap protection while a background shell is running | Control | none | Bot execution settlement correctly waits for its persisted pending background shell. |
| 17 | worker settlement rewrites event-run history as scheduled-run history | Defer | H1 | File history mislabels event executions as scheduled executions; runtime firing is unaffected. Low-cost accuracy follow-up. |
| 18 | sweep: desktop round trips introduce no failure classes beyond the minimized cases | Control | none | The Cartesian editor sweep found variants of already-minimized failures, not additional root causes. |
| 19 | sweep: independent calendar and phased-interval invariants, seed 275 | Control | none | Independent calendar/group/phased-interval oracle passed within its eight-day comparison horizon. |
| 20 | sweep: independent calendar and phased-interval invariants, seed 276 | Control | none | A second seed/date pass likewise found no additional timing mismatch in that corpus. |

### revision chaos

Reproduction: [repro-issue-275-revision-chaos.ts](../../scripts/repro-issue-275-revision-chaos.ts).

| Case | Reported scenario | Decision | Workstream | Assessment |
| --- | --- | --- | --- | --- |
| 1 | coalescing a new event changes a queued bot run's prompt without changing its recorded revision | Separate fix | X3 | The queued inbox executes a different prompt from its recorded immutable revision. Freeze it or explicitly transition the execution revision. |
| 2 | control: coalescing a group event preserves the queued execution's original instruction | Control | none | Group coalescing preserves the pending execution's saved prompt, supporting the intended snapshot invariant. |
| 3 | a prompt-only update resets a group interval's due time without any file reconciliation | Include in #275 | C2 | Even without files, metadata-only updates re-anchor relative intervals. Preserve next-run state when scheduling state did not change. |
| 4 | an uncertain create retried with edited input silently returns the original routine | Separate fix | R1 | Returning the original receipt for the same key is normal. Fix changed-payload conflict/recovery in the form/API; blind key rotation risks duplicates. |
| 5 | a UUID-shaped folder can make a different routine resolve when addressed by UUID | Separate fix | I1 | Resolve an existing UUID before slug fallback. The observed wrong winner depends on SQL plan/order; unguarded agent mutations are affected. |
| 6 | a run fired by a later schedule is described to the model as firing on the first schedule | Defer | H1 | The correct later-listener dispatch is isolated before sync overwrites it. Fix its misleading description alongside multi-schedule support; it is not another missed-run proof. |

### advanced cadence

Reproduction: [repro-issue-275-advanced-cadence.ts](../../scripts/repro-issue-275-advanced-cadence.ts).

| Case | Reported scenario | Decision | Workstream | Assessment |
| --- | --- | --- | --- | --- |
| 1 | Advanced Every 45 minutes alternates 45- and 15-minute gaps | Separate fix | U3 | Cron */45 is correct cron but does not implement an elapsed 45-minute promise. Change the editor representation or supported choices. |
| 2 | Advanced Every N days discards selected month days | Separate fix | U3 | Same day-step restriction-loss family as the weekday case. Do not count this as another independent bug. |
| 3 | Advanced summaries omit selected months | Defer | H1 | The actual month-restricted timing is correct; the summary is misleading. Fix as a small UI accuracy task. |

## Reproduction and limits

Run [run-issue-275-audit.ts](../../scripts/run-issue-275-audit.ts) with `OPENTEAM_TEST_DATABASE_URL` pointing to an empty disposable database with the current schema. [Raw results](../../scripts/repro-issue-275-results.json) record every suite result. The original [issue reproduction](../../scripts/repro-issue-275.ts) was also rerun. [Machine-readable dispositions](issue-275-triage.json) mirror the table.

A separate [timeout recheck](../../scripts/recheck-issue-275-timeout.ts) intercepted the original transaction exception without changing production behavior and confirmed Prisma P2028 (expired transaction) after the slow interval catch-up. Do not infer a universal one-year or five-second reproduction threshold from this machine.

The independent calendar oracle covers six zones and an eight-day matching horizon; sparse occurrences outside that horizon receive a bounds check. Real external-provider transport, model output, browser UI interactions and live production counts were not measured. Those limits matter particularly for the trusted malformed-callback fixture and persisted background-shell record.

## Source boundaries

The core change touches [automation file parsing](../../packages/messaging/src/automation-files.ts), [definition and runtime reconciliation](../../packages/messaging/src/agent-data.ts), and [routine scheduling and lifecycle](../../packages/messaging/src/routines.ts). Separate execution work belongs in [worker recovery and claiming](../../apps/worker/src/worker.ts), [automation results and callback routing](../../packages/messaging/src/automation-results.ts), and [group routine state](../../packages/messaging/src/group-routine-state.ts). Editor preservation and Advanced scheduling belong in [schedule conversion](../../apps/desktop/src/renderer/lib/routines.ts) and [the routine editor](../../apps/desktop/src/renderer/components/openteam/routine-panel.tsx).
