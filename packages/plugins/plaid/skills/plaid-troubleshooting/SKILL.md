---
name: plaid-troubleshooting
description: Resolve Plaid CLI installation, API credential, environment, product-access, and bank connection errors.
---

# Plaid troubleshooting

Read [shared CLI guidance](../plaid-setup/references/cli.md). On the original execution computer, check CLI version/help, `<cli> config`, and `<cli> doctor`. Diagnose the specific failed check; manual API keys do not require Dashboard login. Capture error code/request ID and redact secrets; don't read the raw config.

| Failure | Next step |
| --- | --- |
| Missing CLI / unsupported host | Use `plaid-setup`. Install on a supported computer only if the user chooses it. |
| Invalid credentials / wrong environment | Check environment names and config precedence; rotate through secure input. Sandbox and Production secrets differ. |
| No Item / wrong bank | List Items in the selected environment; select or connect the intended one. |
| Product unavailable | Check the Item's consent, developer product access, and institution support. Linking another Item may not fix entitlement. |
| `ITEM_LOGIN_REQUIRED` / consent revoked | User reauthentication is needed. Inspect installed help and current [Link update-mode docs](https://plaid.com/docs/link/update-mode/). If the CLI lacks an update flow, explain that limitation; do not invent a flag or replace the connection without the user's instruction. |
| Data not ready / stale | Follow the error's documented retry guidance and freshness metadata. Avoid repeated polling or claiming success before data arrives. |
| Rate limit / network failure | Respect retry guidance; use bounded retries and report a persistent failure. |

For unknown errors, consult the [official error reference](https://plaid.com/docs/errors/). Report the cause, what was verified, and the next actionable step. Do not recommend deleting Items, clearing all credentials, or upgrading the CLI as a generic fix.
