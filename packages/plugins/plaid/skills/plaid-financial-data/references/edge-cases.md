# Transaction and product limits

For pending replacements, refunds, recurring payments, or missing products:

- Analyze posted spending separately from pending holds. A posted replacement may have a new ID and different amount/date. Use `pending_transaction_id` when present; never deduplicate merely by merchant/amount. The pinned CLI omits this link, so flag uncertain matches. For a maintained ledger, upsert added/modified records by ID and apply removed IDs; replaying a batch must not double-count.
- Negative amounts can be income, transfers, card repayments, or refunds. Use category/merchant context; report purchase refunds separately from gross purchases, then compute net spending. Cross-period refunds need an explicit period convention.
- Null product fields mean unavailable/unknown, not zero debt or holdings. The pinned CLI can return null data with exit 0 despite API consent errors. Verify null holdings/liabilities/investment activity using the helper below before interpreting them. Do not change consent or replace Items as a generic fix.
- Complete pagination only proves coverage of the returned data. It does not prove the bank supplied all requested history. State the requested range and observed dates; an empty older period does not establish zero activity.

## Read-only API helper

Python 3 required. On the same configured computer:

`python3 <setup-skill>/scripts/plaid-api.py <command> --item <id>` (or `--all`). Always emits JSON; exits nonzero for errors, including partial multi-bank failure. It uses the CLI's config and credential environment without writing them. Transfer the helper to a local computer when necessary. Do not expose raw config/tokens.

Commands: `recurring`, `item` (consent/error/freshness metadata), `holdings`, `liabilities`, `investment-transactions --start-date YYYY-MM-DD --end-date YYYY-MM-DD`. Investment activity may require pagination beyond this helper's initial page; inspect total/count and disclose incomplete coverage.

`recurring` retrieves Plaid's actual streams, including status, cadence, amounts and predicted dates. Join missing stream currency to its account; predictions are estimates. An empty result means no streams detected in available history, not no subscriptions. Distinguish rent, loans, repayments, payroll and transfers from subscriptions. Without API access, label ledger-based patterns as inferred.

Force refresh (`/transactions/refresh`) requests bank extraction outside normal updates, with separate entitlement/fees. The response contains a request ID, not a refreshed ledger; fetch list/sync afterward. Neither bundled CLI nor helper exposes refresh, update mode or webhooks. Missing CLI support does not establish API entitlement; report untested eligibility as unknown.

[Transactions API](https://plaid.com/docs/api/products/transactions/)
