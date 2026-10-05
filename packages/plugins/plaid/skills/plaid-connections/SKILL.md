---
name: plaid-connections
description: Connect banks with Plaid Link, list connections and accounts, or disconnect a selected bank connection.
---

# Plaid connections

Read [CLI guidance](../plaid-setup/references/cli.md); use `plaid-setup` if needed.

- List: `<cli> item list`, then `item get --item <id-or-alias>`. Report bank, Item ID, account type/name, and last four digits. Default list output avoids exposing tokens.
- Connect: `<cli> link --products <products> --additional-consented-products ''`. Include extra products only when requested. Sandbox: `sandbox link --products <products>`. The user handles bank login/MFA/consent. Production needs a browser that reaches the CLI's localhost server; see the reference for remote access. Keep the job alive with `AwaitShell`. Verify Item list/get and a small read; a browser's “Connected” message alone is insufficient.
- Disconnect: identify the exact Item. Removal disconnects all its accounts, not the bank accounts themselves. For an authorized removal: `item remove --item <id-or-alias> --force`; verify absence. Clarify requests to remove just one account inside a multi-account Item.
- Reconnect: use `plaid-troubleshooting`; the pinned CLI has no update/relink command.
