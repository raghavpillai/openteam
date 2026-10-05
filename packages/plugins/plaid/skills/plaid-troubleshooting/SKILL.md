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
| Product unavailable/null | Use the financial-data [API helper](../plaid-financial-data/references/edge-cases.md) to verify consent/product errors hidden by the CLI. Check consent, entitlement and institution support; do not infer zero holdings/debt. |
| Login/consent required | User reauthentication; the pinned CLI lacks update mode. Do not replace the Item without instruction. |
| Hosted Link finished but no Item | Resume the saved session with `complete`; check pending/exited/expired in [Hosted Link guidance](../plaid-connections/references/hosted-link.md). |
| Hosted Link save/verification failure | Rerun `complete` for the same session; its journal reuses exchanged tokens. `EXCHANGE_UNCERTAIN` needs investigation before another exchange or link. |
| Local Link connected but no Item | Check CLI callback errors and localhost/tunnel access. |
| Not ready, rate limit, network | Retry reads within a bound; for Hosted Link exchanges follow the saved journal/error. Report persistent failure. |

Consult [official errors](https://plaid.com/docs/errors/) or [update mode](https://plaid.com/docs/link/update-mode/) when needed. Explain the verified cause and next step; don't delete Items or clear credentials as a generic fix.
