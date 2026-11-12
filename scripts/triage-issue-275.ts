// Generate the per-scenario disposition from the verified audit results.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const results = JSON.parse(await readFile(join(root, "scripts/repro-issue-275-results.json"), "utf8"));
type Decision = [string, string, string];
const core = (group: string, reason: string): Decision => ["Include in #275", group, reason];
const separate = (group: string, reason: string): Decision => ["Separate fix", group, reason];
const policy = (group: string, reason: string): Decision => ["Policy decision", group, reason];
const defer = (group: string, reason: string): Decision => ["Defer", group, reason];
const control = (reason: string): Decision => ["Control", "none", reason];
const first = core("C1", "Same first-time-listener calculation defect; this is a scope variant, not an independent bug.");
const state = core("C2", "Sync overwrites a valid runtime scheduling decision with historical file state. Preserve durable cadence and occurrence state.");
const editor = separate("U1", "Preserve the exact original trigger on unrelated edits instead of reconstructing a narrower schedule.");
const decisions: Record<string, Decision[]> = {
  "repro-issue-275-extent.ts": [
    first, first, first, first, first, first, first,
    control("The first time listener is found even when an event listener precedes it; event-only groups correctly have no next run."),
    control("Multiple hours inside one cron work; disabled routines correctly remain unscheduled."),
    core("C3", "Validate every listener through the same normalization used by the API, including the minimum interval."),
    core("C1/C2", "Confirms normal API-created routines are affected by unchanged file sync; same two core defects."),
    state, state, state, state,
    core("C2", "The pre-/post-sync discrepancy is real. Recommend manual runs leave scheduled cadence unchanged; document that policy."),
    core("C2", "Same discrepancy for event runs. Keep event history separate from the scheduled-cadence anchor."),
    state,
    core("C3", "Invalid later schedules also break failure recording. Quarantine the definition and keep unrelated routines dispatching."),
    control("Group-owned calendar routines bypass bot file reconciliation; this bounds the original defect."),
    policy("S1", "The combined schedule violates the documented five-minute floor. Recommend rejecting too-close combinations while coalescing exact coincidences."),
    ["Repair constraint", "C1", "Pass the installation zone explicitly to the shared helper; its fallback can represent a pinned first listener. This is not another production failure."],
    policy("S1", "Independent relative schedules need stable listener-specific anchors. Recommend independent cadence; do not pretend a helper substitution supplies it."),
  ],
  "repro-issue-275-chaos.ts": [
    core("C3", "Soft deletion is reversible, not data deletion. Keep invalid definitions visible and disabled with an error; do not silently run obsolete instructions."),
    core("C3", "The structural file fault escapes the per-routine catch and aborts sync before dispatch. Isolate reads and advance recovery past bad folders."),
    core("C2/C3", "History projection failure must not invalidate an otherwise valid authored definition. Recover or flag the ledger independently."),
    core("C3", "Apply legacy fallback only when no explicit trigger exists; never replace an explicitly invalid group with its first cron."),
    core("C2", "Stale projection rewinds a committed occurrence and repeatedly collides with its unique execution key. Same runtime-authority family."),
    core("C2", "Real interleaving erases committed runtime state without any injected data corruption. Same authority/coordination defect."),
    separate("D1", "Rollback plus file import loses request identity, and retry creates two active jobs. Add durable operation/projection recovery."),
    defer("D1", "The eventual delete still matches the requested operation. This establishes acknowledgement inconsistency, not a separate wrong-intent deletion bug."),
    control("Ordinary overlapping execution handling records one skip as intended."),
    core("C2", "Starvation is driven by repeated historical rewinds. Fix that cause, then retest fairness before claiming another independent bug."),
    policy("V1", "API and file limits differ. Decide whether trusted file imports share the cap; preserve existing configurations through migration."),
    control("The existing locks dispatch a single occurrence once across eight concurrent callers."),
    separate("X4", "The unpaged 100-row recovery scan repeatedly selects live entries and overlooks terminal work. Rotate or paginate the scan."),
    separate("S2", "Catch-up is linear in missed ticks; an independent capture confirmed Prisma P2028 here. Use arithmetic advancement; the timeout threshold is machine-dependent."),
  ],
  "repro-issue-275-execution-chaos.ts": [
    separate("X4", "Per-listener error isolation is useful, but this fixture manually archives an active bot's DM. Normal retirement also disables its routines."),
    separate("X5", "After a post-commit advance error, periodic recovery leaves the queued room round untouched. Retry the handoff during recovery."),
    separate("X1", "A real late callback can pass Stop fences and queue a parent notification. Check root stop state at routing, claim and handoff."),
    separate("X1", "Merge with terminal-context fencing. It proves unnecessary continuation; most dynamic tools already reject an ended handoff."),
    separate("V1", "A fabricated ID in trusted callback input falls into the foreground route. Validate it; this is not evidence of external unauthorized access."),
    separate("X2", "A completed folded receipt masks the failed processing turn. Derive outcome from the actual executing continuation and batch relationships."),
    separate("V1", "Reject invalid patterns on save with a useful error. This is event validation, not the first-listener scheduling root."),
    separate("X4", "Cross-bot abort is the defect. Rolling back settlement with a failed follow-up is reasonable; isolate and retry each recovery item."),
    policy("V1", "Share this policy across imports if required. File/API guardrail inconsistency is confirmed; an authorization bypass was not established."),
  ],
  "repro-issue-275-final-sweep.ts": [
    core("C4", "Time-zone recalculation is gated by the first-derived schedule kind. Recompute from all relevant listeners."),
    core("C4", "A pinned first listener's zone is not the original installation zone for later floating listeners. Preserve each listener's semantics."),
    core("C4", "Same first-derived metadata defect: migration misses floating calendar listeners behind an interval."),
    core("C3", "A valid accepted expression is truncated on import. Preserve it or reject consistently at input; never truncate executable configuration."),
    editor, editor, editor, editor, editor,
    separate("U2", "Creation explicitly pins to the device zone, bypassing the configured override and later zone following. Use the user's resolved setting."),
    separate("U1", "Invalidate or verify presentation when the authored trigger changes; stale UI metadata must not restore old scheduling instructions."),
    editor,
    separate("U3", "The day-step branch interacts with cron DOM/DOW OR semantics. Preserve selected restrictions or reject unsupported combinations."),
    separate("U3", "Validate expanded listeners, not just editor card count, and explain the limit before save."),
    separate("X5", "The persisted running-shell fixture shows missing overlap accounting. Add real shell lifecycle coverage before finalizing the fix."),
    control("Bot execution settlement correctly waits for its persisted pending background shell."),
    defer("H1", "File history mislabels event executions as scheduled executions; runtime firing is unaffected. Low-cost accuracy follow-up."),
    control("The Cartesian editor sweep found variants of already-minimized failures, not additional root causes."),
    control("Independent calendar/group/phased-interval oracle passed within its eight-day comparison horizon."),
    control("A second seed/date pass likewise found no additional timing mismatch in that corpus."),
  ],
  "repro-issue-275-revision-chaos.ts": [
    separate("X3", "The queued inbox executes a different prompt from its recorded immutable revision. Freeze it or explicitly transition the execution revision."),
    control("Group coalescing preserves the pending execution's saved prompt, supporting the intended snapshot invariant."),
    core("C2", "Even without files, metadata-only updates re-anchor relative intervals. Preserve next-run state when scheduling state did not change."),
    separate("R1", "Returning the original receipt for the same key is normal. Fix changed-payload conflict/recovery in the form/API; blind key rotation risks duplicates."),
    separate("I1", "Resolve an existing UUID before slug fallback. The observed wrong winner depends on SQL plan/order; unguarded agent mutations are affected."),
    defer("H1", "The correct later-listener dispatch is isolated before sync overwrites it. Fix its misleading description alongside multi-schedule support; it is not another missed-run proof."),
  ],
  "repro-issue-275-advanced-cadence.ts": [
    separate("U3", "Cron */45 is correct cron but does not implement an elapsed 45-minute promise. Change the editor representation or supported choices."),
    separate("U3", "Same day-step restriction-loss family as the weekday case. Do not count this as another independent bug."),
    defer("H1", "The actual month-restricted timing is correct; the summary is misleading. Fix as a small UI accuracy task."),
  ],
};

const rows: any[] = [];
for (const suite of results.suites) {
  const outcomes = suite.summary.outcomes;
  assert(outcomes && outcomes.length === decisions[suite.suite]?.length, `Unmapped scenario: ${suite.suite}`);
  assert.equal(suite.exitCode, 0);
  outcomes.forEach((outcome: any, index: number) => {
    assert.equal(outcome.result, "confirmed");
    const [decision, workstream, reason] = decisions[suite.suite]![index]!;
    rows.push({ suite: suite.suite, case: index + 1, scenario: outcome.name, reproduction: "Observed on rerun", decision, workstream, reason });
  });
}
const totals: Record<string, number> = {};
for (const row of rows) totals[row.decision] = (totals[row.decision] ?? 0) + 1;
const directory = join(root, "docs/development");
await mkdir(directory, { recursive: true });
await writeFile(join(directory, "issue-275-triage.json"), JSON.stringify({ testedCommit: results.testedCommit, interpretation: "Rows are scenarios, not independent bugs. Reproduction validates observed behavior; the decision evaluates usefulness and scope.", totals, rows }, null, 2) + "\n");

let md = `# Routine defect triage\n\nIssue [275](https://github.com/raghavpillai/openteam/issues/275) is real. Its useful initial fix is all-listener scheduling plus durable runtime-state ownership across file reconciliation. Several earlier reports are variants, controls, or separate execution/editor problems. They should not become one oversized patch.\n\nTested commit: \`${results.testedCommit}\`. The original issue reproduction and all six preserved suites reran against disposable PostgreSQL. The ${rows.length} rows below include controls and generated sweeps; they are not ${rows.length} independent defects. Passing characterization assertions means the described behavior reproduced, not that production is healthy. Queue transport and model/computer execution are stubbed; the real scheduler, file sync, messaging, claim and recovery code run where specified.\n\n## Initial routines fix\n\n1. **C1 — Compute across the entire trigger.** Normalize every listener, take the earliest occurrence, and pass the installation zone explicitly. Keep legacy first-schedule fields as presentation/fallback metadata only.\n2. **C2 — Preserve authoritative runtime state.** Files may author definitions, but an unchanged or stale projection must not overwrite committed next-run, last scheduled occurrence, or cadence state. Preserve cadence on name/prompt-only saves. Make existing-occurrence recovery idempotent.\n3. **C3 — Validate and isolate import failures.** Reuse full-trigger validation, preserve accepted cron text, and isolate every file read/parse failure. Keep invalid definitions visible and disabled with an error. Treat history-file errors independently; do not silently execute obsolete last-good instructions.\n4. **C4 — Remove first-listener assumptions from zone handling.** Consider every calendar listener during changes and initial migration. A pinned first listener must not determine another listener's old floating zone.\n5. **Repair existing state.** Provide an idempotent reconciliation of affected routines and occurrence records, including future due times incorrectly pointing to the first listener. Preview the changes, preserve execution history and intentional pauses, and avoid recreating already-recorded occurrences.\n\nAccept this change only after bot-created and UI-created multi-schedule routines fire every expected occurrence across sync/restart, and resume/edit/downtime/zone changes cannot rewind runtime state. Re-run the existing starvation and duplicate-key cases after this correction before creating separate fairness fixes for those consequences.\n\n## Separate fixes worth scheduling\n\n- **U1 — Preserve editor definitions.** Save name/prompt changes without regenerating the trigger. Preserve pinned zones, Sunday aliases, compound calendar rules, and mixed listeners. Verify presentation against the current trigger.\n- **X1 — Fence terminal automation contexts.** A stopped root must block late callback routing, claims and parent notifications. Drop obsolete queued continuations after handoff.\n- **X2 and X3 — Record the execution that actually ran.** Folded receipts must not hide a failed processing turn; a queued execution must execute its recorded instruction revision.\n- **X5 — Recover group execution lifecycles.** Retry committed-but-unadvanced room rounds and account for background work before releasing overlap protection. Add a real shell lifecycle integration check to the persisted-shell reproduction.\n- **D1 — Make projection and retry recovery durable.** Preserve operation identity across rollback, import and retry so an uncertain create cannot become two active jobs. This needs journaling/reconciliation; shared locking alone cannot make files and SQL atomic.\n- **X4 — Bound and isolate recovery.** Rotate the recovery scan beyond 100 live entries and isolate each failed follow-up/listener. The archived-DM fan-out fixture is a fault state, not evidence that normal retirement leaves such listeners enabled.\n- **I1 — Resolve identity deterministically.** Prefer an existing UUID over a matching folder alias. A regression must assert UUID identity, not depend on which ambiguous row PostgreSQL happens to return.\n- **S2 — Advance intervals without iterating missed ticks.** The measured timeout is machine-dependent; the underlying linear catch-up is the defect.\n- **U2 and U3 — Correct editor scheduling policy and serialization.** Honor the resolved settings zone; preserve weekday/month-day restrictions; implement the promised 45-minute cadence; validate the expanded eight-listener limit.\n\n## Decisions to make before implementation\n\n- **S1 — Interval contract.** Recommend independent listener cadence with stable per-listener anchors; manual/event runs should not reset scheduled cadence. Recommend rejecting combinations that violate the documented five-minute floor and coalescing exact simultaneous occurrences once. These are scheduling-contract decisions, not evidence that cron-parser's standard semantics should change.\n- **V1 — Import policy.** Decide which API caps and high-volume listener guardrails also apply to file-authored routines, and how existing configurations migrate. Treat unknown callback IDs and invalid regexes as explicit validation errors. The probes did not establish an external authorization vulnerability.\n- **R1 — Uncertain creation forms.** Reusing a key should return its original receipt. Changed inputs after uncertain success should produce a conflict/recovery path that locates and updates the created routine; do not blindly rotate the key and create another job.\n\n## Claims to narrow or defer\n\nInvalid definitions are soft-deleted reversibly; this is not deletion of execution data. Quarantine/error semantics deserve improvement, but continuing old instructions after an invalid edit is not an automatic fix. The delete-rollback case eventually performs the user's requested delete, so it is an acknowledgement-consistency concern rather than a separate wrong-intent deletion defect.\n\nThe fifty-routine starvation case depends on repeated runtime rewinds and should be retested after C2. The helper-zone probe is a repair constraint, not an additional current call-site failure. Unknown callback IDs and an archived active DM are injected/internal fault states. Keep their validation/isolation lessons without claiming ordinary product reachability or an authorization exploit.\n\n**H1 — Low-priority accuracy:** event-vs-schedule history labels, month-restricted summary text, and descriptions naming only the first schedule. Their reproductions are useful but lower priority than wrong execution, lost definitions, or blocked recovery.\n\n## Every reported scenario\n\nEach row maps the observed behavior to a fix scope. Repeated workstream codes intentionally group several scenarios under one shared change.\n\n`;
const escape = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ");
for (const suite of results.suites) {
  md += `### ${suite.suite.replace("repro-issue-275-", "").replace(".ts", "").replaceAll("-", " ")}\n\nReproduction: [${suite.suite}](../../scripts/${suite.suite}).\n\n| Case | Reported scenario | Decision | Workstream | Assessment |\n| --- | --- | --- | --- | --- |\n`;
  for (const row of rows.filter(r => r.suite === suite.suite)) md += `| ${row.case} | ${escape(row.scenario)} | ${row.decision} | ${row.workstream} | ${escape(row.reason)} |\n`;
  md += "\n";
}
md += `## Reproduction and limits\n\nRun [run-issue-275-audit.ts](../../scripts/run-issue-275-audit.ts) with \`OPENTEAM_TEST_DATABASE_URL\` pointing to an empty disposable database with the current schema. [Raw results](../../scripts/repro-issue-275-results.json) record every suite result. The original [issue reproduction](../../scripts/repro-issue-275.ts) was also rerun. [Machine-readable dispositions](issue-275-triage.json) mirror the table.\n\nA separate [timeout recheck](../../scripts/recheck-issue-275-timeout.ts) intercepted the original transaction exception without changing production behavior and confirmed Prisma P2028 (expired transaction) after the slow interval catch-up. Do not infer a universal one-year or five-second reproduction threshold from this machine.\n\nThe independent calendar oracle covers six zones and an eight-day matching horizon; sparse occurrences outside that horizon receive a bounds check. Real external-provider transport, model output, browser UI interactions and live production counts were not measured. Those limits matter particularly for the trusted malformed-callback fixture and persisted background-shell record.\n\n## Source boundaries\n\nThe core change touches [automation file parsing](../../packages/messaging/src/automation-files.ts), [definition and runtime reconciliation](../../packages/messaging/src/agent-data.ts), and [routine scheduling and lifecycle](../../packages/messaging/src/routines.ts). Separate execution work belongs in [worker recovery and claiming](../../apps/worker/src/worker.ts), [automation results and callback routing](../../packages/messaging/src/automation-results.ts), and [group routine state](../../packages/messaging/src/group-routine-state.ts). Editor preservation and Advanced scheduling belong in [schedule conversion](../../apps/desktop/src/renderer/lib/routines.ts) and [the routine editor](../../apps/desktop/src/renderer/components/openteam/routine-panel.tsx).\n`;
await writeFile(join(directory, "issue-275-triage.md"), md);
console.log(JSON.stringify({ scenarios: rows.length, decisions: totals, markdown: "docs/development/issue-275-triage.md", json: "docs/development/issue-275-triage.json" }));
