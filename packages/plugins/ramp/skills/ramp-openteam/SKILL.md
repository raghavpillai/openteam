---
name: ramp-openteam
description: Use Ramp in OpenTeam through the connected MCP account and official finance playbooks.
---

# Ramp in OpenTeam

Resolve the user's intended Ramp account with `GetDynamicTools`, then use its actual namespace and schemas with `CallDynamicTool`. The selected Ramp access level and the user's role control available actions.

Read the relevant installed `ramp-*` playbook and its supporting references under `../../upstream/plugins/ramp/skills/` relative to this skill. The original playbooks include CLI examples: translate their intent into the connected MCP tools instead of installing or invoking the Ramp CLI. Resolve conceptual names such as `ListCards` against the live tools, their descriptions, and required inputs. Actual names include `ramp_list_cards` and `ramp_get_simplified_user_detail`; OpenTeam adds the account namespace.

Use the live schemas when upstream examples lag the service. Bill approval is available through `ramp_approve_or_reject_bill` when the account exposes it, despite older playbook statements. Approval may advance payment. Confirm a mutation's result before reporting success, and inspect ambiguous results before retrying. Read all pages needed for the requested scope.

Use OpenTeam's available browser capability for checkout and sign-in. If an operation is absent from the live MCP tools, explain the limitation and direct the user to the matching Ramp web workflow. CLI-only account application, incorporation, standalone-agent setup, and reporting playbooks are not included. Vendor and some procurement/sourcing file uploads are unavailable through this plugin; use available MCP tools to check existing upload batches.

## Receipt uploads

Connect with Full access and check that the selected account exposes `ramp_request_receipt_upload_link`. For a receipt file on the Bot computer, follow `ramp-complete-expenses`: confirm the transaction match, check `ramp_get_transaction_missing_items`, then request a link for that transaction only when its receipt is missing. Use the returned instructions to upload the local file over HTTPS. Keep the single-use URL private and check its expiry. After HTTP 201, re-read the missing items and verify `missing_receipt` is false before reporting success. Never put receipt bytes or base64 into an MCP call.

Use `ramp_open_receipt_uploader` only when the host renders its interactive upload card. A chat attachment must be available as a local file on the Bot computer for the upload-link path. For an out-of-pocket receipt, omit the transaction UUID and use the returned receipt UUID with the reimbursement workflow.
