---
name: ramp-spend-analysis
area: Cards and Spend
supported_surfaces: [cli, mcp]
description: |-
  Analyze spend by vendor, category, or team over a date range. Broad AI-spend
  questions include both financial spend and estimated token cost.
  Use when: 'how much did we spend on', 'vendor spend', 'SaaS review', 'spend report',
  'AI spend', 'token spend', 'token usage', 'inference costs', 'total spend',
  'spend by vendor', 'spend analysis', 'pull transactions for', 'cost breakdown'.
  Do NOT use for: approving transactions (use ramp-approval-dashboard), uploading receipts
  (use ramp-complete-expenses), or verifying a single bill payment (use ramp-payment-lookup).
---

## Non-Negotiables

- For totals, trends, rankings, or breakdowns, use `ramp-reporting` when reporting commands are available.

- **Pass `--rationale` on every command** — it is a required field on these agent-tools (a non-empty string, max 1024 chars). With `--json`, supply it as a `"rationale"` key in the body. Omitting it returns `HTTP 422 (DEVELOPER_INVALID_SCHEMA)`, in both agent and human modes.
- Always query both **transactions** and **bills** when investigating complete vendor spend. Card charges and bill payments are separate resources — there is no unified spend endpoint.
- For a broad **AI, LLM, or inference spend** question, query token cost in addition to transactions and bills. Report these measures separately and never add them because they can overlap. If the user explicitly asks for card/Bill Pay or token data, query only that data source.
- Never treat a search result's bill `amount` as paid-in-period spend. It is the full invoice amount, and a payment-date match may represent only one partial payment. A complete paid total requires payment-allocation amounts and dates from another source.
- Pass `--agent` for machine-readable JSON output on all commands.
- Handle amount format differences: transactions use strings (`"$1,048.25"`, `"-$259.49"`), bills use numbers (`15000`), PO amounts use numbers. Reimbursement amounts are in dollars.
- Paginate until `next_page_cursor` is null — a single page may not return everything.
- Date-filter transactions with `--start_at` and `--end_at` (ISO 8601 datetimes; `--end_at` is exclusive). Add `Z` or an offset for an exact UTC window, as in exports and reconciliation: all of March UTC is `--start_at 2026-03-01T00:00:00Z --end_at 2026-04-01T00:00:00Z`. Omit the offset to use the user's local time in their Ramp profile time zone, as for "yesterday" or "last week": `--start_at 2026-03-01T00:00:00 --end_at 2026-04-01T00:00:00`. Use the same form for both bounds.
- Flag vendor name variants explicitly (e.g., "Delta Air Lines" vs "Delta Airlines") — the API does not normalize.
- Negative transaction amounts are refunds. Include them in totals but call them out.

## AI Token Cost

Run `ramp ai-spend` to see the available token-spend commands, then use the command that matches the requested scope.

## Workflow

### Step 1: Pull card transactions

For each vendor (or all vendors if doing a broad analysis):

```bash
ramp transactions list \
  --transactions_to_retrieve all_transactions_across_entire_business \
  --reason_memo_merchant_or_user_name_text_search "<vendor>" \
  --start_at <YYYY-MM-DDT00:00:00Z> \
  --end_at <YYYY-MM-DDT00:00:00Z> \
  --include_count \
  --page_size 200 \
  --agent --rationale "List the user's transactions"
```

If `next_page_cursor` is not null, paginate:

```bash
ramp transactions list \
  --transactions_to_retrieve all_transactions_across_entire_business \
  --reason_memo_merchant_or_user_name_text_search "<vendor>" \
  --start_at <YYYY-MM-DDT00:00:00Z> \
  --end_at <YYYY-MM-DDT00:00:00Z> \
  --page_size 200 \
  --next_page_cursor "<cursor>" \
  --agent --rationale "List the user's transactions"
```

**For broad analysis (all vendors):** Omit `--reason_memo_merchant_or_user_name_text_search` to pull all transactions, then group client-side.

### Step 2: Pull bill payments

For a specific vendor:

```bash
ramp bills search --query "<vendor>" --include_paid \
  --from_payment_date <YYYY-MM-DD> --to_payment_date <YYYY-MM-DD> \
  --limit 50 --agent --rationale "Search bills paid during the user's requested period"
```

For broad analysis (all vendors):

```bash
ramp bills search --include_paid \
  --from_payment_date <YYYY-MM-DD> --to_payment_date <YYYY-MM-DD> \
  --limit 50 --agent --rationale "Search all bills paid during the user's requested period"
```

Repeat either with `--page_cursor` if `next_page_cursor` is not null, preserving the same query and date bounds on every page.

**Note:** Use `from_payment_date` and `to_payment_date` to find bills with payment activity in the period, then use each result's `payment_date` when presenting or validating the period. Do not substitute `due_date`: it describes when payment was due, not when spend was paid. A matched bill may be partially paid, while its `amount` is the full invoice amount. Do not add that amount to actual spend without payment-allocation data. Bills with `payment_status: "OPEN"` are unpaid — report them separately as commitments.

### Step 3: Parse and aggregate

#### Transaction amounts (strings → numbers)

```bash
# Sum a single vendor's transactions
... | jq '[.data[0].transactions[].amount | gsub(","; "") | if startswith("-$") then ltrimstr("-$") | tonumber | (. * -1) elif startswith("$") then ltrimstr("$") | tonumber else tonumber end] | add'
```

#### Bill amounts are invoice amounts, not paid amounts

Use bill search to identify payment activity and relevant bill IDs. Do not sum
`BillInfo.amount` as paid-in-period spend: payment-date filtering can match one
installment of a partially paid bill while `amount` remains the full invoice
amount. Only combine bills into an actual-spend total when payment-allocation
amounts and dates are available; otherwise present the card subtotal and matched
bills separately, and label the complete paid total unavailable.

#### Multi-vendor table with pagination

Fetch all pages first, then aggregate. Write only the minimum fields needed into
a **fresh per-run directory** (`mktemp -d`) — never a fixed path or glob shared
across runs, or stale pages from a previous or concurrent analysis get silently
included in the totals. These files can contain sensitive spend data: do not
commit or upload them, redact values before any user-approved sharing, and
delete the directory as soon as the analysis is complete. The loop continues
until `next_page_cursor` is null:

```bash
run_dir=$(mktemp -d /tmp/spend_analysis.XXXXXX)

# Page 1
ramp transactions list \
  --transactions_to_retrieve all_transactions_across_entire_business \
  --start_at 2026-01-01T00:00:00Z --page_size 200 --include_count --agent \
  --rationale "List the user's transactions" \
  > "$run_dir/txns_page1.json"

# Page 2+ (repeat until next_page_cursor is null)
ramp transactions list \
  --transactions_to_retrieve all_transactions_across_entire_business \
  --start_at 2026-01-01T00:00:00Z --page_size 200 --include_count --agent \
  --next_page_cursor "<cursor from previous page>" \
  --rationale "List the user's transactions" \
  > "$run_dir/txns_page2.json"
```

Then merge all pages from this run's directory and build the vendor table:

```bash
jq -s -r '
  [.[].data[0].transactions[] |
    {merchant: .merchant_name,
     amt: (.amount | gsub(","; "") |
       if startswith("-$") then ltrimstr("-$") | tonumber | (. * -1)
       elif startswith("$") then ltrimstr("$") | tonumber
       else tonumber end)}]
  | group_by(.merchant)
  | map({vendor: .[0].merchant, total: (map(.amt) | add), count: length})
  | sort_by(-.total)
  | .[] | "\(.vendor)\t$\(.total)\t(\(.count) txns)"
' "$run_dir"/txns_page*.json
```

Clean up with `rm -rf "$run_dir"` when the analysis is done.

### Step 4: Present results

Format as a clear table:

```
Vendor Spend: 2026-01-01 to 2026-04-01

Vendor              Card Spend    Bills Matched    Complete Paid Total
─────────────────────────────────────────────────────────────────────
Figma               $24.00        0                $24.00
Delta Airlines      $3,663.73     0                $3,663.73
AWS                 $12,450.00    2                Requires payment-allocation data

Confirmed card subtotal: $16,137.73
```

Call out:
- **Vendor name variants** found (e.g., "Delta Air Lines" + "Delta Airlines")
- **Refunds** included in the totals
- **Bills vs transactions** breakdown if both exist for a vendor; do not add full invoice amounts to paid spend
- **Pagination** — whether all results were captured or if there are more pages

## Fields Available

### From `transactions list`

| Field | Description |
|---|---|
| `transaction_uuid` | Transaction UUID (use for deduplication) |
| `merchant_name` | Merchant name (not normalized) |
| `amount` | Formatted string (`"$8.00"`, `"-$259.49"`, `"$1,048.25"`) |
| `transaction_time` | ISO 8601 timestamp |
| `spent_by_user` | Employee name |
| `merchant_category` | Category (e.g., "SaaS / Software", "Airlines") |
| `reason_or_justification` | Memo / reason |
| `spend_allocation_name` | Fund / budget name |
| `transaction_link` | Direct link to transaction in Ramp UI |

### From `bills search`

| Field | Description |
|---|---|
| `id` | Bill UUID |
| `vendor_name` | Payee name |
| `amount` | Full invoice amount in dollars; not necessarily the amount paid in the requested period |
| `invoice_number` | Vendor invoice number |
| `payment_date` | Displayed payment date, typically the scheduled or sent date |
| `payment_status` | Payment state |
| `memo` | Bill description |

## Multi-Vendor Queries

For SaaS reviews or inference spend monitoring, run vendors in parallel:

```bash
# Run these concurrently
ramp transactions list --transactions_to_retrieve all_transactions_across_entire_business \
  --reason_memo_merchant_or_user_name_text_search "Figma" --start_at 2026-01-01T00:00:00Z --include_count --agent --rationale "List the user's transactions"

ramp transactions list --transactions_to_retrieve all_transactions_across_entire_business \
  --reason_memo_merchant_or_user_name_text_search "Anthropic" --start_at 2026-01-01T00:00:00Z --include_count --agent --rationale "List the user's transactions"

ramp transactions list --transactions_to_retrieve all_transactions_across_entire_business \
  --reason_memo_merchant_or_user_name_text_search "OpenAI" --start_at 2026-01-01T00:00:00Z --include_count --agent --rationale "List the user's transactions"
```

**Tip:** For vendors with known name variants, run multiple searches and deduplicate by `transaction_uuid`:
- "AWS" and "Amazon Web Services"
- "Delta Air Lines" and "Delta Airlines"

## Vendor Name Variant Detection

The API does not normalize merchant names. Common variants to watch for:

| Vendor | Possible variants |
|---|---|
| AWS | "AWS", "Amazon Web Services", "Amazon.com Services" |
| Delta | "Delta Air Lines", "Delta Airlines" |
| Google | "Google Cloud", "Google", "GCP" |

When running broad analysis (all transactions), group results and flag merchants with similar names. The agent should suggest merges.

## Example Session

```
User: How much have we spent on Figma this year?

Agent: Let me pull both card transactions and bills.
> ramp transactions list --transactions_to_retrieve all_transactions_across_entire_business \
>   --reason_memo_merchant_or_user_name_text_search "Figma" \
>   --start_at 2026-01-01T00:00:00Z --end_at 2026-04-02T00:00:00Z --include_count --agent \
>   --rationale "List the user's transactions"
> ramp bills search --query "Figma" --include_paid --from_payment_date 2026-01-01 \
>   --to_payment_date 2026-04-01 --limit 50 --agent \
>   --rationale "Search Figma bills paid during the user's requested period"

Figma spend (2026-01-01 to 2026-04-01):

  Card transactions: 3 totaling $24.00
    $8.00  Michael Scott  2026-03-17  "Trial spend for one Sales user"
    $8.00  Michael Scott  2026-03-17  "Trial spend for one Sales user"
    $8.00  Michael Scott  2026-03-17  "Trial spend for one Sales user"

  Bills: 0

  Total: $24.00

Note: There's also an open PO for Figma Enterprise ($150,042.75, PO #9880)
if you want to check commitment vs actual spend.

User: Give me a full SaaS vendor breakdown

Agent: Pulling all card transactions and bills with payment activity, then matching them by vendor...
> ramp transactions list --transactions_to_retrieve all_transactions_across_entire_business \
>   --start_at 2026-01-01T00:00:00Z --end_at 2026-04-02T00:00:00Z --page_size 200 --include_count \
>   --agent --rationale "List the user's transactions"
> ramp bills search --include_paid --from_payment_date 2026-01-01 \
>   --to_payment_date 2026-04-01 --limit 50 --agent \
>   --rationale "Search all bills paid during the user's requested period"
> # Paginate both searches to completion, then merge by vendor.

SaaS Vendor Spend Review (2026-01-01 to 2026-04-01):

Vendor              Card Spend    Bills Matched    Complete Paid Total
─────────────────────────────────────────────────────────────────────
Brown Group         $50,000.00    1                Requires payment-allocation data
Cochran Ltd         $21,500.00    0                $21,500.00
Goody               $9,119.13     2                Requires payment-allocation data
Morris-Allen        $8,900.00     0                $8,900.00
Figma               $24.00        1                Requires payment-allocation data

⚠ Vendor name variants detected:
  "Delta Air Lines" (2 txns) + "Delta Airlines" (5 txns) — likely same vendor

Bill matches were filtered by `payment_date`, but their full invoice amounts were
not added to spend. Payment-allocation data is required to complete those totals.
```

## When NOT to Use

- **Verifying a single payment** — use `ramp-payment-lookup`
- **Approving transactions** — use `ramp-approval-dashboard`
- **Receipt or memo cleanup** — use `ramp-complete-expenses`
- **Detailed PO status** — run `ramp purchase_orders get` directly

## Gotchas

| Issue | Fix |
|---|---|
| Transaction amounts are strings (`"$1,048.25"`) | Strip `$` and `,` before summing. Handle `-$` prefix for refunds. |
| Bill amounts are numeric (dollars) | They are full invoice amounts. Do not sum them as paid-in-period spend without payment-allocation data. |
| `--transactions_to_retrieve` is required | Always include it. Use `all_transactions_across_entire_business` for company-wide analysis. |
| Search text must be ≥3 characters | "AI" won't work — use full vendor name |
| Paid-in-period bill activity | Pass `--from_payment_date` and `--to_payment_date` to `bills search`, and use the returned `payment_date`. Do not fall back to `due_date` or treat full invoice `amount` as the paid allocation. |
| Vendor name variants not normalized | Run multiple searches for known variants. Dedupe by `transaction_uuid`. |
| Pagination ceiling | `--page_size 200` is accepted. Still check `next_page_cursor`. |
| No unified spend endpoint | Query transactions and bills separately, then merge the results. |
| `--include_count` only on transactions | Bills search returns `total_found` automatically. |
| Something broken? | With the user's consent, run `ramp feedback "<user-approved message>"`. This sends only that message to Ramp support; omit secrets and diagnostic artifacts. |
