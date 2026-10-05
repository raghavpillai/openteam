---
name: plaid-financial-data
description: Read bank balances, analyze spending and recurring payments, or retrieve transactions, investments and liabilities with Plaid.
---

# Plaid financial data

Read [CLI guidance](../plaid-setup/references/cli.md). Resolve computer, environment, connection/account, and period. Use `<cli> <command> --item <id-or-alias> --json`; use `--all` for requested cross-bank analysis.

Hosted Link Items use the same CLI config and commands. Reuse saved connections; if bank login just finished, use `plaid-connections` to complete its session first.

| Data | Command |
| --- | --- |
| Balances | `balance` |
| Transactions | `transactions list --start-date YYYY-MM-DD --end-date YYYY-MM-DD` |
| Changes since prior sync | `transactions sync` |
| Holdings | `investments holdings` |
| Investment activity | `investments transactions --start-date YYYY-MM-DD --end-date YYYY-MM-DD` |
| Loans/credit cards | `liabilities` |

For pending replacements, refunds, recurring payments, or null product data, read [edge cases](references/edge-cases.md).

Check help for flags. Paginate lists with `--count`/`--offset`; never treat one page or sync deltas as a full ledger. Filter account IDs when necessary.

Keep currencies/accounts separate; distinguish cash/assets from credit-card or loan debt. Positive transaction amounts are outflows; negative are inflows. Separate pending replacements, refunds, and transfers when totaling spending. Missing available balances and null product data mean unknown, not zero. Empty older periods do not prove zero activity. State period, available freshness, truncation, and unavailable products. For errors, use `plaid-troubleshooting`; never invent financial data.
