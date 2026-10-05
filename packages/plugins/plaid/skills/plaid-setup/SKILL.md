---
name: plaid-setup
description: Prepare the Plaid CLI and Python helpers, request missing API keys, and configure Sandbox or Production on the chosen computer.
---

# Plaid setup

Read [CLI guidance](references/cli.md).

1. Use the requested computer (`ListMachines`, `Shell(machineId)` for a connected local machine); keep installation, credentials, and queries there.
2. Run `bash <this-skill>/scripts/ensure-cli.sh --install` and ensure Python 3 is available for the bundled helpers. Transfer scripts with `CopyFromBox` if needed; keep `plaid-link.py` beside `plaid-api.py`. On the Bot computer use `bash <this-skill>/scripts/plaid.sh` for CLI commands; on a local machine use the returned executable path.
3. Check `<cli> config` and available environment variable names. Reuse valid setup. If keys are missing, ask for the client ID and the chosen environment's secret from [Plaid Dashboard → Keys](https://dashboard.plaid.com/developers/keys). Use OpenTeam's credential input for `PLAID_CLIENT_ID` and `PLAID_SECRET`, or local environment variables. Choose Production for real banks, Sandbox for simulated tests; ask when unclear. Set `PLAID_ENV` and run `<cli> config set --env <sandbox|production>`.
4. If the user has no Plaid developer account, direct them to [Dashboard signup](https://dashboard.plaid.com/signup); real banks require Production access. Optional `<cli> login` in a reachable browser fetches keys automatically. Check masked config; environment overrides config and secrets differ by environment. Dashboard login warnings do not invalidate manual keys.
5. Use `plaid-connections`: Production defaults to [Hosted Link](../plaid-connections/references/hosted-link.md), which the user opens on their own device. Resume the saved session after bank login and verify accounts before claiming access. Existing Items work without relinking. Report computer, environment, and readiness.
