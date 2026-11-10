---
name: ramp-complete-expenses
area: Cards and Spend
supported_surfaces: [cli, mcp]
description: |-
  Find and complete requested revisions and missing items on your transactions —
  receipts, memos, accounting categories, funds, and attendees. Use when:
  'transaction revision requested', 'fix a rejected expense', 'missing receipts',
  'upload receipt', 'attach receipt', 'receipt sweep', 'add memo',
  'categorize transactions', 'missing items', 'transaction cleanup',
  'fix my transactions', 'set tracking category', 'assign to fund',
  'bulk memo update', 'receipt compliance'. Do NOT use for: approving
  transactions (use ramp-approval-dashboard), vendor documents like W-9s or
  contracts (use ramp-manage-vendors), or spend reporting (use ramp-spend-analysis).
---

## Non-Negotiables

- **Pass `--rationale` on every command** — it is a required field on these agent-tools (a non-empty string, max 1024 chars). With `--json`, supply it as a `"rationale"` key in the body. Omitting it returns `HTTP 422 (DEVELOPER_INVALID_SCHEMA)`, in both agent and human modes.
- Scope to the user's own transactions by default (`--transactions_to_retrieve my_transactions`) unless they explicitly request broader access.
- Only the acting cardholder can complete a transaction revision. Do not attempt
  revision completion as an admin, manager, or copilot on the cardholder's behalf.
- Show the transaction details before editing. Never blind-edit.
- Never upload a receipt without confirming the match — wrong receipt on wrong transaction is worse than no receipt.
- For bulk edits or receipt sweeps, present the plan and confirm before executing.
- Use `ramp transactions missing {uuid}` as the reliable check for whether a receipt is attached — it returns `missing_receipt: true/false` in real time. The `receipt_uuids` field in the list response can be used as a quick filter, but it may be stale (e.g., remaining null even after a successful upload+attach).
- CLI receipt uploads must be base64-encoded; accepted types are PNG, JPEG, PDF, HEIC, and WEBP.
- On MCP, never paste file contents or base64 into a tool call. Pick one path:
  - Chat app that shows an upload card (e.g. claude.ai): call `open-receipt-uploader`, even if the user already attached the file in chat — chat attachments can't reach Ramp.
  - Terminal agent with the file on disk (Claude Code, Cursor, Codex): call `request-receipt-upload-link` and run the returned `curl` (Step 6).
  - Neither: ask the user to upload in the Ramp web or mobile app, or email it to `receipts@ramp.com`.
- The `--user_submitted_fields` flag tracks provenance — include it to mark which fields the user explicitly provided vs agent-inferred.
- All CLI flags use **underscores**, not hyphens (e.g., `--start_at`, `--transaction_uuid`).
- `--start_at` takes an ISO 8601 datetime. Omit the offset (`2026-03-01T00:00:00`) for the user's local time in their Ramp profile time zone; add `Z` or an offset (`2026-03-01T00:00:00Z`) for an exact UTC instant.

## `--rationale` is required

Every command in this skill maps to an agent-tool endpoint that **requires** a
`rationale`: a non-empty string (max 1024 chars) explaining why you are making
the call. Pass it as `--rationale "..."`, or include a `"rationale"` key in the
`--json` body. It is required for **both** agent (`--agent`) and human
(`agent=false`) invocations — omitting it is the #1 cause of `HTTP 422` errors on
these tools. The examples below all include it; keep it on every call.

## Workflow

### Revision-request tasks

When `GetAttentionFeed` / `ramp tasks list` returns
`TRANSACTION_REVISION_REQUESTED`, preserve the task's transaction UUID and
revision request context. Inspect the live transaction, show the requested
changes, and get the cardholder's explicit confirmation before editing.

1. Fix every requested agent-editable field with the applicable workflow below.
   A successful field edit does not itself complete the revision request.
2. Re-read the transaction and its missing items. If a requested field still
   needs user-only work, give the user the returned Ramp link and stop; do not
   complete the revision prematurely.
3. Ask the cardholder for, or have them approve, a nonblank completion reason
   summarizing how the request was resolved.
4. Complete the revision for that same transaction.

MCP:

```text
CompleteTransactionRevision(
  transaction_uuid="{transaction_uuid}",
  reason="Added the requested receipt and corrected the department",
  rationale="Complete the cardholder's resolved transaction revision"
)
```

CLI:

```bash
ramp transactions complete-revision {transaction_uuid} \
  --reason "Added the requested receipt and corrected the department" \
  --rationale "Complete the cardholder's resolved transaction revision" --agent
```

Treat the success response's sanction-lift status `PENDING_VERIFICATION` as an
instruction to verify, not as evidence that a card is unlocked. Poll
`GetAttentionFeed` / `ramp tasks list` and `ListCards` with a finite bound (at
most three rechecks in the current run). On every attention-feed attempt, follow
every section's cursor chain until `next_cursor` is null and require the number
of unique hydrated task UUIDs to equal each section's `total_count`; otherwise
the attempt is incomplete and cannot prove the revision task is absent. If a
section's `total_count` changes between pages, restart that bounded attempt from
the first page rather than combining two snapshots. Success requires a fully
accounted feed in which the same revision task has disappeared
and the exact sanctioned card reports `is_spendable: true`. If the bound is
exhausted, report the live task, `active_locks`, and `blocking_task_count`; do
not say the revision restored card spending.

If revision completion returns:

- `CompleteTransactionRevisionNotFoundError`, re-check the transaction UUID
  from the task context.
- `CompleteTransactionRevisionPermissionDeniedError`, stop and explain that the
  acting cardholder must complete their own revision.
- `CompleteTransactionRevisionFailedPreconditionError`, re-read the attention
  feed and transaction state. This also covers a replay after the revision is
  already complete; do not retry it as a new completion event.
- `CompleteTransactionRevisionInternalError`, report that completion could not
  be verified and leave the task outstanding.

### Step 1: Find transactions needing attention

```bash
ramp transactions list --transactions_to_retrieve my_transactions \
  --start_at {start} --state cleared --rationale "Find transactions needing cleanup" --agent --page_size 50
```

For any transaction, check what's missing:

```bash
ramp transactions missing {transaction_uuid} --rationale "Check missing items on the transaction"
```

Returns `missing_receipt` (bool), `missing_memo` (bool), and `missing_accounting_items` (an array of objects, not category-name strings). Each object has this shape:

```json
{
  "category_name": "QuickBooks Online Department",
  "category_id": "category-uuid"
}
```

Present results grouped by what's missing:

```
Needs attention: 8 transactions ($4,520 total)

  Missing receipts (3):
    $1,200  United Airlines     2026-03-01
    $  800  Hilton Hotels       2026-03-03
  Missing memos (5): ...
  Missing accounting categories (2): ...
```

### Step 2: Fill memos

Before writing memos manually, check if Ramp has suggestions:

```bash
ramp transactions memo-suggestions {transaction_uuid} --rationale "Fetch AI-suggested memos"
```

Returns `memos[]` — an array of suggested memo strings based on the transaction context. Present suggestions and let the user confirm or edit, then:

```bash
ramp transactions edit {transaction_uuid} --memo "Q2 team offsite catering" --rationale "Add the user's memo"
```

To clear a memo, pass an empty string: `--memo ""` (note: `--rationale` itself must never be empty).

### Step 3: Assign to a fund/spend allocation

```bash
ramp transactions edit {transaction_uuid} --fund_uuid {fund_uuid} --rationale "Assign transaction to the chosen fund"
```

To find available funds:

```bash
ramp funds list --funds_to_retrieve MY_FUNDS --rationale "List funds to assign the transaction" --agent
```

### Step 4: Set tracking categories (accounting codes)

First, get available categories and their options:

```bash
# List categories
ramp accounting categories --rationale "List tracking categories" --agent

# List options for a specific category (use UUID from above)
ramp accounting category-options {tracking_category_uuid} --rationale "List options for the tracking category" --agent --page_size 50
```

Then edit via `--json` (tracking categories aren't exposed as named flags).

**Important:** When using `--json`, you must include both `rationale` and `transaction_uuid` in the body. The `--json` flag bypasses the CLI's automatic injection of the positional arg and the `--rationale` flag, so a `--json` body without a `"rationale"` key returns `HTTP 422`.

```bash
ramp transactions edit --json '{
  "rationale": "Set the tracking category the user chose",
  "transaction_uuid": "{transaction_uuid}",
  "tracking_category_selections": [
    {
      "category_uuid": "{category_uuid}",
      "option_selection": "{option_uuid}"
    }
  ],
  "user_submitted_fields": ["tracking_category_selections"]
}'
```

Note: the field names inside `tracking_category_selections` are `category_uuid` and `option_selection` — NOT `tracking_category_uuid` / `tracking_category_option_uuid` (those are the names returned by the categories list endpoint, not the edit endpoint).

### Step 5: Set attendees

```bash
ramp transactions edit --json '{
  "rationale": "Record attendees for this expense",
  "transaction_uuid": "{transaction_uuid}",
  "attendee_selections": {
    "non_ramp_attendees": [
      {"attendee_name": "Jane Smith", "attendee_email": "jane@company.com"}
    ],
    "include_self_as_attendee": false
  },
  "user_submitted_fields": ["attendee_selections"]
}'
```

### Step 6: Upload receipts

Only upload for transactions where a receipt is missing.

On MCP, pick one path:

- **Chat app with an upload card** (e.g. claude.ai): call `open-receipt-uploader` with the `transaction_uuid`, even if the file is already attached in chat.
- **Terminal agent with the file on disk** (Claude Code, Cursor, Codex): use `request-receipt-upload-link` (it may not be offered to every user):
  1. Call `request-receipt-upload-link` with the `transaction_uuid`.
  2. Run the returned `curl` command with the local file path.
  3. After a `201` response, confirm with `get-transaction-missing-items` that `missing_receipt` is `false`.

  Each link is single use and expires shortly, so check `expires_at` in the response; request one link per file. Never give the URL to the user.
- **Neither**: ask the user to upload in the Ramp web or mobile app, or email it to `receipts@ramp.com`.

For CLI callers, when the user has a receipt file and wants to attach it to a transaction:

```bash
# Base64 encode the file (agent does this)
# For a file at /path/to/receipt.pdf:
base64 -i /path/to/receipt.pdf | tr -d '\n'

# Upload and auto-attach in one step
ramp receipts upload \
  --content_type "application/pdf" \
  --filename "receipt.pdf" \
  --file_content_base64 "{base64_string}" \
  --transaction_uuid {txn_uuid} --rationale "Upload the receipt"
```

The response returns `receipt_uuid` and `attached_to_transaction: true/false`.

Omitting `--transaction_uuid` uploads the receipt without attaching it. The CLI can attach it later with:

```bash
ramp receipts attach {receipt_uuid} {transaction_uuid} --rationale "Attach the receipt to the transaction"
```

**Bulk upload from a directory** of receipt images/PDFs:

```bash
# For each file:
# 1. Determine MIME type from extension (.pdf → application/pdf, .png → image/png, .jpg → image/jpeg)
# 2. Base64 encode: base64 -i <file> | tr -d '\n'
# 3. Match to a transaction by inferring merchant/date from filename or content
# 4. Upload with -n (dry run) first to verify

ramp receipts upload \
  --content_type "image/png" \
  --filename "uber-2026-03-01.png" \
  --file_content_base64 "{base64}" \
  --transaction_uuid {txn_uuid} -n --rationale "Upload the receipt"

# If correct, upload for real (without -n)
```

### Step 7: Handle missing receipts without a file

If the user doesn't have a receipt and wants to provide a reason:

```bash
ramp transactions explain-missing {transaction_uuid} --reason "Lost receipt — vendor confirmed purchase via email" --rationale "Record why the receipt is missing"
```

Or generate a link to the missing receipt affidavit form (the user must complete it manually in the browser):

```bash
ramp transactions flag-missing {transaction_uuid} --rationale "Generate a missing-receipt affidavit link"
```

## Receipt Matching Heuristics

When matching receipt files to transactions:

- **Filename patterns**: `merchant-YYYY-MM-DD.pdf`, `YYYY-MM-DD-merchant.png`, etc.
- **Amount matching**: If the receipt shows an amount, match to transactions within ±$1 at that merchant on that date.
- **Date matching**: Receipt date should be within 1-2 days of `transaction_time`.
- **One receipt per transaction**: Before each upload, re-check the live state with `ramp transactions missing {transaction_uuid}` and skip when `missing_receipt` is `false`. Do not rely on `receipt_uuids` from an earlier list response — it can be stale (see Gotchas) and would trigger a duplicate upload of a recently attached receipt.

Flag uncertain matches as "possible match — verify" rather than auto-uploading.

## MIME Type Reference

| Extension | Content type |
|---|---|
| `.png` | `image/png` |
| `.jpg`, `.jpeg` | `image/jpeg` |
| `.pdf` | `application/pdf` |
| `.heic` | `image/heic` |
| `.webp` | `image/webp` |

## Bulk Cleanup Workflow

For cleaning up many transactions at once:

1. Fetch all transactions in the period
2. Check `missing_items` on each (or batch-check via individual calls)
3. Group by what's missing: memo, accounting, receipt
4. Present summary: "12 transactions need memos, 5 need accounting categories, 3 need receipts"
5. For memos: fetch suggestions for each, present them, let user confirm or edit
6. For categories: if most transactions share a category, offer to bulk-apply
7. For receipts: match files per the heuristics above, dry-run first, confirm the plan
8. Execute sequentially, report progress

## Provenance Tracking

The `--user_submitted_fields` flag tells Ramp which fields the user explicitly provided. This matters for compliance — it distinguishes user intent from agent inference.

Include it when setting fields via `--json`:

```bash
ramp transactions edit --json '{
  "rationale": "Add the user's memo",
  "transaction_uuid": "{transaction_uuid}",
  "memo": "Client dinner with Acme team",
  "user_submitted_fields": ["memo"]
}'
```

Valid values: `attendee_selections`, `attendee_uuids`, `fund_uuid`, `memo`, `tracking_category_selections`, `trip_selection`.

When using named flags (`--memo`, `--fund_uuid`), provenance is tracked automatically.

## Pagination

If `pagination.next_cursor` is not null in the JSON envelope, there are more results:

```bash
ramp transactions list --transactions_to_retrieve my_transactions \
  --start_at {start} --state cleared --agent --page_size 50 \
  --next_page_cursor "{cursor}" --rationale "List the user's transactions"
```

## Example Session

```
User: I have a bunch of transactions that need cleanup

Agent: Let me check what's missing on your recent transactions.
> ramp transactions list --transactions_to_retrieve my_transactions \
>   --start_at 2026-03-01T00:00:00Z --state cleared --rationale "Find transactions needing cleanup" --agent --page_size 50

Found 8 transactions. Checking missing items on each...
> ramp transactions missing {uuid} --rationale "Check missing items" (×8)

Summary:
  5 need memos
  2 need accounting categories
  1 needs a receipt

Let me get AI-suggested memos for the 5:
> ramp transactions memo-suggestions {uuid} --rationale "Fetch suggested memos" (×5)

Transaction                              Suggested memo
$135  Facebook Ads     2026-03-02       "Q1 paid social campaign"
$220  AWS              2026-03-05       "March infrastructure costs"
$89   Uber             2026-03-10       (no suggestion)

Want to accept these suggestions, edit them, or write your own?

User: Accept Facebook and AWS. The Uber was a client dinner ride.

Agent: Updating 3 transactions:
> ramp transactions edit {fb-uuid} --memo "Q1 paid social campaign" --rationale "Apply accepted memo suggestion"
> ramp transactions edit {aws-uuid} --memo "March infrastructure costs" --rationale "Apply accepted memo suggestion"
> ramp transactions edit {uber-uuid} --memo "Client dinner transportation" --rationale "Set memo from user input"

Done. Now the receipt: United Airlines, $1,200 on 2026-03-05.

User: It's at ~/Downloads/united-mar5.pdf

Agent: > base64 -i ~/Downloads/united-mar5.pdf | tr -d '\n'
> ramp receipts upload --content_type "application/pdf" \
>   --filename "united-mar5.pdf" \
>   --file_content_base64 "{base64}" \
>   --transaction_uuid "abc-123" -n --rationale "Upload the receipt"

Dry run looks correct — uploading to United Airlines ($1,200) on 2026-03-05.
Proceed?

User: yes

Agent: > ramp receipts upload --content_type "application/pdf" ...
Receipt uploaded and attached (receipt_uuid: def-456).
2 transactions still need accounting categories — want to tackle those next?
```

## When NOT to Use

- **Approving or rejecting items** — use ramp-approval-dashboard
- **Vendor documents (W-9s, contracts, COIs)** — use ramp-manage-vendors
- **Company-wide spend reporting** — the CLI is scoped to your own data; use ramp-spend-analysis or the Ramp dashboard

## Gotchas

| Issue | Fix |
|---|---|
| `HTTP 422 "API error 422: There was an error."` | You omitted `rationale`. It's a required field on these agent-tools (`DEVELOPER_INVALID_SCHEMA`) — add `--rationale "..."`, or a `"rationale"` key in the `--json` body. Required for both agent and human (`agent=false`) calls. Not a permissions problem. |
| `--dry_run` succeeds but the real call 422s | `--dry_run` only prints the body; it does not validate it. Confirm `rationale` is present before sending. |
| `amount` is a formatted string ("$135.40") | Strip "$" and "," for numeric operations |
| `--state` values are lowercase | Use `cleared`, `pending`, `declined` — not uppercase |
| Tracking categories require `--json` | Named flags only cover `--memo` and `--fund_uuid`. When using `--json`, include both `rationale` and `transaction_uuid` in the body. |
| Category field names differ between endpoints | `accounting category-options` returns `tracking_category_option_uuid`, but `transactions edit` expects `category_uuid` + `option_selection` |
| `memo-suggestions` may return empty | Not all transactions have enough context for suggestions |
| `accounting category-options` paginates with integers | Unlike other endpoints, the cursor is a number, not a string |
| `--transactions_to_retrieve` is required | Always include it on `transactions list`. Use `my_transactions` for personal, `all_transactions_across_entire_business` for admin scope |
| Searching for specific transactions | Use `--reason_memo_merchant_or_user_name_text_search "query"` (min 3 chars) |
| Large receipt files may hit shell arg limits | CLI: for files >100KB, write base64 to a temp file and use `--json` with the content read from file. |
| Receipt uploads from MCP | Upload card shown: `open-receipt-uploader`. Terminal with the file on disk: `request-receipt-upload-link` + `curl`. Neither: Ramp web/mobile app or `receipts@ramp.com`. |
| Duplicate upload risk | Re-check `ramp transactions missing {uuid}` immediately before uploading; skip when `missing_receipt` is `false`. `receipt_uuids` alone can be stale. |
| Comment on a transaction | `ramp general comment {uuid} --ramp_object_type transaction --message "text" --rationale "Add a comment for the user"` |
