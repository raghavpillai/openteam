# 1Password

An OpenTeam skill for signing in to websites with saved logins and one-time codes from your 1Password vaults, using the [official 1Password CLI](https://www.1password.dev/cli) and a [service account](https://www.1password.dev/service-accounts/get-started).

| Skill | Use |
| --- | --- |
| `1password` | Find saved logins and read credentials and one-time codes for sign-ins. |

Create a service account on 1Password.com (Developer → Service Accounts) with read-only access to the vaults you want to share, then add the plugin and paste its token. OpenTeam gives the token to every Bot's computer processes as `OP_SERVICE_ACCOUNT_TOKEN`. The skill downloads a checksum-verified CLI (Linux, ARM64/x64) the first time it runs; on macOS, an existing `op` from 1Password's installer or Homebrew is used instead.

Bots and their browser and desktop workers read the username, password, or one-time code they need and type it into the site. Values a Bot reads appear in its conversation and model context; the token itself is redacted from command output. Service accounts cannot access built-in Personal, Private, or Employee vaults.

1Password limits service accounts to 1,000 reads per hour per token, and Individual and Families accounts to 1,000 requests per day across all service accounts. Bots look up logins only when a task needs one.

Replace the token on the plugin page after rotating it. Uninstalling removes the skill and the token from OpenTeam; revoke the service account at 1Password to end access there.

Pinned CLI: `2.40.0`. For upgrades, take the archives and SHA-256 digests from [1Password's release server](https://app-updates.agilebits.com/product_history/CLI2), update the installer, and recheck `op --help`.
