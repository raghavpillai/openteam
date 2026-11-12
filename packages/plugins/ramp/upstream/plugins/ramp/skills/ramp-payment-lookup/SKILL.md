---
name: ramp-payment-lookup
area: Bill Pay
supported_surfaces: [cli, mcp]
description: |-
  Look up vendor bill payments and verify payment status from the terminal.
  Use when: 'did we pay', 'payment status', 'check if paid', 'verify payment',
  'find invoice', 'bill lookup', 'was this bill paid', 'payment confirmation'.
  Do NOT use for: approving bills (use ramp-approval-dashboard), spend analysis
  across vendors (use ramp-spend-analysis), or uploading receipts (use ramp-complete-expenses).
---

## Non-Negotiables

- **Pass `--rationale` on every command** — it is a required field on these agent-tools (a non-empty string, max 1024 chars). With `--json`, supply it as a `"rationale"` key in the body. Omitting it returns `HTTP 422 (DEVELOPER_INVALID_SCHEMA)`, in both agent and human modes.
- Always search bills first with `--include_drafts=false`, then enrich submitted bills with `bills get` and `bills attachments` when available.
- Report exactly what the API returns. Don't infer payment state beyond what the status says.
- When checking whether a payment went out, search with `--include_paid` to include completed bills.
- Pass `--agent` for machine-readable JSON output on all commands.
- Bill amounts in search and `get` responses are numeric major currency units (for example, dollars for USD). Never divide bill amounts by 100. Transaction amounts are formatted strings (`"$135.40"`). Reimbursement amounts are in dollars.
- Check `is_draft` on every search result. If a draft appears despite `--include_drafts=false`, use `bills draft` instead of `bills get`.
- For approval or modification history, use `bills history`; `bills get` does not include history.
- If `bills get` fails on a search-returned ID, fall back to the search results and note the limitation.

## Workflow

### Step 1: Search for the bill

```bash
ramp bills search --query "<vendor or invoice number>" --include_paid --include_drafts=false --limit 10 --agent --rationale "Search bills for the user"
```

The `--query` flag matches against payee name, invoice number, and payment ID. Partial matches work (e.g., "UPS" matches "UPS Store").

If too many results, narrow with more specific terms. If zero results, try alternate vendor name spellings.

If `next_page_cursor` is not null, paginate with `--page_cursor`:

```bash
ramp bills search --query "<vendor>" --include_paid --include_drafts=false --limit 10 \
  --page_cursor "<cursor>" --agent --rationale "Search bills for the user"
```

### Step 2: Drill into details

Check the search result's `is_draft` field. For a submitted bill (`is_draft=false`):

```bash
ramp bills get <bill_id> --agent --rationale "Review bill details"
```

This returns payment and bill metadata, but not approval history.

If a result unexpectedly has `is_draft=true`, route it to the draft command instead:

```bash
ramp bills draft --bill_id <bill_id> --agent --rationale "Review draft bill details"
```

For a draft, do not run `bills history` or `bills attachments`; both commands support submitted bills only. Drafts do not yet have submitted-bill approval history. For draft attachment requests, direct the user to the `bill_url` returned by `bills draft`, where attachments can be viewed.

Use `-n` (dry run) to preview the request without sending:

```bash
ramp bills get <bill_id> --agent -n --rationale "Review bill details"
```

### Step 3: Pull approval history for a submitted bill when requested

```bash
ramp bills history --bill_id <bill_id> --agent --rationale "Review bill approval history"
```

Use this dedicated command for approval-history or modification-history requests only when `is_draft=false`.

### Step 4: Pull the invoice attachment for a submitted bill

```bash
ramp bills attachments <bill_id> --agent --rationale "Fetch bill attachments"
```

For `is_draft=false`, this returns invoice files associated with the bill for cross-reference. For `is_draft=true`, use the `bill_url` from `bills draft` instead.

If `get` fails on a bill ID, `attachments` will likely fail too.

### Step 5: Present findings

Summarize clearly:

```
Bill found: DHL
  Invoice #: 24-165-12
  Amount: $1,287.95 USD
  Payment status: [status from API]
  Approval status: [status from API]
  Memo: Business package shipment and insurance
```

If the user wanted to confirm a payment went out, state explicitly whether the status confirms payment or not.

## Fields Available

### From `bills search`

| Field | Description |
|---|---|
| `id` | Bill UUID |
| `is_draft` | Whether the result is an unsubmitted draft; route true values to `bills draft` |
| `invoice_number` | Vendor invoice number |
| `vendor_name` | Payee name |
| `amount` | Numeric amount in major currency units; never divide by 100 |
| `currency` | Currency code |
| `due_date` | Payment due date (may be null) |
| `payment_status` | Payment state (may show "Unknown" for unpaid) |
| `approval_status` | Approval state |
| `memo` | Bill description |

### From `bills get` (when available)

Additional fields beyond search — exact schema depends on bill state. May include payment method and accounting metadata. Use `bills history` for approval history.

## Example Session

```
User: Did we pay DHL this month?

Agent: Let me check.
> ramp bills search --query "DHL" --include_paid --include_drafts=false --limit 10 --agent --rationale "Search bills for the user"

Found 1 bill:
  DHL — Invoice #24-165-12
  Amount: $1,287.95 USD
  Payment status: PAID
  Approval status: APPROVED
  Memo: Business package shipment and insurance

Let me get full details.
> ramp bills get fe8e01ce-12a4-4512-bd27-da8a7432466d --agent --rationale "Review bill details"

Bill found: DHL
  Invoice #: 24-165-12
  Amount: $1,287.95 USD
  Payment status: PAID
  Payment method: ACH
  Payment date: Mon, 14 Apr 2026
  Approval status: APPROVED

Yes, DHL was paid $1,287.95 via ACH on April 14.

User: What about PwC?

Agent: > ramp bills search --query "PwC" --include_paid --include_drafts=false --limit 10 --agent --rationale "Check whether the PwC bill has been paid"

Found 1 bill:
  PwC — Invoice #231458926-12
  Amount: $15,000.00 USD
  Payment status: OPEN
  Approval status: PENDING
  Memo: Consulting Hours

This bill hasn't been paid yet — it's still pending approval.
Want me to pull the invoice attachment?
```

## When NOT to Use

- **Approving or rejecting bills** — use `ramp-approval-dashboard`
- **Analyzing spend across multiple vendors** — use `ramp-spend-analysis`
- **Uploading receipts** — use `ramp-complete-expenses`

## Gotchas

| Issue | Fix |
|---|---|
| Bill amount looks unexpectedly large | Treat it as major currency units and report it exactly; never divide by 100 |
| Search returns a result with `is_draft=true` | Use `ramp bills draft --bill_id <bill_id>` instead of `bills get` |
| User asks who approved a bill | Use `ramp bills history --bill_id <bill_id>`; `bills get` does not include approval history |
| `payment_method` only in `bills get` | Search results don't include payment method — drill into details to find ACH vs check vs wire |
| Something broken? | With the user's consent, run `ramp feedback "<user-approved message>"`. This sends only that message to Ramp support; omit secrets and diagnostic artifacts. |
