# Plaid

An OpenTeam skills package over the [official Plaid CLI](https://plaid.com/docs/resources/cli/). Uses your own Plaid credentials and bank consent. Published by OpenTeam.

| Skill | Example request |
| --- | --- |
| `plaid-setup` | Set up Plaid on my connected Mac using my existing API keys. |
| `plaid-connections` | Connect my bank, or show the accounts in my existing connection. |
| `plaid-financial-data` | Show checking-account transactions for September. |
| `plaid-troubleshooting` | Help resolve this Plaid connection error. |

Add Plaid in Marketplace, then ask a Bot to set it up. Setup installs a checksum-verified official CLI on the selected computer; Marketplace Add alone does not run it. The installer supports macOS and Linux on ARM64 and x64 without Homebrew. Existing official Homebrew installations can also be used.

Credentials and CLI configuration live on the execution computer, outside the package. Local computer execution requires that computer to be connected and allowed by its execution policy. Sandbox contains test data; real banks require Production access and the appropriate Plaid products. The user completes bank login and consent in Hosted Link.

There is no MCP server or connected-account entry in OpenTeam for this package. The Bot uses Shell and the skills; bank connections are managed by the CLI. Multiple bank Items are supported, but this package does not add isolated developer-account profiles or automatic background synchronization.

Uninstalling the plugin removes its skills, not the CLI, credentials, or bank authorization. Removing a Plaid Item disconnects all accounts in that Item; it does not close the bank accounts. Ask for the particular cleanup you want.

The installer pins `20260909-fcd14fe6` and checks Plaid's published archive hashes. To update that pin, review the [official Homebrew formula](https://github.com/plaid/homebrew-plaid-cli/blob/main/Formula/plaid.rb), update all four hashes in `skills/plaid-setup/scripts/ensure-cli.sh`, and recheck command help. CLI binaries are downloaded on first setup and are not redistributed in this package.
