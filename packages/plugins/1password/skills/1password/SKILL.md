---
name: 1password
description: Sign in to websites with the user's saved 1Password logins and one-time codes. Use whenever a site asks for a username, password, or verification code.
---

# 1Password

The 1Password CLI reads items from the vaults shared with the service account configured for this plugin. Run it as `bash <this-skill>/scripts/op.sh` (below, `<op>`); it installs the CLI on first use.

- Logins for a site: `set -o pipefail; <op> item list --categories Login --format json | jq -r '.[] | select(any(.urls[]?; .href | test("example\\.com"))) | [.id, .vault.id, .title] | @tsv'`. Keep `pipefail` enabled so a CLI failure cannot appear to be a successful empty lookup.
- Username and password: `<op> read "op://<vault-id>/<item-id>/username"` and `<op> read "op://<vault-id>/<item-id>/password"`
- One-time code: `<op> item get <item-id> --vault <vault-id> --otp`
- Connection and shared vaults: `<op> whoami` and `<op> vault list`. If the token is missing or rejected, the user adds or replaces it in Marketplace → 1Password.

If a read-only lookup fails with a connection reset, broken pipe, or connection timeout, wait two seconds and retry that lookup once before asking the user for login details. Preserve the failed attempt in your report. If it fails again, report the actual error; a transport failure does not establish a wrong password or revoked vault access. Do not retry authentication rejections or rate limits, and do not replay website actions, writes, or an entire task.

1Password limits a service account to 1,000 reads per hour, and Individual or Families accounts to 1,000 requests per day across all service accounts, so read items when needed rather than repeatedly listing the vault.
