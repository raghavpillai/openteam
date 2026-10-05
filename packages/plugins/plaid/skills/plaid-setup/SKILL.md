---
name: plaid-setup
description: Install the Plaid CLI and configure the user's API keys for Sandbox or Production on their chosen computer.
---

# Plaid setup

Read [CLI guidance](references/cli.md).

1. Use the requested computer (`ListMachines`, `Shell(machineId)` for a connected local machine); keep installation, credentials, and queries there.
2. Run `bash <this-skill>/scripts/ensure-cli.sh --install`. Transfer the script with `CopyFromBox` if needed. On the Bot computer use `bash <this-skill>/scripts/plaid.sh` for every CLI command; it resolves the installation and writable config. On a local machine use the returned executable path.
3. Check `<cli> config` and available environment variable names. Reuse valid setup. If keys are missing, ask for the client ID and the chosen environment's secret from [Plaid Dashboard → Keys](https://dashboard.plaid.com/developers/keys). Use OpenTeam's credential input for `PLAID_CLIENT_ID` and `PLAID_SECRET`, or local environment variables. Choose Production for real banks, Sandbox for simulated tests; ask when unclear. Set `PLAID_ENV` and run `<cli> config set --env <sandbox|production>`.
4. If the user has no Plaid developer account, direct them to [Dashboard signup](https://dashboard.plaid.com/signup); real banks require Production access. Optional `<cli> login` in a reachable browser fetches keys automatically. Check masked config; environment overrides config and secrets differ by environment. Dashboard login warnings do not invalidate manual keys.
5. Use `plaid-connections` to connect a bank. Verify a small read before claiming bank access. Report computer, environment, and readiness.
