# CLI guidance

Use one execution computer for setup and queries. A local `machineId` does not inherit the Bot's files or secrets. Keep credentials on the selected machine.

Resolve the managed CLI with `bash <setup-skill>/scripts/ensure-cli.sh --check` (`--install` if missing). Default: `$HOME/.local/share/openteam/plaid-cli/20260909-fcd14fe6/plaid`. Supported: macOS/Linux, ARM64/x64. An official Homebrew installation is also usable (`brew --prefix plaid`). On the Bot computer, `<cli>` means `bash <setup-skill>/scripts/plaid.sh`: it resolves the executable and preserves the writable config location across jobs. The installer falls back to `/workspace/.local/share/openteam/plaid-cli/<version>` when home is not writable and stages downloads on the destination filesystem. Use absolute paths and check unfamiliar flags with `--help`.

Credentials resolve flags > environment > config. Use secure process input/local hidden input; never put secrets or tokens in chat, arguments, or package files. `plaid config` is masked. Default `item list` is suitable for summaries; its JSON output contains access tokens. Parse financial JSON locally and return requested fields, not raw authentication responses/config.

An Item is a bank login containing one or more accounts. Select `--item <id-or-alias>`; `--all` spans connections in the active environment. Sandbox is simulated. CLI config and Items persist on the execution computer; this package has no separate OpenTeam connected-account entry.

## Scope

The pinned CLI covers Link/Items, balances, transaction lists/sync, holdings/activity and liabilities. The financial-data skill also provides a read-only Python helper for recurring streams and verifying product errors that this CLI may hide. It does not expose the entire Plaid API: no payments, Auth/Identity, statements, income, update mode, force refresh, or webhooks.

## Production Link

The CLI serves Link on localhost and rejects forwarded callback hosts. Prefer a browser on the execution computer. A requested private tunnel must preserve the original localhost Host/Origin upstream, callback path/query, and state. Simply forwarding an external Host can display “Connected” while saving no Item. Verify Item list/get. This CLI page is not Plaid Hosted Link; Hosted Link needs a separate API implementation.

## Cleanup

Plugin uninstall removes skills only. Disconnect a requested bank with `item remove`; all accounts in that Item lose access. `logout` clears local API/Dashboard credentials. Remove only the managed version directory for a requested CLI uninstall. Don't clear the whole config when other Items may exist.

[Official CLI](https://plaid.com/docs/resources/cli/) · [Items](https://plaid.com/docs/api/items/) · [Transactions](https://plaid.com/docs/api/products/transactions/)
