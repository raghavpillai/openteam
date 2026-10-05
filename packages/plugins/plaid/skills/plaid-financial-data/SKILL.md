---
name: plaid-financial-data
description: Retrieve and summarize connected-bank balances, transactions, investment holdings or activity, and liabilities through the official Plaid CLI.
---

# Plaid financial data

Read [shared CLI guidance](../plaid-setup/references/cli.md). Resolve the computer, environment, Item/account, and date range from the request. If setup or a connection is missing, use the corresponding Plaid skill.

Use the requested command with `--json` and the selected `--item <id-or-alias>` (or `--all` when requested):

| Data | Command |
| --- | --- |
| Balances | `<cli> balance` |
| Transactions | `<cli> transactions list --start-date YYYY-MM-DD --end-date YYYY-MM-DD` |
| Incremental transaction changes | `<cli> transactions sync` |
| Holdings | `<cli> investments holdings` |
| Investment activity | `<cli> investments transactions --start-date YYYY-MM-DD --end-date YYYY-MM-DD` |
| Credit cards, student loans, mortgages | `<cli> liabilities` |

Check each command's help before choosing flags. For date-range analysis, paginate list commands with `--count` and `--offset` until the range is complete; a first page is not a full month's spending. Filter account IDs from the returned data when the CLI has no account-level flag. Incremental sync returns changes, not a complete ledger; do not calculate totals from a delta or promise a persistent ledger that this package does not maintain.

Preserve currency and account boundaries. Separate pending transactions and avoid double-counting them with posted replacements. For Transactions, positive amounts are outflows and negative amounts are inflows; distinguish transfers and refunds when computing spending. Missing available balance is unknown, not zero. State the requested period, data timestamp/freshness when provided, and any truncation or unavailable product. Plaid data may lag the bank; don't describe an unspecified timestamp as real-time.

Return a concise answer or table, with masked account labels and material assumptions. Diagnose failures with `plaid-troubleshooting`; never replace inaccessible financial data with estimates presented as facts.
