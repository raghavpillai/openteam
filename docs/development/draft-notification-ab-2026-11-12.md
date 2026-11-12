# Draft notification A/B experiment

The control is the local draft-outcome batching fix. The treatment adds durable user-notification receipts, one pending wake per conversation, and server-written status messages. This is a controlled fault-injection comparison, not a live-user or live-model experiment. Mail transport and model text are mocked; PostgreSQL queueing, claims, leases, message persistence, outcome receipts and notification outbox writes are real.

## Measured comparison

| Injected scenario | Control | Treatment |
| --- | --- | --- |
| 24 completions, lost response, new call IDs and replayed run | 24 queued wakes; 3 visible messages, including 2 duplicates | 1 queued wake; 1 visible message; no duplicates |
| Interruption after context delivery, restarted worker, deliberately silent model | No visible notification | One visible notification |
| Late outcomes and deliberately incorrect model counts | Two incorrect summaries persisted | Two accurate summaries; every outcome covered once |

Each scenario was executed once per arm with independent synthetic bot fixtures. These counts demonstrate the injected failure boundaries; they are not estimates of real-world duplicate, omission or hallucination rates. Both arms recorded exactly 24 mocked mail sends in the 24-completion case. No external emails or push notifications were transmitted.

The final database suite also verifies that notification messages, per-outcome receipts and a real push outbox row roll back together; concurrent publication produces one message/outbox entry; cancelled runs and invalid routing cannot publish; already-reported wakes do not block newer user input; ordinary user replies keep their content.

PR-readiness review added a regression for a queued replay that absorbs a genuinely new outcome. Queued work now binds to currently unreported outcomes when claimed, while an already-processing turn preserves its original identity snapshot during lease recovery. A further [fresh Grokbot comparison](grokbot-email-draft-behavior-2026-11-12.md#pr-comparison--fresh-fourth-bot) reproduces the same-subject/reverse-discard scenario in PostgreSQL. All twelve database tests pass (193 assertions), including exact-once coverage of the new outcome without changing the older receipt, distinct same-subject IDs and accurate final pending counts.

Machine-readable measurements: [JSON](assets/draft-notification-ab-2026-11-12.json). Inline comparison artifact: [HTML](assets/draft-notification-ab-2026-11-12.html).

## Treatment behavior

1. Every draft retains its existing outcome receipt and identity. Selected outcomes also carry `draftNotification.variant = treatment` in stored card metadata.
2. A conversation has at most one queued, unclaimed treatment wake, in addition to any active continuation. A fixed 300 ms collection window starts with the first outcome and is not extended by later actions. Card state updates remain immediate. An existing foreground run can still delay claiming the wake; 300 ms is not a promise of end-to-end notification latency.
3. Claiming records the outcome IDs in the durable inbox payload. Those IDs survive a stale lease and worker restart. A redundant pending wake with no unreported outcomes is completed without launching another model turn.
4. Before computer/model dispatch, the worker publishes a canonical status message. Its facts come from stored card states. The remaining-review/sending/unconfirmed counts explicitly describe all draft cards belonging to that bot in that chat, rather than guessing which older cards belong to the same task.
5. The visible message, notification activity/outbox and each covered outcome's `messageId`/`notifiedAt` commit in one transaction. Per-conversation locking and existing message uniqueness enforce deduplication; no schema migration is required. Multiple outcomes use one receipt update, and state counts are aggregated in PostgreSQL without loading historical email bodies.
6. `contextDeliveredAt` records runtime prompt delivery separately. Acknowledging context does not mark the user notification delivered. A stored notification is not a claim that the user has read it or that APNs has reached a device.
7. Model-generated text from a dedicated treatment `draft.response` continuation returns the canonical notification receipt instead of posting another status line. This also works with changed tool-call IDs. A replay whose outcomes are already reported cannot consume a later unrelated outcome. Normal user turns and other message types keep their existing behavior.

The model continuation still runs after the status is persisted, so remaining work can continue. Its free-form text status is suppressed by this experiment; additional conversational nuance or follow-up questions in that specific continuation will therefore not appear as separate text. This is a product tradeoff to evaluate before wider rollout. Approval rules, connector send authorization and draft cancellation tools are unchanged. Other event families are outside this experiment.

## Opt-in configuration and rollback

Set `OPENTEAM_DRAFT_NOTIFICATION_TREATMENT_PERCENT` on the **server process that settles draft outcomes**:

- Unset or `0`: control, the default.
- `50`: deterministic bot-level A/B assignment using the versioned SHA-256 cohort salt `draft-notifications-v1`.
- `100`: treatment for newly settled draft outcomes.
- Invalid values use control.

The worker reads the variant recorded in the durable wake, so it does not independently assign cohorts. Existing pending outcomes keep their recorded behavior if the percentage changes. Roll back by setting the server percentage to `0`; already-recorded treatment work drains with its deduplication rules intact.

No deployment configuration was changed, and no live traffic has been enrolled. Before enabling live A/B traffic, review status wording and the suppression of free-form text in notification continuations. Evaluate duplicate notifications, unreported outcome age, notification latency, and follow-up quality per cohort. A wider rollout should preserve correctness under real interruptions and late arrivals; the deterministic tests do not establish a live-model quality lift.

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
