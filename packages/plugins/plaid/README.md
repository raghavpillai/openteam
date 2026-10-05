# Plaid

OpenTeam skills using the [official Plaid CLI](https://plaid.com/docs/resources/cli/) with your API keys.

| Skill | Use |
| --- | --- |
| `plaid-setup` | Install CLI; configure Sandbox/Production. |
| `plaid-connections` | Connect/list/disconnect banks and accounts. |
| `plaid-financial-data` | Balances, spending, transactions, investments, loans. |
| `plaid-troubleshooting` | Credentials, consent, product and connection errors. |

Install the plugin, then ask a Bot to set up Plaid on your chosen computer. Setup downloads a checksum-verified CLI (macOS/Linux, ARM64/x64); plugin installation alone doesn't install it. Production requires eligible Plaid access and user bank consent. For remote connections, the Bot sends a Plaid Hosted Link URL you can open on any device; no tunnel is needed.

Starting from scratch: the Bot asks for your Plaid client ID and environment's secret from [Dashboard → Keys](https://dashboard.plaid.com/developers/keys), then configures the CLI and Python helpers. For real banks it sends a Hosted Link URL and expiration. Open it on your laptop or phone, complete bank login, then tell the Bot “done.” It collects the result, saves the connection, and verifies accounts. Create a Plaid developer account first if needed; browser Dashboard login can also fetch keys.

Credentials, bank Items and unfinished Link sessions live on that computer. Existing connections work without relinking; new Hosted Link Items use the same balance, transaction and recurring-data commands. Python 3 helpers add Hosted Link, recurring streams and product-error verification. Multiple bank connections are supported; separate developer profiles and automatic background sync are not included. This package has no MCP or OpenTeam connected-account entry.

Uninstall removes skills only. CLI removal, credential cleanup, and bank disconnection are separate operations. Removing an Item disconnects all its accounts without closing them.

Pinned CLI: `20260909-fcd14fe6`. For upgrades, review [Plaid's formula](https://github.com/plaid/homebrew-plaid-cli/blob/main/Formula/plaid.rb), update the installer version/hashes, and recheck help.
