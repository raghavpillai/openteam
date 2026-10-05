---
name: plaid-troubleshooting
description: Diagnose Plaid installation, credentials, product access, bank login, or data availability errors.
---

# Plaid troubleshooting

Read [CLI guidance](../plaid-setup/references/cli.md). Check version/help and masked `config` on the original computer. Use the error code/request ID; `doctor` may flag optional Dashboard login.

| Problem | Response |
| --- | --- |
| Missing CLI | `plaid-setup` |
| Invalid keys | Check environment and flag/env/config precedence; Sandbox and Production secrets differ. |
| Missing/wrong bank | List Items and select or connect the intended bank. |
| Product unavailable | Check consent, developer entitlement, and institution support; another connection may not help. |
| Login/consent required | User reauthentication; the pinned CLI lacks update mode. Do not replace the Item without instruction. |
| Link looks connected but no Item | Check CLI callback errors and localhost/tunnel access. |
| Not ready, rate limit, network | Follow documented guidance with bounded retries; report persistent failure. |

Consult [official errors](https://plaid.com/docs/errors/) or [update mode](https://plaid.com/docs/link/update-mode/) when needed. Explain the verified cause and next step; don't delete Items or clear credentials as a generic fix.
