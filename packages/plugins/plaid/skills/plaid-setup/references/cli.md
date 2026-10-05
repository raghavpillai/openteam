# Shared Plaid CLI guidance

Use Shell on one execution computer for installation, credentials, and every Plaid command. Local `machineId` execution does not inherit the Bot computer's files, config, or secure environment variables. Never move credentials to another computer as a fallback.

## Resolve the executable

Prefer this package's managed executable: run the setup skill's `scripts/ensure-cli.sh --check` using its absolute path on the chosen computer. It prints the installed path or exits nonzero without installing. The default location is `$HOME/.local/share/openteam/plaid-cli/20260909-fcd14fe6/plaid`.

An existing Homebrew installation is also usable: resolve it with `brew --prefix plaid` and use `<prefix>/bin/plaid`. Verify `--version` and `--help`. Do not trust an unrelated executable named `plaid` on PATH. If missing, follow `plaid-setup`; supported installer hosts are macOS/Linux, ARM64/x64. Read command `--help` before using flags not yet verified in this session. Shell working directories can reset; use absolute executable and script paths.

## Credentials and output

Credentials resolve as flags > environment > CLI config. Use the user's own environment-specific credentials. Keep secrets, access tokens, and CLI config files out of chat, command arguments, plugin files, and source control. Use the runtime's secure process-secret input on the Bot computer, or hidden CLI input/local environment on the user's computer. Do not read or dump the raw config file. `plaid config` is the CLI's masked summary. Item tokens are saved by the CLI and should not become model inputs.

Use `--json` for financial queries; stdout is data and stderr is diagnostics. Prefer table output for connection/setup commands; avoid dumping full authentication or Link responses. Return only requested financial fields and ordinary Item/account identifiers. Never print tokens to verify setup.

An Item is a bank login/connection containing one or more accounts. Product commands accept `--item <id-or-alias>` or `--all`. Select the intended Item explicitly when multiple exist; use `--all` only for an all-connections request. Environment and connection selection are separate. Sandbox data is simulated.

## Production Link browser access

The pinned CLI serves Link on localhost and validates callback Host, Origin, and state. Prefer a browser on the execution computer. A user-requested private tunnel must preserve the original localhost Host/Origin upstream and the callback path/query; simply forwarding the port with the external Host can show “Connected” in the browser while the CLI rejects the callback. Verify Item list/get before reporting success. The CLI's localhost page is not Plaid Hosted Link; Hosted Link requires a separate API implementation.

## Cleanup

Plugin uninstall does not uninstall this CLI or disconnect banks. Item removal revokes that connection; CLI logout only removes local Dashboard/API credentials. Run each only for the user's requested cleanup. Remove only this package's managed version directory when explicitly asked to remove its installed CLI; leave existing Homebrew/shared installations to their own package manager. Clearing the CLI's whole config can affect other Items and developer credentials, so establish the intended scope first.

Official references: [CLI commands and configuration](https://plaid.com/docs/resources/cli/), [Items](https://plaid.com/docs/api/items/), [Transactions](https://plaid.com/docs/api/products/transactions/).
