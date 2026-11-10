---
name: ramp-spend-audit
area: Cards and Spend
supported_surfaces: [cli, mcp]
description: |-
  Review Ramp spend for possible duplicate software, fragmented vendor payments,
  unused funds, oversized limits, and recurring-spend controls. Use when a customer
  asks for a spend audit, savings opportunities, or safer recurring spending.
  This skill identifies opportunities; it does not cancel subscriptions or change
  vendor-side payment settings.
---

# Spend Audit

Start by asking which review the customer wants unless their request already names one.

1. Check everything
2. Software we may be paying for twice
3. Vendors we pay in more than one way
4. Money set aside that no one uses
5. Spending limits that may be too high
6. Regular payments that need better controls

If the customer names an outcome, skip the menu and route directly to its guide. For a
full audit, begin with one shared account scan, then use the relevant guides for each
shortlist. Do not fetch the same broad account data again for every section.

## Direct Routing

- Possible duplicate software: read [software-sprawl](references/software-sprawl.md).
- A vendor paid by card and bill or through multiple funds: read
  [multiple-payment-methods](references/multiple-payment-methods.md).
- Unused or dormant funds: read [unused-funds](references/unused-funds.md).
- Limits that are likely oversized: read [high-limits](references/high-limits.md).
- Recurring charges needing a dedicated control: read
  [recurring-spend-controls](references/recurring-spend-controls.md).

## Shared Audit Rules

- Start read-only. Do not create, update, lock, unlock, or otherwise change a fund
  until the customer approves the exact change.
- Discover capabilities for the current connection and permission first. Possible Ramp actions
  include: create a vendor-restricted fund; update merchant/category restrictions; set a positive
  periodic limit; set a per-transaction limit; lock or unlock a fund.
  This list is not runtime evidence; every action claim requires current connection plus
  permission discovery. Do not claim an action is available until runtime discovery confirms it.
  Otherwise give the manual Ramp-app path.
- Use cleared or completed activity, keep currencies separate, and subtract refunds.
  Failed, declined, draft, and deleted activity is not spend evidence.
- Check at least six months when available. An incomplete query, timeout, truncated
  page set, or unexpectedly small population is **Reduced coverage**, not proof that
  there are no findings.
- A `trip_id = 0` means nontravel; a positive trip ID means travel-linked. Travel,
  dining, group-event, and multiple-attendee exclusions apply only to duplicate or overlap
  candidates. January 1, 1970 or near-epoch last-used timestamps are a never-used signal,
  verified against cleared activity, not a blanket exclusion. Bill-versus-card pairs are
  payment-method reviews, not duplicate spend; do not filter them out of that focused audit.
- A possible overlap is an investigation, not a cancellation instruction or guaranteed
  saving. Do not make vendor-side changes or claim that a subscription has been cancelled.
- Unless the admin asks for technical details, do not show CLI commands. Do not show MCP operation
  names. Do not show table names. Do not show query details.

## Check Everything

Use the one shared account scan to group cleared card activity and paid bill activity by
normalized vendor, currency, route, month, user, fund, and category. Record the date
range, row count, distinct vendors, and which routes were available. For fund reviews,
obtain the complete active-fund catalog from the scalable fund/allocation population
surface; this is the candidate population, including active funds with no cleared spend.
Follow `next_cursor` through every page of the lightweight catalog. Include funds after
page one, but do not read live details per fund during this population sweep. For
aggregate totals, trends, and group-bys, use the reporting tools: load the workflow with
`ramp_reporting_get_skill`, then run `ramp_reporting_query` (CLI: `ramp reporting
get-skill`, then `ramp reporting query`). Use reporting results only to measure activity,
then rank the complete lightweight catalog using available summary and activity fields. Cap expensive live detail reads at the ten strongest
candidates needed to produce the five-result output. Catalog pagination completion is
required and is not subject to the detail-read cap.

Return the five most important items first. Keep savings and control opportunities separate.
Offer `show me more` to reveal lower-priority items, supporting transactions, exclusions, and
calculations.

## Output Format

```text
Finding X: <decision-oriented title>
<Short plain-language body with the evidence and likely impact needed for the decision.>
Next step: <review, owner confirmation, or exact proposed control change>
```

Use only `Finding X` and `Next step` as result labels. Add one coverage note after the
findings with the date range, routes and populations checked, and any **Reduced coverage**.

For a ready control change, use this sequence: user chooses an outcome; re-read the exact
target; show current state, proposed state, and consequence; user approves the exact
change; re-read immediately before acting; make only that change; re-read and report the
resulting state. A vague "fix it" is not approval.
