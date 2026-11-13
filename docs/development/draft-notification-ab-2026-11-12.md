# Draft notification A/B experiment

The control is the local draft-outcome batching fix. The treatment adds durable user-notification receipts, one pending wake per conversation, and server-written status messages. The original measurements below describe the implementation merged in PR #309, before live testing exposed overbroad suppression of model text. They are controlled fault-injection results, not a live-user or live-model experiment. Mail transport and model text are mocked; PostgreSQL queueing, claims, leases, message persistence, outcome receipts and notification outbox writes are real.

## Original comparison before the follow-up delivery fix

| Injected scenario | Control | Treatment |
| --- | --- | --- |
| 24 completions, lost response, new call IDs and replayed run | 24 queued wakes; 3 visible messages, including 2 duplicates | 1 queued wake; 1 visible message; no duplicates |
| Interruption after context delivery, restarted worker, deliberately silent model | No visible notification | One visible notification |
| Late outcomes and deliberately incorrect model counts | Two incorrect summaries persisted | Two accurate summaries; every outcome covered once |

Each scenario was executed once per arm with independent synthetic bot fixtures. These counts demonstrate the injected failure boundaries; they are not estimates of real-world duplicate, omission or hallucination rates. Both arms recorded exactly 24 mocked mail sends in the 24-completion case. No external emails or push notifications were transmitted.

The final database suite also verifies that notification messages, per-outcome receipts and a real push outbox row roll back together; concurrent publication produces one message/outbox entry; cancelled runs and invalid routing cannot publish; already-reported wakes do not block newer user input; ordinary user replies keep their content.

PR-readiness review added a regression for a queued replay that absorbs a genuinely new outcome. Queued work now binds to currently unreported outcomes when claimed, while an already-processing turn preserves its original identity snapshot during lease recovery. A further [fresh Grokbot comparison](grokbot-email-draft-behavior-2026-11-12.md#pr-comparison--fresh-fourth-bot) reproduces the same-subject/reverse-discard scenario in PostgreSQL. Final merge validation passes thirteen database tests (223 assertions), including exact-once coverage of the new outcome without changing the older receipt, distinct same-subject IDs and accurate final pending counts.

The final integrated fixture executes the actual worker dispatch and projection flow after three discards, without another user message, in both variants. A local synthetic computer endpoint supplies model text and completion events; real PostgreSQL records run completion, input delivery and lease cleanup. Treatment is already visible before computer dispatch and remains visible when a later computer preflight returns 503, without creating an acknowledgement-redrive loop. This closes the worker-execution test gap; it is still not a live-model test.

The same review found and fixed stale settled-history fields when another device edits and sends a card while it is open. Desktop and iOS now use the stored receipt, and the real Electron fixture covers that mounted-component update in light/dark and wide/narrow combinations. Attachment runtime regressions verify byte staging, source preservation and cleanup on success, host rejection and a later missing file. Computer tests run from `apps/computer`, matching the workspace package script; workspace-root runs with local Bun 1.3.8 exhibited empty subprocess stdout in both email and the pre-existing iMessage fixture, while package-directory runs and direct runtime probes passed.

Machine-readable measurements: [JSON](assets/draft-notification-ab-2026-11-12.json). Inline comparison artifact: [HTML](assets/draft-notification-ab-2026-11-12.html).

## Follow-up delivery correction

Subsequent live testing reproduced two requested revision questions and an unrelated disk-pressure warning being replaced by the platform status receipt. The caller was told its text was sent even though the stored message contained different text. The correction preserves ordinary SendToUser delivery and reuses a status receipt only for its exact plain-text echo, without additional content or routing.

Exploratory runs also showed that avoiding a mandatory acknowledgement was insufficient: the model needed the published remaining-review count, and sometimes wrote its question as internal assistant text. The worker now supplies the exact published status and marks the acknowledged event through an optional private runtime field. If such a turn finishes with internal text and no actual send, it gets one conditional reminder to deliver outstanding questions or warnings; a status-only event may still finish silently. Other event families and ordinary user-turn reminders retain their existing behavior.

The final live matrix passed eight cases with fresh bots/sessions and 65 synthetic cards: two partial-discard/question trials, explicit warning delivery, a 24-card treatment burst, queued outcomes behind a busy foreground run, interruption during a live reply followed by a new user request, repeated discard plus invalid-recipient rejection, and the default control's 24-card burst. Every successful SendToUser receipt was checked against its actual stored text. Both requested questions were visible, explicit and ambient warnings were delivered, and the treatment burst emitted one platform status without another model status.

These runs used the configured Grok 4.7 model through OpenRouter and real runtime/worker/PostgreSQL paths. Card creation was seeded through the real draft service, mail transport was synthetic, queue claims were driven by the harness, and busy/interruption boundaries were deliberately gated. They do not measure production error rates, native UI or real push delivery. All temporary credentials and synthetic database records were removed. Production treatment configuration remains unset (zero).

Automated validation passed 174 tests (2,338 assertions), including fourteen PostgreSQL integration tests (257 assertions), runtime follow-up boundaries, real Pi loop behavior, cancellation, tapbacks, routing, exact status retries, and truthful follow-up receipts. Server/worker/computer type checks and builds, plus architecture checks, passed.

Evidence: [final live JSON](assets/draft-notification-followup-live-2026-11-12.json), [live comparison](assets/draft-notification-followup-live-2026-11-12.html), and [current fault-injection JSON](assets/draft-notification-followup-ab-2026-11-12.json). The original comparison above is historical; in particular its blanket suppression of deliberately incorrect model text is no longer the behavior of this implementation.

## Treatment behavior

1. Every draft retains its existing outcome receipt and identity. Selected outcomes also carry `draftNotification.variant = treatment` in stored card metadata.
2. A conversation has at most one queued, unclaimed treatment wake, in addition to any active continuation. A fixed 300 ms collection window starts with the first outcome and is not extended by later actions. Card state updates remain immediate. An existing foreground run can still delay claiming the wake; 300 ms is not a promise of end-to-end notification latency.
3. Claiming records the outcome IDs in the durable inbox payload. Those IDs survive a stale lease and worker restart. A redundant pending wake with no unreported outcomes is completed without launching another model turn.
4. Before computer/model dispatch, the worker publishes a canonical status message. Its facts come from stored card states. The remaining-review/sending/unconfirmed counts explicitly describe all draft cards belonging to that bot in that chat, rather than guessing which older cards belong to the same task.
5. The visible message, notification activity/outbox and each covered outcome's `messageId`/`notifiedAt` commit in one transaction. Per-conversation locking and existing message uniqueness enforce deduplication; no schema migration is required. Multiple outcomes use one receipt update, and state counts are aggregated in PostgreSQL without loading historical email bodies.
6. `contextDeliveredAt` records runtime prompt delivery separately. Acknowledging context does not mark the user notification delivered. A stored notification is not a claim that the user has read it or that APNs has reached a device.
7. Only an exact echo of the published status, with no additional content, attachments, reply target or routing, reuses its existing receipt. Questions, warnings, mixed status-plus-question text and other model messages are delivered normally with receipts identifying their actual stored text. A repeated tool call retains ordinary call-ID idempotency. A replay whose outcomes are already reported cannot consume a later unrelated outcome.
8. Once the worker has actually published or recovered the durable status receipt, it dispatches the continuation as an existing `event` request source, with a private `draftStatusAcknowledged` marker. This avoids the runtime's generic mandatory-reply nudges while allowing one conditional check for outstanding follow-up delivery. Control wakes still use the normal user-turn source. The prompt includes the exact already-published status so the model can use authoritative remaining-review counts, and explicitly preserves outstanding user requests.

The model continuation still runs after the status is persisted, so remaining work can continue. Live testing found that replacing all of its text silently lost revision questions and an unrelated runtime warning while falsely returning a sent receipt. The follow-up delivery fix removes that blanket replacement.

The platform notification remains database-derived and idempotent; arbitrary model prose is not a semantic status classifier. A differently worded model status is ordinary text, and can still contain model mistakes. The current fault-injection suite deliberately verifies that such text is not falsely acknowledged as a different canonical message: two injected incorrect model messages remain visible in both arms, alongside two accurate platform notifications in treatment. Instructions discourage redundant confirmations; they do not guarantee that arbitrary paraphrases are recognized. Approval rules, connector send authorization and draft cancellation tools are unchanged. Other event families are outside this experiment.

## Opt-in configuration and rollback

Set `OPENTEAM_DRAFT_NOTIFICATION_TREATMENT_PERCENT` on the **server process that settles draft outcomes**:

- Unset or `0`: control, the default.
- `50`: deterministic bot-level A/B assignment using the versioned SHA-256 cohort salt `draft-notifications-v1`.
- `100`: treatment for newly settled draft outcomes.
- Invalid values use control.

The worker reads the variant recorded in the durable wake, so it does not independently assign cohorts. Existing pending outcomes keep their recorded behavior if the percentage changes. Roll back by setting the server percentage to `0`; already-recorded treatment work drains with its deduplication rules intact.

No deployment configuration was changed, and no live traffic has been enrolled. Before enabling live A/B traffic, review status wording, correct delivery of requested follow-ups, and redundant model confirmations. Evaluate duplicate notifications, unreported outcome age, notification latency, and follow-up quality per cohort. A wider rollout should preserve correctness under real interruptions and late arrivals; the deterministic tests do not establish a live-model quality lift.

## Fresh state and progress updates

Further native Grokbot tests reproduced stale pending-state replies in three fresh bots after all 21 review cards were discarded. OpenBot's follow-up now reads current counts on dispatch and carries a private delivery-state revision through the worker, computer, and tool host. If state changes during inference, text is explicitly not delivered; the next model response receives fresh counts and can retry useful warnings or questions. Already-emitted sibling sends retain the old revision, and successful actions must not be repeated. This checks changing state rather than classifying or replacing model prose.

Consecutive treatment outcomes now update the latest progress message while cards remain pending. A new chat message, completed batch, or 10-second idle gap starts a new acknowledgement. Per-card receipts, edits, notification history, and queued push content commit together. Three controlled 120-card streams produced one progress row each, compared with 15–16 rows before, while the first acknowledgement still arrived in roughly 350ms. The computer-use check of the real desktop card component also verified invalid-recipient Send disabling, read-only reopening, and three discards updating one status row.

The [follow-up evidence](assets/draft-state-progress-2026-11-12.json) and [comparison](assets/draft-state-progress-2026-11-12.html) distinguish live-model, database, and component checks. The freshness protocol is optional for rolling compatibility: protection requires current worker, server, and computer versions. It does not validate arbitrary factual claims by the model. Live tests use an isolated database, synthetic transport, and harness-driven queue draining; no actual mailbox send, APNs delivery, deployment, or production flag change was performed. Progress updates remain in the opt-in treatment.

## Additional widget and race testing

A further pass found that structured question widgets bypassed the draft-state check. The failing database regression delivered a widget after the remaining cards were discarded. The existing guard now covers widgets as well as text, preserving call-ID receipt recovery. Permanent server tests cover rejection in both variants, refreshed delivery with changed card identities, and idempotent retry. A real Pi-loop test verifies that the next model response adopts the refreshed revision and delivers a still-useful widget.

Ten additional live-model scenarios passed with 65 synthetic cards: partial late discards and two successive refreshes in both variants, interruption, a busy foreground agent, repeated actions, a 24-card burst, and two widget cases. An obsolete widget was withheld when no cards remained; exactly one refreshed widget was delivered when one remained. Successful receipts matched the stored content. Five additional database diagnostics passed for equal counts with different identities, stale widgets, in-flight send completion, unconfirmed sends, and completed-turn replay with a later outcome.

The rerun suites passed 19 server tests (358 assertions) and 93 runtime tests (831 assertions). Together with the unchanged focused, attachment/tool-surface and stream checks from the preceding pass, the permanent matrix totals 180 tests and 3,230 assertions. The five temporary database diagnostics add 24 assertions separately. Server, worker and computer typechecks/builds and all architecture checks passed. This was an isolated runtime/database pass, not another native Grokbot or deployed UI trial. No external mail was sent and production treatment remained off. Sanitized measurements and limits: [additional evidence](assets/draft-state-widget-regression-2026-11-12.json).

## Cancellation and broad validation

The next pass reproduced two additional cancellation races. A draft reply waiting behind the draft lock could publish after its run had been cancelled. Publication now rechecks run state after that lock and holds a shared run-row lock until commit; an ended outcome turn receives an explicit non-retryable, not-delivered result. Tests cover text and widgets in both variants, and verify the opposite ordering: a publication already in progress commits before cancellation can return.

The broader real-worker integration also exposed queued cancellation deadlocking with claim. PostgreSQL recorded cancellation holding the run while waiting for inbox, and claim holding inbox while waiting for run. Queued cancellation now takes the worker's existing per-bot claim lock before either row. A controlled database test confirms that a winning claim transitions cancellation to the ordinary running-turn path. Thirty-two send/discard races, failed verification reopening, and repeated terminal actions are also covered.

Final validation uses repository-pinned Bun 1.4.2 in a temporary directory. The system's Bun 1.3.8 crashed vision fixtures and hung browser cleanup; those probes pass on 1.4.2. Each server, worker and computer test file ran in a fresh process, with separate disposable databases for database suites. This avoids the connection exhaustion and shared recovery interference seen in the exploratory all-in-one runs. Test fixtures now use active bots, current attachment/tool descriptions, and streaming HTTP acceptance before gated runtime work; these are corrections to existing tests, not new product capabilities.

Five further cancellation stress cycles passed all 30 case executions; these repetitions are not counted again in the unique matrix. The final matrix passed **3,080 tests**, including all enabled server, worker, messaging, computer, contracts and client/product-core checks. Separate startup/dispatch recovery tests were explicitly enabled and passed. **72 environment-specific checks remain skipped**, including Linux-only, configured live-browser, and authenticated deployed-server fixtures. Typechecks/builds for server, worker and computer and all architecture checks passed.

Four final live-model scenarios on Bun 1.4.2 passed with 24 synthetic cards: double refresh, obsolete widget suppression, useful widget retry, and lease recovery. Native Chrome computer-use checks of six real card components covered invalid Cc, empty To, long TLDs, forwarding/reply context, editable revision highlights, exact attachment preview bytes, discard, read-only reopening, and reload persistence. Pauses correctly created a new progress row; rapid subsequent discards updated it. No real email or APNs was sent, and production treatment remains off. The [full evidence and limits](assets/draft-lifecycle-stress-2026-11-12.json) distinguish these diagnostic checks from a production reliability guarantee.

## Durable discard and truthful retry receipts

A subsequent fault-injection pass found a split commit: discard saved `dismissed` before saving its outcome and wake. A queue failure could therefore leave the agent unaware of a discarded card. The state change, receipt, wake and update events now commit together. Tests inject failure after queue writes, check rollback of the run/message/wake as well as card state, exercise an already queued outcome, and retry in both variants.

Creation retries now recover their existing receipt before connector verification or attachment ingestion. The receipt reports the stored recipient and delivery state, including later review edits. This fixes changed retry arguments naming the wrong recipient and connector outages preventing recovery of a lost response. The model-facing formatter also distinguishes an existing pending, sending, sent, discarded, unknown or failed card from a newly created one. It preserves refusal and no-resend instructions. Eight concurrent retries produce one card, and a discarded card is not recreated.

Native computer-use testing additionally reproduced a successful discard displaying an error after its response was lost. The desktop card now checks the server result after discard errors and clears stale errors for confirmed terminal states. Delayed-response, real queue-failure, retry, normal discard and read-only reopening checks passed through the actual component. This UI correction is verified by native fault-injection; no new automated UI test was added.

The refreshed matrix passes **3,742 unique tests**, with **74 environment-specific checks skipped**. The draft integration suite contains 31 cases, including seven new cases; formatter coverage adds six recovered delivery states plus a legacy fallback in one test. Three further cycles passed all 21 fault-case executions without counting repetitions again. Full server, worker, computer, messaging, desktop, contracts and client/product-core checks were run, with isolated file reruns replacing failures caused by concurrent cold-build load. Separately enabled startup/dispatch recovery checks passed. A helper-output race in a host-bridge test was corrected to wait for complete JSON; production bridge behavior is unchanged.

Two final live-model cases passed in control/treatment with twelve synthetic cards after the production changes were complete. Four preceding exploratory live cases passed with another 37 cards. Builds and typechecks passed for server, worker, computer and desktop renderer, alongside all architecture checks. No external mail or real APNs was sent. [Evidence, test accounting and limits](assets/draft-durability-retries-2026-11-12.json) include the failing probes and final results; earlier reports remain historical.

## Mixed-version cancellation, terminal receipts and state labels

Further testing reproduced an old-client bypass: a reply without the optional draft revision skipped the active-run check. Cancellation now fences those requests before applying the optional snapshot comparison. Active legacy clients still work; they cannot detect snapshot drift without the revision. In-flight text and widget checks cover both variants, and two real-model interruption probes with the field removed produced no late replies.

Fresh automatic-send failures also fell through to editable-card wording. Failure receipts now preserve their actual reason, while unknown receipts explicitly say they do not confirm a send and forbid resending. Two live failed cases reported that nothing was sent. One initial unknown report still ambiguously said the draft “sent itself”; after refining the receipt, four new control/treatment probes clearly reported uncertainty without retrying. Inactive-turn receipts now retain the ended-turn instruction instead of suggesting another user message.

Native computer-use testing found an in-flight card labeled “Ready to send” and failed/unconfirmed cards labeled “Sent without review.” Desktop and iOS now say “Sending” while in flight and “Review skipped” unless the send is confirmed. The actual desktop component passed held-send, disabled-action, failed/unconfirmed read-only reopen and successful synthetic completion checks. These were native component checks, not a new automated UI test.

The latest isolated matrix passes **3,753 unique automated tests**, with **73 environment-specific checks skipped**. It includes 39 draft integration cases, eight new cases, and two new formatter tests. A seeded state machine checks review edits, terminal-state protection, receipt identity and transport-at-most-once; its expanded diagnostic run passed **1,088 operations across 32 trials and 192 cards**. Repetitions are counted separately. The native shortcut helper, built during desktop validation, now passes instead of being skipped. A memory test acknowledgement race and fake HTTP acceptance ordering were corrected without changing those production behaviors. A desktop fixture timeout passed both isolation and the fresh-process matrix.

Ten live-model scenarios used twenty synthetic cards: four initial terminal-receipt probes, four final unknown-receipt probes and two legacy-wire interruption probes. The initial ambiguous wording is recorded as a finding, not a semantic pass. No real email or APNs was sent. Extra opening acknowledgements and unrelated disk warnings remain possible; this work does not classify arbitrary model prose or prove a single-message guarantee. No fresh native Grokbot comparison was made in this pass.

Server, worker, computer and desktop typechecks/builds and architecture checks pass. **Two validation blockers remain:** the full iOS build fails in unchanged Siri code requiring iOS 27 APIs absent from this machine’s iOS 26.5 SDK; the modified Swift file passes syntax parsing. The desktop renderer gzip budget also fails at 4,470,256 bytes against 4,468,300. Rebuilding with the previous card source still measures 4,470,248, so the label change adds eight bytes. The budget was not raised. These failures prevent calling the entire branch fully green. [Latest evidence, accounting and limits](assets/draft-mixed-recovery-2026-11-12.json) supersede earlier numerical matrices.

## Timeout and late-completion testing — November 13

The next pass reproduced three more ordering bugs. A verification failure arriving after the sending timeout reopened an unconfirmed card. A successful verification could start transport after an unknown outcome had already committed. A refresh that paused during invocation lookup could settle a card that had reopened or moved to another send attempt.

Reopen now preserves terminal state. The dispatch decision rechecks the card under its existing mutation lock after verification and attachment preparation, before calling the connector. Refresh settlement checks the current state and the attempt it read. New sends use a private random attempt ID so identical wall-clock timestamps cannot confuse retries; legacy sending receipts still recover. These changes use existing card metadata and locks, with no migration, public tool or approval change. Connector execution remains outside the database lock. An operation already claimed or entered before timeout can still complete later; unknown is not a cancellation or recall.

All **47 draft integration cases and 31 adjacent cases pass** in this focused pass. Eight new tests contain 41 controlled fixture trials. The 24-case timeout matrix covers email and Slack, reviewed and automatic sends, both variants and late success/outage/account change. Further checks cover equal timestamps, late transport success/loss, delayed attachment preparation, missing bytes, archived/deleted cards and durable plugin invocation recovery after outcome-queue rollback. The latter uses the actual invocation claim/result storage with a fake transport; both current and legacy receipts recover one confirmed send without a second call. Three additional cycles passed all 24 repeated test executions; repetitions are not additional unique tests.

Native Chrome checks of the actual desktop component held two sends in verification, expired them, then released success/failure responses. Both remained read-only and unconfirmed with zero transport entries. The untouched third card discarded normally, producing one acknowledgement that correctly counted the two unconfirmed cards. Reload preserved all outcomes. The test used synthetic transport and aged stored timestamps, rather than waiting three real minutes.

Server typecheck/build and architecture checks pass. An initial full run timed out in two tests during heavy host load; the final full run passed without extending timeouts. The preceding 3,753-test broad matrix was not rerun. Its environment skips and iOS/desktop-budget failures remain recorded and were not revalidated here. No fresh live-model or native Grokbot comparison, real email/Slack send, APNs, deployment or production flag change occurred. [Evidence and explicit limits](assets/draft-timeout-recovery-2026-11-13.json).

## Connector-result recovery and stable account routes — November 13

Further probes found inconsistent recovery: unreadable completed connector results were labeled not delivered, while the same live result was unconfirmed. Empty objects and arrays could instead be counted as success. Recovery now preserves uncertainty for unreadable results, and the decoder rejects empty records and arrays. A completed result must also match the card’s bot, run, account and send tool before confirming a send. A synthetic mismatched record previously marked the card sent; it now remains unconfirmed without replay.

Pending cards now store the verified connection UUID so renaming an account cannot break or reroute a reviewed draft. Legacy namespace cards recover their original account only from unique, exact verification call receipts owned by the same bot/run. Reusing a namespace for another account cannot take over those cards. If provenance is missing or ambiguous, sending is refused and the card remains discardable. Revision matching uses the proven legacy route too, preserving highlights after renames. No schema, public tool, approval behavior or dependency changes are involved.

This focused pass passes **53 draft integration cases and 31 adjacent checks**. Six new tests contain forty scenario trials: invalid replies, current/legacy account routes, email/Slack namespace reuse, ownership mismatches, legacy revision highlighting and six valid success envelopes. Fresh automatic receipts and recovered cards agree on uncertainty. Successful recovery retains reviewed recipients, Cc, subject and body, with one outcome/wake and no replay. Three repeat cycles pass eighteen case executions separately from the unique count. Server typecheck/build and architecture checks pass.

Native Chrome checks on the actual card component confirm unreadable/wrong-tool records stay unconfirmed after late responses. A third synthetic send uses the original UUID after a replacement takes over its old name. Backend assertions verify the replacement and routing, while reload preserves all outcomes and one acknowledgement correctly counts two unconfirmed cards. An initial harness variable-shadowing bug meant its replacement account was not created; that claim was withdrawn and a corrected fresh three-card run passed. These checks use no real mail transport.

The [new evidence and limits](assets/draft-result-routing-2026-11-13.json) distinguish failing probes, final checks and the corrected harness. No fresh live-model/native Grokbot trial or real email/Slack/APNs delivery occurred. Earlier platform/budget failures and broad matrices remain historical and were not rerun in this server-focused pass.

## Parallel independent audits — November 13

At the user’s request, three subagents investigated connector results, lifecycle ordering and review-card behavior independently. They reproduced false success for JSON literals and malformed envelopes, partial SMTP acceptance counted as a complete send, lost confirmed outcomes after retirement, new queued work after retirement’s cancellation snapshot, stale review fields overwriting another device’s edits, and late Pending responses restoring controls on terminal cards. Parent probes also caught creation receipts borrowed across runs and legacy bindings trusting non-verification records.

The private decoder now separates JSON parsing from recursive validation, keeps opaque/numeric/exponent-looking IDs intact, validates MCP envelopes and metadata-only responses, and requires known email success evidence. SMTP must confirm all reviewed To/Cc recipients without rejections; ambiguous or partial delivery stays unknown without replay. Managed Slack’s opaque successful records remain compatible because no real remote send schema was verified.

Mutation and settlement now serialize on the existing agent lifecycle lock before card/notification locks. A known result arriving after retirement is saved without waking the archived owner. A settlement that wins first queues its wake before retirement’s cancellation snapshot. Creation recovery validates bot/run ownership; legacy account provenance requires exact, appropriate, successful verification calls rather than merely similar call IDs.

Desktop and iOS follow saved remote changes to pristine fields while preserving dirty local fields. Terminal outcomes remain authoritative over delayed responses. iOS suppresses lost-response errors after confirmed Sent/Discarded. The desktop retains Check delivery if refresh still reports Sending. No conflict-resolution API, approval behavior or public tool was added.

Final validation passes **754 unique automated checks**: 66 server/decoder/lifecycle, 33 adjacent contracts/client/worker/connector and 655 desktop checks. Fifteen permanent tests were added; twenty-one repeated regression executions are counted separately. One desktop environment-specific case remains skipped. The desktop files ran in fresh processes; final UI code-size cleanup also passed helper tests, component-hook assertions, typecheck and build. Server typecheck/build and architecture checks pass.

Native Chrome tests on the actual card component confirm pristine remote updates, dirty-body preservation, exact synthetic send packets, and a discarded card staying read-only after a stale Pending HTTP response. Reload preserves two sent cards and one discarded card, with three unique covered outcomes. There were two synthetic connector calls and no external transport. Pauses create two progress rows as intended.

Two checks remain blocked. The final desktop startup/raw limits pass at 1,330,294 and 17,867,905 bytes, but gzip fails at 4,470,492 against 4,468,300; no threshold was raised. Full iOS build fails in unchanged BarRegions.swift and SiriMessaging.swift; the modified Swift file passes syntax parsing, but no full iOS/runtime pass is claimed. [Independent findings, test accounting and limits](assets/draft-parallel-audit-2026-11-13.json) include failing reproductions and final evidence. No real email/Slack/APNs, deployment, production flag change, new live-model run or fresh native Grokbot comparison occurred.

## Original-incident acceptance and merge assessment — November 13

The final-source replay now targets the original failure boundary directly. Two fresh configured Grok/Pi/worker runs each hold a foreground model reply open while 24 reviewed synthetic emails finish in groups of 21, 2 and 1. Each arm records 24 distinct recipients, both Cc addresses, 48 verifications and 24 unique saved send results. No real email transport is registered. After releasing the foreground turn, both default/control and treatment execute one outcome continuation and produce one completion message. The original incident recorded 24 continuations and 23 outcome replies. The default reply also includes an unrelated disk-warning paragraph; this is not a claim that all model prose is silent or deterministic. Queue jobs are harness-driven and timing is compressed.

A new permanent regression checks that exact busy-lease/backlog ordering and the distinct saved sends. Eight targeted original/failure-boundary cases pass with 380 assertions on the final source. The earlier injected replay counterexample still matters: control produces three visible messages with two duplicates after new call IDs and a new outcome run, while treatment preserves one platform status. A silent model after a context-delivery crash can omit the control acknowledgement. Treatment is stronger for durable platform receipts; neither mode semantically filters every arbitrary model paraphrase.

Read-only production inspection still reports the original server image prefix `f60a912709ec`, with treatment unset. The PR has not been deployed and its fixes are not active there. GitHub reports a clean, mergeable PR with two successful WhatsApp connector jobs; those jobs do not validate this email flow.

The earlier iOS build assessment used the wrong local toolchain. The repository documents Xcode 27; a full simulator build now **passes with installed Xcode 27.1 / SDK 27.1**, using scoped `DEVELOPER_DIR` without changing the machine’s global selection. The old Xcode 26.6 failures are removed as a current merge blocker. The desktop gzip check still fails at 4,470,492 against 4,468,300, a 2,192-byte excess; thresholds are unchanged.

The reproduced original backlog is fixed in both arms. This is not a 100% reliability claim or unconditional whole-PR merge approval. The remaining size check and default-mode recovery behavior need explicit resolution, followed by a staged production rollout and monitoring. No deployment, production configuration, approval behavior or public tool changed. [Acceptance evidence and precise limits](assets/draft-original-acceptance-2026-11-13.json).

## Reproduction

Use an isolated PostgreSQL database initialized with the workspace schema:

```sh
OPENTEAM_TEST_DATABASE_URL=postgresql://... \
OPENTEAM_DRAFT_AB_REPORT=/tmp/openteam-draft-notification-ab.json \
bun test apps/server/test/external-draft.integration.test.ts --timeout 60000

bun test packages/messaging/test/draft-notifications.test.ts \
  apps/worker/test/draft-response-batch.test.ts \
  apps/worker/test/background-revival.test.ts
```

The A/B fixtures inject each variant directly without mutating the process environment. Pure tests verify stable cohort assignment and the default-off boundary. The database harness expires actual leases to simulate worker recovery, uses a new messaging instance after a lost response, injects a transaction failure before commit, and deliberately supplies silent or incorrect model behavior to both arms.
