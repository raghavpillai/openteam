---
name: plaid-setup
description: Set up Plaid when a user wants to install the official CLI, configure their own API keys, or choose Sandbox versus Production on a specific computer.
---

# Plaid setup

Read [references/cli.md](references/cli.md) for shared execution and credential rules.

1. Use the computer the user selected. For local keys or "my bank on my Mac", use their connected computer via `ListMachines` and `Shell(machineId)`; otherwise use the Bot computer. Keep setup and queries on that same computer. If a selected computer is offline, wait for it to reconnect rather than moving credentials elsewhere.
2. Resolve the official CLI as described in the reference. If missing, run `bash <absolute-path-to-this-skill>/scripts/ensure-cli.sh --install` on that computer. For local execution, transfer the bundled script with `CopyFromBox` first if it is only on the Bot computer. Use the returned absolute executable path for subsequent commands.
3. Run `<cli> config set --help`. Reuse configured credentials when they match the requested environment. For existing API keys, use `PLAID_CLIENT_ID`, `PLAID_SECRET`, and `PLAID_ENV` on that computer. On the Bot computer, request missing values through secure secret input with those environment names. On a local computer, have the user enter the secret in the CLI's hidden prompt (`<cli> config set --client-id <id> --env <environment>`) or configure its local process environment; do not transport the value through chat or shell arguments. If Shell cannot accept hidden interactive input, have the user complete that command in their own terminal. Dashboard browser login with `<cli> login` is an alternative when the user prefers it.
4. Use Sandbox for test data and Production for real banks, according to the user's goal. Production needs eligible Plaid access; a Sandbox secret cannot access real accounts. Set the environment consistently in the process environment and CLI config: environment values override config. Run `<cli> config` for its masked readiness summary; `doctor` may also flag optional Dashboard login even when manual API keys are usable.
5. For a requested bank connection, continue with `plaid-connections`. Validate with a small read from that Item. Without a linked Item, report that credentials are configured but bank access is not yet verified. Return the computer, CLI version, environment, and next step; never return credential values.
