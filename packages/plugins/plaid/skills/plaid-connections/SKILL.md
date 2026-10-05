---
name: plaid-connections
description: Connect banks through Plaid Hosted Link from any device, resume completed sessions, list accounts, or disconnect a selected bank connection.
---

# Plaid connections

Read [CLI guidance](../plaid-setup/references/cli.md); use `plaid-setup` if needed.

- List: `<cli> item list`, then `item get --item <id-or-alias>`. Report bank, Item ID, account type/name, and last four digits. Default list output avoids exposing tokens.
- Connect: default to [Hosted Link](references/hosted-link.md) in Production. Send the URL with expiration and retain its session ID. When the user says they finished, resume that session with `complete` on the original computer/environment. Verify saved accounts; do not create a replacement session for completion. Request only desired products, defaulting to transactions.
- Local alternative: use `<cli> link --products <products> --additional-consented-products ''` when explicitly using a browser on the execution computer. Keep it alive with `AwaitShell` and verify saved accounts. Sandbox: `sandbox link --products <products>`.
- Disconnect: identify the exact Item. Removal disconnects all its accounts, not the bank accounts themselves. For an authorized removal: `item remove --item <id-or-alias> --force`; verify absence. Clarify requests to remove just one account inside a multi-account Item.
- Reconnect: use `plaid-troubleshooting`; the pinned CLI has no update/relink command.
