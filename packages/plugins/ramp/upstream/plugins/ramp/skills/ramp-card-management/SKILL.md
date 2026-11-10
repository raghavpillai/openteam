---
name: ramp-card-management
area: Cards and Spend
supported_surfaces: [cli, mcp]
description: |-
  Inspect a user's actual card status, then activate or safely lock/unlock a
  card. Use for card status, card lock questions, physical card activation, and
  card lock/unlock actions. For cards locked by overdue tasks, use
  ramp-complete-tasks to resolve the sanction before re-checking the card.
---

# Card Management

## Non-Negotiables

- Use `ListCards` to inspect cards. Do not substitute a funds/spend-allocation
  listing: funds and cards are different entities.
- A card whose underlying lifecycle state is `ACTIVE` can still be locked and
  unable to spend. Never report spendability from lifecycle state alone.
- Treat `is_spendable`, `active_locks`, and `blocking_task_count` as the live
  effective status. Follow each lock's `remediation_action`; an overdue-task
  sanction routes to `ramp-complete-tasks` rather than repeated manual unlock.
- Pass `--agent` for machine-readable JSON output whenever you need to count
  or inspect returned fields programmatically.
- Report the fields returned by the API. Do not invent card lifecycle states.
- After every activation or unlock attempt, call `ListCards` again for the same
  cardholder and exact card UUID. Do not claim success until the postcondition
  reports `is_spendable: true`.

## Workflow

### Step 1: Inspect card status

MCP:

```text
ListCards(rationale="Inspect the user's card and effective lock status")
```

CLI:

```bash
ramp cards list --rationale "Inspect the user's card and effective lock status" --agent
```

In `--agent` mode the response is wrapped in the standard envelope. Card records
live in the returned `cards` array.

Admins and managers can inspect a visible employee's cards by passing that
cardholder's UUID. Resolve the UUID first, then pass `cardholder_user_uuid`.

```bash
ramp users org-chart --rationale "find the employee's user UUID" --agent
ramp cards list --cardholder_user_uuid "USER_UUID" --rationale "Inspect this employee's card and effective lock status" --agent
```

### Step 2: Interpret effective status

Match the intended card by its `id`, `last_four`, `display_name`, and cardholder.
Inspect its effective lock fields before acting:

- `is_spendable: false` means the card cannot spend even if `card_state` is
  `ACTIVE` or `is_locked` is false.
- `active_locks` lists every effective `CARD` or
  `SPEND_ALLOCATION_MEMBER` lock with its `lock_source` and
  `remediation_action`.
- `blocking_task_count` is the number of outstanding tasks blocking spending.
- `GET_ATTENTION_FEED`: load `ramp-complete-tasks`; do not use
  `LockOrUnlockCard` to bypass the sanction.
- `LOCK_OR_UNLOCK_CARD`: continue to the normal lock/unlock flow below.
- `UNLOCK_FRAUD_LOCKED_CARD`: use the fraud-specific unlock workflow returned
  by the tool. The existing result is `FraudLockDetected`.
- `CONTACT_RAMP`: stop automated unlock attempts and hand the returned lock
  details to Ramp support.

### Step 4: Activate a physical card

First call activation by the physical card's last four digits without
`--confirm_delivery`:

```bash
ramp cards activate --last_four 1234 --rationale "activate the user's new physical card" --agent
```

If the result says delivery confirmation is required, ask the user to confirm
that the physical card has arrived. Only after they confirm, retry with
`--confirm_delivery`:

```bash
ramp cards activate --last_four 1234 --confirm_delivery --rationale "user confirmed their physical card arrived" --agent
```

Do not ask about delivery or set `--confirm_delivery` unless the first call says
it is required.

### Step 5: Lock or unlock a card

Before locking, inspect and show the user the affected card, explain that
locking it will block all transactions until it is unlocked, and ask for
explicit confirmation. Run the lock command only after the user confirms.
Do not infer confirmation from a report of suspicious activity or a lost card.

Unlocking does not require confirmation.

Before unlocking, re-run `ListCards`. If any lock's `remediation_action` is
`GET_ATTENTION_FEED`, stop this manual flow and load `ramp-complete-tasks`. If
`is_spendable` is already true, report the live state without a redundant write.

Lock or unlock a card by its id. The id is a required positional argument:

```bash
ramp cards lock 7f3c0d2a-9b1e-4a55-8c21-0e9d6b2f4a10 --action lock --rationale "user lost their card" --agent
ramp cards lock 7f3c0d2a-9b1e-4a55-8c21-0e9d6b2f4a10 --action unlock --rationale "user found their card" --agent
```

After either write, re-run `ListCards` for the same cardholder. For unlock, the
postcondition passes only when the exact card reports `is_spendable: true`. A
successful unlock response, `is_locked: false`, or an underlying `ACTIVE`
lifecycle state is not sufficient.

If normal unlock returns `CardUnlockBlocked`, it is a typed failed precondition,
not a partial success. Report its `remaining_locks` and `blocking_task_count`;
the returned card remains `is_locked: true` and `is_spendable: false`. Follow
each remaining lock's remediation action instead of retrying the same unlock.

## Fields To Inspect

| Field | Meaning |
|---|---|
| `id` | Card UUID used for card actions |
| `last_four` | Last four digits used to identify the card |
| `display_name` | Card display name when returned |
| `card_type` | Physical Ramp card or virtual card |
| `card_state` | Underlying/effective lifecycle state; never sufficient alone to prove spendability |
| `activation_status` | Whether the card is active, pending delivery, awaiting confirmation, or blocked |
| `is_locked` | Live effective lock indicator |
| `is_spendable` | Authoritative result for whether the card can currently spend |
| `active_locks` | Effective locks, including `lock_type`, `lock_source`, and `remediation_action` |
| `blocking_task_count` | Number of attention-feed tasks currently blocking card spending |

## Example Session

```
User: Why can't I use my card?

Agent: > ramp cards list --rationale "Inspect the user's card and effective lock status" --agent

Agent: This card is locked by an overdue Ramp task. Its underlying lifecycle
state does not make it spendable. I'll load `ramp-complete-tasks`, resolve the
outstanding item with you, and then re-check this exact card before saying it is
unlocked.
```

## Gotchas

| Issue | Fix |
|---|---|
| Card lifecycle state is `ACTIVE`, but `is_spendable` is false | The card cannot spend; follow `active_locks[].remediation_action` |
| Remediation is `GET_ATTENTION_FEED` | Load `ramp-complete-tasks`; do not repeat manual unlock |
| `CardUnlockBlocked` | Report `remaining_locks` and `blocking_task_count`, then follow their remediation actions |
| Unlock call succeeded, but the re-check is not spendable | Report the remaining locks and do not claim success |
| Need another employee's cards | Resolve their user UUID and pass `cardholder_user_uuid` to `ListCards` |
| Something broken? | With the user's consent, run `ramp feedback "<user-approved message>"`. This sends only that message to Ramp support; omit secrets and diagnostic artifacts. |
