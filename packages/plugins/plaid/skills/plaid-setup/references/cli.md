# CLI guidance

Use one execution computer for setup and queries. A local `machineId` does not inherit the Bot's files or secrets. Keep credentials on the selected machine.

Resolve the managed CLI with `bash <setup-skill>/scripts/ensure-cli.sh --check` (`--install` if missing). Default: `$HOME/.local/share/openteam/plaid-cli/20260909-fcd14fe6/plaid`. Supported: macOS/Linux, ARM64/x64. An official Homebrew installation is also usable (`brew --prefix plaid`). On the Bot computer, `<cli>` means `bash <setup-skill>/scripts/plaid.sh`: it resolves the executable and preserves the writable config location across jobs. The installer falls back to `/workspace/.local/share/openteam/plaid-cli/<version>` when home is not writable and stages downloads on the destination filesystem. Use absolute paths and check unfamiliar flags with `--help`.

Credentials resolve flags > environment > config. OpenTeam's credential input supplies named environment variables to subsequent Shell jobs. Ask for missing `PLAID_CLIENT_ID` and `PLAID_SECRET`; set `PLAID_ENV` on the selected machine. These are developer API keys, separate from the bank login handled by Plaid Link. `plaid config` is masked; default `item list` is suitable for summaries, while its JSON output contains access tokens.

With no keys, [Dashboard → Keys](https://dashboard.plaid.com/developers/keys) supplies the client ID and environment-specific secret. If the user prefers browser setup, `register` opens signup and `login` authenticates to the Dashboard, selects a team, and fetches keys. After new Production access is approved, `keys fetch` refreshes locally stored keys. Browser login must be reachable from the chosen execution computer; manual keys work without Dashboard login.

An Item is a bank login containing one or more accounts. Select `--item <id-or-alias>`; `--all` spans connections in the active environment. Sandbox is simulated. CLI config and Items persist on the execution computer; this package has no separate OpenTeam connected-account entry.

## Scope

The pinned CLI covers Link/Items, balances, transaction lists/sync, holdings/activity and liabilities. Bundled Python helpers add remote Hosted Link, recurring streams and product-error verification. This is not the entire Plaid API: no payments, Auth/Identity data queries, statements, income, update mode, force refresh, or webhooks.

## Production Link

For a user on another computer or phone, use the connections skill's [Hosted Link flow](../../plaid-connections/references/hosted-link.md). The bundled helper creates a Plaid-hosted URL and retrieves completion through outbound API requests, then saves Items into this CLI config.

The native CLI's localhost Link is an alternative for a browser on the execution computer. It rejects forwarded callback hosts; use Hosted Link for remote devices. Verify saved accounts before claiming success.

## Cleanup

Plugin uninstall removes skills only. Disconnect a requested bank with `item remove`; all accounts in that Item lose access. `logout` clears local API/Dashboard credentials. Remove only the managed version directory for a requested CLI uninstall. Don't clear the whole config when other Items may exist.

[Official CLI](https://plaid.com/docs/resources/cli/) · [Items](https://plaid.com/docs/api/items/) · [Transactions](https://plaid.com/docs/api/products/transactions/)
