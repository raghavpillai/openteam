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
