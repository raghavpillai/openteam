---
name: 1password
description: Sign in to websites with the user's saved 1Password logins and one-time codes. Use whenever a site asks for a username, password, or verification code.
---

# 1Password

The 1Password CLI reads items from the vaults shared with the service account configured for this plugin. Run it as `bash <this-skill>/scripts/op.sh` (below, `<op>`); it installs the CLI on first use.

- Logins for a site: `<op> item list --categories Login --format json | jq -r '.[] | select(any(.urls[]?; .href | test("example\\.com"))) | [.id, .vault.id, .title] | @tsv'`
- Username and password: `<op> read "op://<vault-id>/<item-id>/username"` and `<op> read "op://<vault-id>/<item-id>/password"`
- One-time code: `<op> item get <item-id> --vault <vault-id> --otp`
- Connection and shared vaults: `<op> whoami` and `<op> vault list`. If the token is missing or rejected, the user adds or replaces it in Marketplace → 1Password.

1Password limits a service account to 1,000 reads per hour, and Individual or Families accounts to 1,000 requests per day across all service accounts, so read items when needed rather than repeatedly listing the vault.
