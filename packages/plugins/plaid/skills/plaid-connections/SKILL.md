---
name: plaid-connections
description: Connect banks with Plaid Link, list connections and accounts, or disconnect a selected bank connection.
---

# Plaid connections

Read [CLI guidance](../plaid-setup/references/cli.md); use `plaid-setup` if needed.

- List: `<cli> item list`, then `item get --item <id-or-alias>`. Report bank, Item ID, account type/name, and last four digits. Default list output avoids exposing tokens.
- Connect remotely: use [Hosted Link](references/hosted-link.md). Send the Plaid-hosted URL, then run `complete` with its saved session ID after the user finishes bank login/MFA/consent. Verify saved Items/accounts before claiming access. Include extra products only when requested.
- Connect on the same computer: `<cli> link --products <products> --additional-consented-products ''`. Keep the job alive with `AwaitShell`; verify Item list/get and a small read. Sandbox: `sandbox link --products <products>`.
- Disconnect: identify the exact Item. Removal disconnects all its accounts, not the bank accounts themselves. For an authorized removal: `item remove --item <id-or-alias> --force`; verify absence. Clarify requests to remove just one account inside a multi-account Item.
- Reconnect: use `plaid-troubleshooting`; the pinned CLI has no update/relink command.
