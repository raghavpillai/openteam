---
name: ramp-submit-reimbursement
area: Reimbursements
supported_surfaces: [cli, mcp]
description: |-
  Submit an out-of-pocket reimbursement from a receipt. Use when: 'submit reimbursement',
  'reimburse me', 'I paid out of pocket', 'expense a receipt', 'file reimbursement',
  'OOP expense', 'I bought something for work'. Do NOT use for: approving reimbursements
  (use ramp-approval-dashboard), uploading receipts to card transactions (use ramp-complete-expenses),
  or editing existing reimbursements.
---

## Non-Negotiables

- **Pass `--rationale` on every command** — it is a required field on these agent-tools (a non-empty string, max 1024 chars). With `--json`, supply it as a `"rationale"` key in the body. Omitting it returns `HTTP 422 (DEVELOPER_INVALID_SCHEMA)`, in both agent and human modes.
- Never submit without confirming the details with the user first. Show amount and currency, merchant, memo, fund, and accounting categories before submitting.
- Receipts must be **base64-encoded** for upload. Accepted types: PNG, JPEG, PDF, HEIC, WEBP.
- All CLI flags use **underscores**, not hyphens (e.g., `--fund_uuid`, `--page_size`).
- Reimbursement amounts use major units in the draft's existing currency (for example, `42.50` means EUR 42.50 for a EUR draft, not cents). An amount-only edit preserves the existing currency.
- After editing, always check `missing_items` in the response. Do not submit until all required items are resolved.

## Workflow

### Step 1: Upload the receipt

The user must provide a receipt file. Base64-encode and upload it:

```bash
# Encode the file
base64 -i /path/to/receipt.pdf | tr -d '\n'

# Upload (no --transaction_uuid — this is for a new reimbursement, not a card transaction)
ramp receipts upload \
  --content_type "application/pdf" \
  --filename "receipt.pdf" \
  --file_content_base64 "{base64_string}" --rationale "Upload the receipt"
```

Response returns `receipt_uuid`. Save it for the next step.

### Step 2: Create a draft reimbursement from the receipt

```bash
ramp reimbursements create {receipt_uuid} --rationale "Create the reimbursement from the receipt"
```

Response returns:
- `reimbursement_uuid` — the draft reimbursement ID
- `suggested_memos` — AI-generated memo suggestions based on the receipt
- `suggested_codings` — suggested accounting category selections
- `suggested_funds` — suggested spend allocations to charge
- `missing_items` — what still needs to be filled in before submission
- `reimbursement_link` — direct link to view in the Ramp app

### Step 3: Fill in required fields

Check `missing_items` from the create response. Common required fields:

| Missing item | How to fill |
|---|---|
| `missing_memo: true` | Edit with `--memo` |
| `missing_fund: true` | Edit with `--fund_uuid` (pick from `suggested_funds` or list funds) |
| `missing_tracking_categories` (non-empty) | Edit with `--json` to set category selections |
| `missing_receipt: true` | Should not happen if you created from a receipt |

Use suggestions from the create response when available:

```bash
# Set memo and fund from suggestions
ramp reimbursements edit {reimbursement_uuid} \
  --memo "Coffee with client" \
  --fund_uuid "{suggested_fund_uuid}" --rationale "Update the reimbursement for the user"
```

If the receipt amount is wrong, correct it while the reimbursement is still in `DRAFT`. Use the draft's existing currency shown in the tool response:

```bash
# For a draft whose existing currency is EUR
ramp reimbursements edit {reimbursement_uuid} \
  --amount 42.50 --rationale "Correct the reimbursement amount for the user"
```

Amounts must be positive values in the existing draft currency; `--amount` alone does not change the currency. After editing, check `missing_items` as usual and show both the corrected amount and currency in the final confirmation before submitting.

For tracking categories, use `--json`:

```bash
ramp reimbursements edit {reimbursement_uuid} --json '{
  "rationale": "Update the reimbursement for the user",
  "reimbursement_uuid": "{uuid}",
  "tracking_category_selections": [
    {
      "category_uuid": "{category_uuid}",
      "option_uuid": "{option_uuid}"
    }
  ]
}'
```

If no suggestions are available for the fund, list the user's funds:

```bash
ramp funds list --agent --rationale "List the user's funds"
```

**After each edit**, check the response's `missing_items`. Repeat until all required items are resolved (all `false` / empty).
Also stop on any `validation_errors` and inspect the latest response's `state`:
amount, currency, a nonblank merchant, and transaction date must be present, even
when marked `required: false`. These values are not all covered by `missing_items`.
Fill gaps from receipt evidence or user input, never guesses. If a blocker requires
bank-account setup or another app-only action, hand off rather than trying submission.
Do not attempt submission for a record known to be outside DRAFT.

### Step 4: Confirm with the user

Present the complete reimbursement before submitting:

```
Ready to submit:
  Amount:    USD 42.50
  Merchant:  Blue Bottle Coffee
  Memo:      Coffee with client — discussed Q2 roadmap
  Fund:      Social bonding & Team outings 2026
  Category:  70103 - Company Meals
  Receipt:   attached

Submit for approval?
```

### Step 5: Submit

```bash
ramp reimbursements submit {reimbursement_uuid} --rationale "Submit the reimbursement"
```

On success, report the returned outcome:
- If `already_submitted` is true, say it was already submitted and is pending review;
  do not claim this call submitted it.
- Otherwise, if `submission_pending` is true, say the request was accepted and is still
  processing; do not claim approval routing is complete or resubmit to force progress.
- Otherwise, say it has been submitted for approval and they'll be notified when approved.

Include the `reimbursement_link` from the submission response, falling back to the
create/edit response if needed.

## Editing After Rejection

If a reimbursement was rejected and the user wants to fix and resubmit:

```bash
# Revert to draft
ramp reimbursements resubmit {reimbursement_uuid} --rationale "Resubmit the reimbursement"

# Edit as needed
ramp reimbursements edit {reimbursement_uuid} --memo "Updated memo with details" --rationale "Update the reimbursement for the user"

# Submit again
ramp reimbursements submit {reimbursement_uuid} --rationale "Submit the reimbursement"
```

## Duplicating a Previous Reimbursement

`ramp reimbursements duplicate` exists, but it is not a complete CLI path for a new receipt-backed reimbursement.
The duplicate keeps the prior coding context, but it does **not** copy the receipt, and the CLI cannot attach a new receipt to that duplicated draft afterward.

If the user needs to submit a new reimbursement with a new receipt, the executable CLI path is:

```bash
# Find a previous reimbursement to reference
ramp reimbursements list --reimbursements_to_retrieve my_reimbursements --page_size 10 --rationale "List the user's reimbursements"

# Duplicate exists, but the draft will still be missing a receipt
ramp reimbursements duplicate {previous_reimbursement_uuid} --rationale "Duplicate the reimbursement"

# Upload the new receipt
ramp receipts upload --content_type "image/jpeg" --filename "gym-apr.jpg" \
  --file_content_base64 "{base64}" --rationale "Upload the receipt"

# Create a fresh reimbursement from that receipt
ramp reimbursements create {receipt_uuid} --rationale "Create the reimbursement from the receipt"

# Re-apply memo, fund, and tracking categories, then submit
ramp reimbursements edit {reimbursement_uuid} --memo "Monthly gym membership" --rationale "Update the reimbursement for the user"
ramp reimbursements submit {reimbursement_uuid} --rationale "Submit the reimbursement"
```

Do not imply that a new receipt can be attached to the duplicated reimbursement via CLI. `receipts attach` is for card transactions only, and `submit` can fail with "receipt must be specified" if the duplicate has no receipt.

## Example Session

```
User: I bought coffee for a meeting yesterday, here's the receipt ~/Downloads/bluebottle.jpg

Agent: Let me upload that receipt and create a reimbursement.
> base64 -i ~/Downloads/bluebottle.jpg | tr -d '\n'
> ramp receipts upload --content_type "image/jpeg" --filename "bluebottle.jpg" \
>   --file_content_base64 "{base64}" --rationale "Upload the receipt"

Receipt uploaded (receipt_uuid: `<receipt_id>`).

> ramp reimbursements create <receipt_id> --rationale "Create the reimbursement from the receipt"

Draft created. The receipt shows Blue Bottle Coffee, $12.50.
Suggested memos: "Coffee at Blue Bottle for team meeting"
Suggested fund: "Social bonding & Team outings 2026"
Missing: memo, fund, Category (GL account)

Let me fill in the details using the suggestions:
> ramp reimbursements edit <reimbursement_id> \
>   --memo "Coffee at Blue Bottle for team meeting" \
>   --fund_uuid "<fund_id>" --rationale "Update the reimbursement for the user"

All required items resolved. Ready to submit:
  Amount:    USD 12.50
  Merchant:  Blue Bottle Coffee
  Memo:      Coffee at Blue Bottle for team meeting
  Fund:      Social bonding & Team outings 2026
  Category:  70103 - Company Meals
  Receipt:   attached

Submit for approval?

User: yes

Agent: > ramp reimbursements submit <reimbursement_id> --rationale "User confirmed submitting the USD 12.50 Blue Bottle reimbursement for approval"
Submitted! Your reimbursement is now pending approval.
View it using the `reimbursement_link` returned by Ramp.
```

## When NOT to Use

- **Approving reimbursements** — use ramp-approval-dashboard
- **Uploading receipts to card transactions, or editing their memos/categories** — use ramp-complete-expenses
- **Canceling an approved reimbursement** — tell the user to contact their manager or use the Ramp app

## Gotchas

| Issue | Fix |
|---|---|
| `create` requires a `receipt_uuid` | Always upload the receipt first, then create |
| `duplicate` does not copy receipts | Upload a new receipt separately, or use `create` from a receipt instead |
| `receipts attach` is for card transactions only | For reimbursements, use `create {receipt_uuid}` to attach at creation time |
| Submit fails with "receipt must be specified" | The reimbursement was created without a receipt (e.g., via `duplicate`). Create a new one from a receipt instead. |
| `missing_tracking_categories` has entries | Use `--json` with `tracking_category_selections` to set them. Each entry in the missing list shows the `category_uuid` and `category_name` needed. |
| `suggested_funds` may be empty | Fall back to `ramp funds list` to find available funds |
| Large receipt files hit shell arg limits | For files >100KB, write base64 to a temp file and read it into the `--file_content_base64` flag |
| Amount edit fails | Amount must be a positive value and can only be edited while the reimbursement is in `DRAFT`. `--amount` preserves the draft's existing currency, so use major units in that currency, then check `missing_items` and confirm both amount and currency before submitting. |
