# Email draft notification fan-out — November 12, 2026

## Finding

The repeated messages in Compute Boss came from one bot continuation per settled email card. The inspected batch has 24 completed send actions, 24 distinct recipients and 24 distinct Gmail results; there is no evidence of duplicate email sends in this batch.

## Production evidence

Read-only inspection of the affected deployment, including PostgreSQL records and connector invocation results. Deployment addresses and internal record identifiers are omitted from this public report.

- Affected bot: Compute Boss.
- All times below are UTC on November 12, 2026.
- 24 email draft cards were created approximately 18:57:21–18:59:10. Each had a distinct recipient and ultimately reached `sent`.
- 24 completed `send_reviewed_email` send invocations returned distinct Gmail results with `SENT` labels. There were 48 verification invocations. No card carried a `sentUnder` automatic-approval marker.
- Sends completed between 18:57:36.859 and 18:59:36.456.
- Each card settlement created a separate `draft.response` inbox event and run: 24 events, 24 run IDs, one attempt each, all completed.
- The initial drafting run remained active until approximately 18:59:16, allowing the notification queue to accumulate.
- Those continuation runs produced 23 visible chat replies between 18:59:27.443 and 19:07:17.994: two partial-progress replies and 21 repetitions confirming all 24 were sent. One continuation did not post a visible reply.
- No pending or processing inbox events remained for this bot when inspected.
- Inspected server image: `ghcr.io/raghavpillai/openteam-server@sha256:f60a912709ec3b87d29aeac3fef34a8609ac3679bafe080a3257d08dd086aa66`.

## Cause

`ExternalDraftService.settle` records the card outcome and queues a `draft.response` continuation. The worker serializes foreground runs, but previously claimed these events individually. Each run received the generic instruction “An external message draft settled. Read its outcome context and continue.” Once the batch had finished sending, the backlog repeatedly read the same completed state and posted another completion summary. The existing worker batching path covered background revival events, not draft outcomes. The records do not indicate a send retry loop.

Outcome acknowledgement (`outcomeEchoed`) suppresses already-consumed card context, but does not retire the other queued continuation runs. That explains why acknowledging the completed cards did not stop the remaining generic prompts from waking the bot and eliciting more confirmations. Deduplication existed at the card-receipt level, while the redundant work was at the continuation-queue level.

A subsequent read-only server recheck confirmed the same totals: 24 completed sends, 48 verifications, 24 completed draft-response events with one attempt each, 23 visible replies from those runs, and zero active inbox events for this bot.

## Local remediation

The worker now folds ready, pending draft outcomes for the same bot and channel into one claimed continuation. Every card retains its individual outcome receipt. Folded inbox events and runs are completed transactionally and audited against the surviving run. The continuation is instructed to read outcomes together, give at most one useful update about newly settled drafts, and remain silent if already reported.

Follow-up Grokbot experiments across three fresh bots also informed the fix: wakes now carry explicit card/outcome IDs, state and routing context, and batching preserves every notice. This avoids losing card identity when another turn has already consumed ambient outcome context. A database regression covers same-subject cards after receipt acknowledgement. The [Grokbot investigation](grokbot-email-draft-behavior-2026-11-12.md) distinguishes live UI evidence from model-reported event text and documents Grokbot's own stale acknowledgement behavior under rapid discards.

This does not delay a lone discard or change approval rules. Outcomes arriving after a claim can still trigger a later continuation; the change coalesces the ready backlog, and the prompt discourages redundant confirmations.

Validation includes unit tests excluding other channels, ordinary user messages and processing events, plus a real PostgreSQL regression proving that 24 pending outcomes yield one claimed continuation and 23 completed folded receipts. Existing background revival tests also pass.

## Deployment state

No production state was changed during this investigation. The remediation is local and has not been deployed. The original queue had already drained; no remote cancellation was necessary.

An additional [opt-in A/B treatment](draft-notification-ab-2026-11-12.md) now tests stronger guarantees: separate context-delivery and visible-notification receipts, server-owned status text, and deduplication across tool calls and runs. Its controlled PostgreSQL failure tests pass. The default treatment percentage is zero, and no live traffic has been enrolled.
