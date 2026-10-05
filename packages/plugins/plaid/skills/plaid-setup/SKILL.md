---
name: plaid-setup
description: Install the Plaid CLI and configure the user's API keys for Sandbox or Production on their chosen computer.
---

# Plaid setup

Read [CLI guidance](references/cli.md).

1. Use the requested computer (`ListMachines`, `Shell(machineId)` for a connected local machine); keep installation, credentials, and queries there.
2. Run `bash <this-skill>/scripts/ensure-cli.sh --install`. Transfer the script with `CopyFromBox` if needed. On the Bot computer use `bash <this-skill>/scripts/plaid.sh` for every CLI command; it resolves the installation and writable config. On a local machine use the returned executable path.
3. Configure `PLAID_CLIENT_ID`, `PLAID_SECRET`, and `PLAID_ENV` through secure process-secret input on the Bot computer or the user's local environment. Run `<cli> config set --env <sandbox|production>`. Local hidden input with `--client-id <id>` is an alternative; never put secrets in command arguments.
4. Check `<cli> config` (masked). Environment overrides config; Sandbox and Production secrets differ. Optional Dashboard login warnings from `doctor` do not invalidate manual keys.
5. Use `plaid-connections` to connect a bank. Verify a small read before claiming bank access. Report computer, environment, and readiness.
