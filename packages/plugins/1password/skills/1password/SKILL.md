---
name: 1password
description: Sign in to websites with the user's saved 1Password logins and one-time codes. Use whenever a site asks for a username, password, or verification code.
---

# 1Password

The 1Password CLI reads items from vaults shared with a service account. Run it as `bash <this-skill>/scripts/op.sh` (below, `<op>`).

## Setup

1. Install the CLI: `bash <this-skill>/scripts/ensure-cli.sh --install`.
2. `<op> whoami` checks the connection. It needs a read-only service account token in `OP_SERVICE_ACCOUNT_TOKEN`; if it is missing or rejected, ask for one through OpenTeam's secure credential input with personal scope. Service accounts are created on 1Password.com under Developer → Service Accounts and cannot access built-in Personal, Private, or Employee vaults.
3. `<op> vault list` shows the shared vaults.

## Saved logins

- Logins for a site: `<op> item list --categories Login --format json | jq -r '.[] | select(any(.urls[]?; .href | test("example\\.com"))) | [.id, .vault.id, .title] | @tsv'`
- Username and password: `<op> read "op://<vault-id>/<item-id>/username"` and `<op> read "op://<vault-id>/<item-id>/password"`
- One-time code: `<op> item get <item-id> --vault <vault-id> --otp`

1Password limits a service account to 1,000 reads per hour, and Individual or Families accounts to 1,000 requests per day across all service accounts, so read items when needed rather than repeatedly listing the vault.
