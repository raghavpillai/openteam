---
name: ramp-complete-tasks
area: Cards and Spend
supported_surfaces: [cli, mcp]
description: |-
  Find and complete items in the Ramp attention feed. Use when: 'what needs my
  attention', 'show my tasks', 'overdue tasks', 'complete my Ramp tasks', 'why
  is my card locked', or a card is locked until required tasks are completed.
  For approval-only queues, use ramp-approval-dashboard.
---

# Complete Ramp Tasks

Use this skill to inspect the authenticated user's Ramp attention feed, route
each outstanding task to the correct workflow, and prove that completed tasks
and task-sanction card locks are actually cleared.

## Non-Negotiables

- Start from the live attention feed. Use the MCP tool `GetAttentionFeed` or
  `ramp tasks list`; do not infer outstanding tasks from an email, a prior
  response, or a card's lifecycle state.
- Pass a non-empty `rationale` on every Ramp tool call or CLI command.
- Show the task and proposed changes before any write, then get the user's
  explicit confirmation. Never mark a task complete merely to remove a card
  sanction.
- Treat `TRANSACTION_REVISION_REQUESTED` and other task types as routing keys.
  Satisfy the underlying task with its owning skill; do not dismiss, mutate, or
  relabel an unfamiliar task to make it disappear.
- A card whose underlying lifecycle state is `ACTIVE` can still be unspendable.
  `is_spendable`, `active_locks`, and `blocking_task_count` are authoritative;
  lifecycle state alone is not.
- Never report a task complete or a card unlocked from a successful write call
  alone. Poll the attention feed and, for a card sanction, `ListCards` with a
  finite retry bound. Success requires the task to disappear and the exact card
  to report `is_spendable: true`.

## 1. Read the Attention Feed

MCP:

```text
GetAttentionFeed(rationale="Find the user's outstanding Ramp tasks")
```

CLI:

```bash
ramp tasks list --rationale "Find the user's outstanding Ramp tasks" --agent
```

Inspect every returned section. Preserve `task_snapshot_uuid`, `task_type`, the
task's entity UUIDs, due date, revision reason, required fields, and any Ramp
link returned in `context`. For each section, accumulate unique
`task_snapshot_uuid` values across its complete cursor chain until
`next_cursor` is null before claiming the feed is complete:

```bash
ramp tasks list --json '{
  "rationale": "Continue reading the user's outstanding Ramp tasks",
  "sections": [{
    "section_type": "{section_type}",
    "cursor": "{next_cursor}",
    "limit": 20
  }]
}' --agent
```

After pagination, compare the number of unique hydrated items collected for
each section with that section's `total_count`. If the counts differ, hydration
silently omitted one or more outstanding tasks: treat the feed as incomplete,
retry the bounded read, and never interpret the missing context as completion.
If `total_count` changes while traversing the cursor chain, restart that bounded
attempt from the first page rather than combining two snapshots. Likewise, if
an item or section contains an error, say that the feed is incomplete and retry
that bounded item. Summarize work by task type and urgency only from a fully
accounted feed.

## 2. Dispatch by Task Type

| Task type | Workflow |
|---|---|
| `TRANSACTION_REVISION_REQUESTED` | Load `ramp-complete-expenses`. Review the revision request, correct the requested transaction fields, call `CompleteTransactionRevision` / `ramp transactions complete-revision` with the user's accepted nonblank reason, then perform both postcondition checks below. |
| `TRANSACTION_MISSING_ITEMS` | Load `ramp-complete-expenses`; fill only the missing receipt, memo, accounting, fund, trip, or attendee requirements. |
| Transaction, reimbursement, bill, or non-procurement request approval | Load `ramp-approval-dashboard`; show details and confirm before approving or rejecting. |
| Procurement approval, submitted request, PO status, or follow-up | Load `ramp-manage-procurement`. For a change request, require its `original_request` and complete `change_request_diff` old/new values before confirmation. |
| Procurement draft | Load `ramp-submit-procurement-request`. |
| Vendor document or onboarding task | Load `ramp-manage-vendors`. |
| Physical-card activation task | Load `ramp-card-management`. |
| Unknown or unsupported task type | Present the task context and returned Ramp link. Ask the user to complete it in Ramp; do not guess a mutation. |

One item can require multiple corrections. Keep its `task_snapshot_uuid` and
transaction/entity UUID attached to the workflow so a similarly named task is
not changed by mistake.

## 3. Handle a Task-Sanctioned Card

When a user asks why a card is locked or asks to unlock it:

1. Call `ListCards` before taking action. Identify the exact card by card UUID,
   cardholder, display name, and last four digits.
2. If `is_spendable` is true, report that live state. Do not call an unlock
   tool.
3. Inspect every entry in `active_locks`. When `remediation_action` is
   `GET_ATTENTION_FEED`, do not call manual card unlock. Read the attention feed
   and resolve its outstanding tasks through this workflow. Use
   `blocking_task_count` to report how many tasks still block spending.
4. For any other remediation action, return to `ramp-card-management`, which
   routes `LOCK_OR_UNLOCK_CARD`, `UNLOCK_FRAUD_LOCKED_CARD`, and `CONTACT_RAMP`.

The underlying `card_state` may be `ACTIVE` while a sanction lock is present.
Never use `card_state == ACTIVE` by itself as evidence that the card can spend.

## 4. Verify Postconditions

After the owning workflow reports success, use bounded polling (at most three
rechecks in the current run) with `GetAttentionFeed` / `ramp tasks list`. On
every attempt, traverse every returned section's complete cursor chain until
`next_cursor` is null, accumulate unique `task_snapshot_uuid` values, and
require the accumulated count to equal each section's `total_count` before
checking for the completed task's UUID or entity UUID.

- The task postcondition passes only when the completed item is absent from the
  outstanding feed (or the live response explicitly reports it completed).
- If a section's hydrated-item count differs from `total_count`, the attempt is
  incomplete and cannot prove absence.
- If a section's `total_count` changes between pages, restart that bounded
  attempt rather than combining pages from different feed snapshots.
- If the task is still present, report it as outstanding and include any newly
  returned reason or missing field. Do not claim success.

For a task-sanctioned card, poll `ListCards` within the same finite bound for the
same cardholder and card UUID. The combined postcondition passes only when the
task is absent and that exact card reports `is_spendable: true`. A successful
task write, `PENDING_VERIFICATION`, an absent lifecycle transition,
`is_locked: false`, or `card_state: ACTIVE` alone is insufficient.

If the task disappears but the card remains locked, report the remaining lock
state and reason. Do not loop manual unlock calls or say the card is spendable.

## Gotchas

| Issue | Required response |
|---|---|
| Empty first page with a section cursor | Follow the returned per-section pagination contract before concluding there are no tasks. |
| Task write returned success but item remains | Treat the task as outstanding; re-read its live context and report what remains. |
| `card_state` is `ACTIVE` while `is_spendable` is false | The card cannot spend; inspect `active_locks` and follow each `remediation_action`. |
| Task disappeared but `is_spendable` remains false | Report `active_locks` and `blocking_task_count`; do not claim the card was unlocked. |
| Unknown task type | Present its context and Ramp link for a user handoff; do not invent a completion call. |
