---
name: ramp-reporting
area: Cards and Spend
supported_surfaces: [cli]
description: |-
  Answers analytical questions about business data: totals, counts, trends,
  top vendors, period comparisons, and breakdowns by department or category.
  Also retrieves balance sheets, income statements (P&L), and trial balances
  from connected ERP books.
---

# Ramp Reporting

1. Check `ramp tools list --agent`. If reporting commands are unavailable, use
   `ramp-spend-analysis`; if scopes are missing, run `ramp auth login`.
2. Before the first reporting query, run
   `ramp reporting get-skill --agent --rationale "Load the reporting workflow"`
   and follow the returned `content`.
3. Run every reporting command with `--agent` and a non-empty `--rationale`.
    Pass nested arguments such as `report_query` and `lookup_requests` with `--json`.
   `ramp tools schema reporting <command> --agent` returns the request schema.
