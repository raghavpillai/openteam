# Plaid

OpenTeam skills using the [official Plaid CLI](https://plaid.com/docs/resources/cli/) with your API keys.

| Skill | Use |
| --- | --- |
| `plaid-setup` | Install CLI; configure Sandbox/Production. |
| `plaid-connections` | Connect/list/disconnect banks and accounts. |
| `plaid-financial-data` | Balances, spending, transactions, investments, loans. |
| `plaid-troubleshooting` | Credentials, consent, product and connection errors. |

Install the plugin, then ask a Bot to set up Plaid on your chosen computer. Setup downloads a checksum-verified CLI (macOS/Linux, ARM64/x64); plugin installation alone doesn't install it. Production requires eligible Plaid access and user bank consent. For remote connections, the Bot sends a Plaid Hosted Link URL you can open on any device; no tunnel is needed.

Starting from scratch: the Bot asks for your Plaid client ID and Sandbox or Production secret from [Dashboard → Keys](https://dashboard.plaid.com/developers/keys), configures the CLI, then opens Plaid Link to connect your bank and verifies a read. Create a Plaid developer account first if needed. Browser Dashboard login can also fetch keys automatically.

Credentials and bank Items live on that computer. Python 3 helpers add Hosted Link, recurring streams and product-error verification. Hosted Link saves connections in the CLI config and resumes through a saved session ID. Multiple bank connections are supported; separate developer profiles and automatic background sync are not included. This package has no MCP or OpenTeam connected-account entry.

Uninstall removes skills only. CLI removal, credential cleanup, and bank disconnection are separate operations. Removing an Item disconnects all its accounts without closing them.

Pinned CLI: `20260909-fcd14fe6`. For upgrades, review [Plaid's formula](https://github.com/plaid/homebrew-plaid-cli/blob/main/Formula/plaid.rb), update the installer version/hashes, and recheck help.
