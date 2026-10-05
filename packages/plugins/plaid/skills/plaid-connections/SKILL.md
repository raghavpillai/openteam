---
name: plaid-connections
description: Connect a bank with Plaid Link, list existing bank connections and their accounts, or remove a selected connection.
---

# Plaid connections

Read [shared CLI guidance](../plaid-setup/references/cli.md). Run `plaid-setup` if the selected computer lacks the CLI or credentials.

- **List:** `<cli> item list`, then `<cli> item get --item <id-or-alias>` for the requested connection's accounts. Show institution, Item ID, account name/type, and last four digits. Do not expose tokens.
- **Connect:** Check `<cli> link --help`, choose products for the requested use case, and run `<cli> link --products <comma-separated-products> --additional-consented-products ''` on the execution computer. The empty additional-products value avoids the CLI's default extra investment/liability consent; include additional products only when requested. In Sandbox, use `<cli> sandbox link --products <products>` for test data. The user completes real bank login, MFA, and account consent in Plaid Link. Production Link starts a localhost callback server: the user's browser must reach that execution computer. Prefer the user's local computer for first-time connection; a remote Bot's localhost URL is not reachable from the user's browser without a configured tunnel. Keep the Shell job alive with `AwaitShell` if needed; use only the URL the CLI actually provides. Verify success with Item list/get, then a small requested product read. Do not create another Item just because the user already has one that can serve the request.
- **Disconnect:** Resolve the exact Item first and explain that removing it disconnects every account inside it; it does not close any bank account. If the user explicitly requested that identified connection's removal, run `<cli> item remove --item <id-or-alias> --force`, then verify it is absent from the list. If they asked to remove only one account inside a multi-account Item, clarify scope rather than removing the whole Item.
- **Reconnect:** Use `plaid-troubleshooting` for login-required or revoked-consent errors. Do not invent an update/relink command or silently remove and recreate the Item.

Return the connection result and account summary, or the remaining user step. A launched Link flow alone is not a connected bank.
