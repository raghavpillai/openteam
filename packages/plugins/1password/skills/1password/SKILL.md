---
name: 1password
description: Sign in to websites with the user's 1Password saved logins and one-time codes through the 1Password CLI, and set up the CLI and service account token when missing.
---

# 1Password

Saved logins come from the user's 1Password vaults through the `op` CLI, authenticated by a read-only service account token in `OP_SERVICE_ACCOUNT_TOKEN`. On the Bot computer `<op>` means `bash <this-skill>/scripts/op.sh`. Use only the CLI for 1Password; never a 1Password browser extension.

## Setup

1. Run `bash <this-skill>/scripts/ensure-cli.sh --install`.
2. Run `<op> whoami`, and check it before concluding 1Password is unavailable. If `OP_SERVICE_ACCOUNT_TOKEN` is missing or rejected, ask the owner for a token with OpenTeam's secure secret input, named `OP_SERVICE_ACCOUNT_TOKEN` with personal scope so every Bot can sign in. They create it on 1Password.com under Developer → Service Accounts, with read-only access to the vaults to share; service accounts cannot access built-in Personal, Private, or Employee vaults.
3. `<op> vault list` shows the shared vaults.

## Signing in

1. Reuse an existing browser session or importable Chrome session first.
2. Find the login once: `<op> item list --categories Login --format json | jq -r '.[] | select(any(.urls[]?; .href | test("example\\.com"))) | [.id, .vault.id, .title, .updated_at] | @tsv'`, adjusting the pattern to the site.
3. If several logins match and the task does not identify the account, ask which one.
4. Browser subagents do not see this skill. Give them the item and vault IDs with the full commands: `bash <this-skill>/scripts/op.sh read "op://<vault-id>/<item-id>/username"` and `.../password`, then type the values and submit. For a one-time code step, `bash <this-skill>/scripts/op.sh item get <item-id> --vault <vault-id> --otp` right before entering it.
5. Use a login only on its own site.

1Password allows a service account 1,000 reads per hour, and Individual or Families accounts 1,000 requests per day across all service accounts. Look up logins when needed; never poll or loop over the vault.
