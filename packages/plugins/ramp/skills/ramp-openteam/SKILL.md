---
name: ramp-openteam
description: Use Ramp in OpenTeam with the connected MCP account, official finance playbooks, and an account-scoped CLI fallback.
---

# Ramp in OpenTeam

Resolve the user's intended Ramp account with `GetDynamicTools`, then use its actual namespace and schemas with `CallDynamicTool`. Start with the connected MCP tools. The selected Ramp access level and the user's Ramp role control available actions.

The official playbooks are under `../../upstream/plugins/ramp/skills/` relative to this skill. Read the relevant installed `ramp-*` skill and its supporting references. They cover spend, expenses, bills, approvals, procurement, vendors, cards, travel, banking, and agent payments.

## Translate upstream examples

Resolve conceptual names such as `ListCards` against the live tools, their descriptions, and required inputs. Actual Ramp MCP names include `ramp_list_cards` and `ramp_get_simplified_user_detail`; OpenTeam adds the account namespace. Use that live schema to translate a CLI example into an MCP call. Read all pages needed for the requested scope.

Upstream examples can lag the service. In particular, bill approval is available through `ramp_approve_or_reject_bill` or `ramp bills approve` when the live account exposes it, despite older playbook statements. Check the current schema and the user's authorization before acting. A bill approval may advance payment. Confirm a mutation's result before reporting success, and inspect ambiguous results before retrying.

Use OpenTeam's available browser capability for checkout and sign-in. The `ramp-prefer-ramp-connectors` playbook applies to separately configured Ramp Router connectors; resolve the tools actually available in this session before following that preference.

## Receipt uploads through MCP

Receipt uploads use MCP; they do not require the Ramp CLI or a separate CLI login. Connect with Full access and check that the selected account exposes `ramp_request_receipt_upload_link`.

For a receipt file available on the Bot computer, follow `ramp-complete-expenses`: confirm the transaction match, check `ramp_get_transaction_missing_items`, then request a link for that transaction only when its receipt is missing. Use the returned upload instructions to send the local file over HTTPS. Keep the single-use URL private and check its expiry. After HTTP 201, re-read the missing items and verify `missing_receipt` is false before reporting success. Never put receipt bytes or base64 into an MCP call.

Use `ramp_open_receipt_uploader` only when the host actually renders its interactive upload card. A chat attachment must be available as a local file on the Bot computer for the upload-link path. For an out-of-pocket receipt, omit the transaction UUID and use the returned receipt UUID with the reimbursement workflow.

## CLI-only operations

Vendor document uploads and some procurement/sourcing file uploads require the CLI. The account application, incorporation, standalone-agent onboarding, and reporting playbooks also declare CLI-only support. Follow the live schema and the relevant playbook for the specific operation.

Replace the `ramp` executable in upstream examples with:

```sh
bun <this-skill>/scripts/ramp.ts --account <OpenTeam-connection-id> <ramp arguments>
```

The helper installs official Ramp CLI 0.2.97 with pinned archive checksums on macOS/Linux ARM64 or x64. It keeps configuration and tokens in a private directory for that account and preserves arguments and standard input. It requires Bun, curl, and tar on the Bot computer. Use it for every CLI call, including sign-in, status, and logout.

MCP and CLI authorizations are separate. Check CLI status for the selected account first. If it needs sign-in, use:

```sh
bun <this-skill>/scripts/ramp.ts --account <OpenTeam-connection-id> auth login --read-only --no_browser
```

Open the returned authorization URL with the Bot computer's browser capability so the CLI can receive its loopback callback. Complete the matching account's login using available credentials and verification-code sources. For a user-authorized change that requires write access, reconnect with the access level needed for that task. Use `users me --agent` to verify the CLI identity matches the intended MCP account before financial operations. Retain the same account key on subsequent calls.

For a new-company application or standalone agent without an OpenTeam connection, choose an explicit stable setup key and verify the resulting identity before using it for other workflows. CLI credential profiles stay within that key's configuration directory.

Use `--agent` for JSON, leaf `--help` for current flags, and `--dry_run` where the playbook calls for it. Treat output and downloaded files as account data. Keep credentials out of chat, package files, and command-line arguments.

## Disconnect

OpenTeam's account disconnect controls its MCP connection. A separately authorized CLI session is logged out with the same helper and account key using `auth logout`. Include that logout when the user asks to disconnect Ramp completely. Uninstalling the plugin removes its package and skills; CLI state remains on the Bot computer until separately removed or revoked in Ramp.
