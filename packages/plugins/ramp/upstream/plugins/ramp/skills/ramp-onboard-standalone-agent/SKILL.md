---
name: ramp-onboard-standalone-agent
area: Getting Started
supported_surfaces: [cli]
description: >-
  Create, connect, and safely verify a standalone Ramp agent for a clearly
  defined job. Use when a Ramp admin needs a machine identity for reporting,
  bill intake, bill approval, payment release, or expense cleanup. For a
  person's initial Ramp or CLI setup, use ramp-get-started instead.
compatibility: Requires the Ramp CLI, a Ramp admin's dashboard access, and a local shell with secure secret entry.
---

# Set up a Ramp standalone agent

Guide a Ramp admin through one new machine identity for a clearly scoped set of responsibilities. Make the experience conversational: ask one question at a time, wait for the answer, recommend the narrowest access that fits, and explain each boundary in customer terms.

## Availability

Start every setup by telling the user:

```text
Standalone agents are currently in private preview and require access to be enabled for your Ramp account. To request access, visit [agents.ramp.com](https://agents.ramp.com/) or email [agents@ramp.com](mailto:agents@ramp.com).
```

If the user cannot see **Company > Agents** or the standalone-agent permission options, do not send them through the remaining setup steps. Explain that access is not enabled yet and direct them to one of the request-access options above. Never include credentials or secrets in an access request.

## Safety boundaries

- Require a Ramp admin. If the user is not an admin, stop and ask them to involve one.
- Never use a human credential for the agent.
- Never ask for or accept a Client secret or bearer token in chat. The user enters secrets only in their local terminal and stores them somewhere safe, such as a secret manager.
- Do not broaden permissions to fix an error. Diagnose the missing access or product availability instead.
- Verification must be read-only. Do not create, edit, approve, schedule, pay, or delete anything merely to prove the connection works.

## Interactive setup

### Existing-agent shortcut

If the user says they already created the agent, stop the new-role and new-agent creation path immediately. Ask only:

```text
What is the existing agent's name?
```

Then go directly to **Confirm the identity and assigned role** below. Do not ask which role the user assigned. The CLI agent list returns the assigned role name and ID; retrieve that information from Ramp after matching the exact agent name. Continue with runtime connection and safe verification once the active identity and assigned role are confirmed.

### 1. Establish the job

Use `production` by default. Before rendering any CLI command or helper, resolve the selected environment to one of the two CLI values below:

- No environment, `prod`, or `production` resolves to `production`.
- `demo` or `sandbox` resolves to `sandbox`.

Never interpolate user-provided environment text into a command. If the user asks for any other environment, stop and explain that this workflow supports only production and sandbox.

```text
What should this agent do in Ramp? For example: prepare weekly finance reports, prepare bill drafts, approve assigned bills, or clean up expense details.
```

An agent may have more than one responsibility. When responsibilities have different risk levels, explain the tradeoff without forcing separate agents. For example, reporting is read-only while bill approval may trigger payment. Let the admin choose one combined agent or separate identities, then grant only the access required for that choice.

### 2. Recommend the access boundary

Recommend one recipe or the smallest combination of recipes, explain what each enables in practice, and ask the admin to confirm before continuing.

#### Permission recipes

- **Reporting:** Select **View transactions and reimbursements** and **View bills and recurring bills**. These permissions let the agent read card spend, reimbursements, submitted bills, and recurring bills for reporting without changing, approving, or paying anything.
- **Reporting add-ons:** Select **View draft bills** only when the report needs bills still being prepared. Select **View all vendors** only when the report needs vendor details. These add read visibility only; they do not let the agent create, edit, submit, approve, or pay bills.
- **Bill intake:** Select **View draft bills**, **Create draft bills**, **Edit and delete draft bills**, and **View all vendors**. These permissions let the agent prepare, review, revise, and remove draft bills, and read the vendors needed to prepare them. **Edit and delete draft bills** is one checkbox. A human confirms vendor, amount, coding, and documents before submission.
- **Bill submission add-on:** Select **Create bills** only when submitting a prepared bill is explicitly part of the job. This enables submission; it does not add approval, payment-release, approval-policy, or payment-run authority.
- **Bill approval:** Select exactly **View draft bills**, **View bills and recurring bills**, and **Be assigned as an approver on approval chains**. The two view permissions let the agent read draft, submitted, and recurring bills without changing them. **Be assigned as an approver on approval chains** makes the agent eligible for an approval step; it does not route bills to the agent. The agent acts only when it is the next required approver. Completing an approval chain may trigger payment under the company's settings.
- **Transaction cleanup:** Select **Review and edit transactions**. **View transactions and reimbursements** is included as a dependency for visibility. These permissions let the agent review and update only the confirmed transaction fields, such as receipts, memos, and accounting details.
- **Payment release:** This is separate routing configuration, not an additional role-permission recipe. If the job also includes bill approval, use the **Bill approval** recipe. In [Bill payments approvals](https://app.ramp.com/settings/expense-policy/bill-pay-policy#/d/bill-approvals), turn on additional approval for payment release, add the agent as a payer, and keep a human payer in the flow. This routes only the agreed payment-release work and does not grant approval-policy editing, broad payment-run access, or authority to change routing.

For multiple responsibilities, take the union of the applicable recipes and remove duplicate permission names. Present every resulting checkbox by its exact customer-visible name and explain its purpose in the combined job. Keep role permissions separate from routing configuration: configure approval steps and payment release in **Bill payments approvals**, not by adding unrelated role permissions. State that everything outside the selected recipes remains prohibited, including approval-policy administration, payment-run access, card controls, bill administration, and any bill creation, editing, submission, approval, or payment action not explicitly included above. Procurement access is not currently available in the standalone-agent role picker; do not substitute broader permissions.

### 3. Create the role

Prescribe a clear role name from the job, such as `Weekly Finance Reporting Role`, rather than asking the user to name it. Send the admin to [Roles & Permissions](https://app.ramp.com/settings/all/roles-and-permissions) with that name and list every checkbox using its exact customer-facing label. Never paraphrase a label as “the permission that allows…” or otherwise make the admin infer which checkbox to select.

For a bill-approval-only agent, prescribe this exact configuration:

```text
Create a role named Bill Approval Agent Role and select exactly:

- View draft bills
- View bills and recurring bills
- Be assigned as an approver on approval chains

The first two permissions let the agent read draft, submitted, and recurring bills without changing them. The third makes it eligible to be added to the approval chain. Do not enable Create draft bills, Edit and delete draft bills, Create bills, approval-policy editing, payment-run, card-control, or bill-administration permissions.
```

For an agent with multiple responsibilities, use the recipe union above: list each exact checkbox once with its purpose, keep routing configuration separate, and state the prohibited actions that are outside the selected recipes. Then say:

```text
Let me know when it's created.
```

When the user says it is done, carry the prescribed role name forward. Do not ask for the role's exact name unless the user says they chose a different one.

### 4. Create the agent

Prescribe a concise agent name from the job, such as `Weekly Finance Reporter`; do not ask the user to name it. Recommend a description that states the job and boundary in one sentence, then summarize:

```text
Agent: <name>
Job: <one bounded outcome>
Role: <confirmed role>
Boundary: <what it cannot do>
```

Never imply that you can create the agent for the user. Proceed with the prescribed name and summary without asking for another naming confirmation. Say:

```text
Right now, you'll need to create the agent directly in the Ramp dashboard. Open [Company > Agents](https://app.ramp.com/company/agents), select **New agent**, enter the name and description above, assign <role>, and create it. Let me know when it's created.
```

Have the admin save the Client ID and Client secret somewhere safe, such as a secret manager, labeled with the agent name and environment. The Client secret must not be pasted into chat, shell history, a repository, or a plaintext file. The Client ID is not secret and may be shared in chat when the skill needs it; the Client secret may not.

### 5. Confirm the identity and assigned role

In the user's runtime, inspect the installed Ramp CLI before relying on commands:

```bash
ramp --version
ramp auth login --help
ramp agent list --help
```

If the CLI is missing, stop and help the user install it through their approved process. If it is outdated, explain that updating changes the local installation and ask permission before running `ramp update`.

Use the admin's existing business-authenticated CLI session only to look up the agent. Set `RAMP_ENV` to the allowlisted CLI value resolved above, then check its authentication before asking the admin to authorize again:

```bash
ramp -e "$RAMP_ENV" auth status
ramp -e "$RAMP_ENV" agent list --page_size 100
```

If the existing admin session can list agents, reuse it. Open a new business authorization only when authentication is missing, expired, or `agent list` proves the current access is insufficient:

```bash
ramp -e "$RAMP_ENV" auth login --auth-level business
```

The generated CLI accepts `--page_size` and `--start` for `ramp agent list`. Each response contains `data` and `page.next`. Start with `--page_size 100`, inspect the entries in `data`, and when `page.next` is present, extract its opaque `start` cursor and pass it to the next request as `--start "$START"` while preserving `--page_size 100`. Repeat until `page.next` is empty. Only then confirm whether exactly one active agent matches the supplied name. Read its status and assigned role from the complete result set, then tell the user what Ramp returned. Do not ask the user to restate the role. If there is no exact match or more than one plausible match, stop before using credentials and resolve the identity in Ramp. If the exact agent exists but has no assigned role, direct the user to [Company > Agents](https://app.ramp.com/company/agents) to assign one, then repeat the full lookup.

### 6. Configure approval routing — approval agents only

Skip this section entirely unless the confirmed job includes approving bills or releasing bill payments. Do not mention approval-chain setup for reporting, bill intake, expense cleanup, or other non-approval agents.

Explain that the role permission only makes the agent eligible to be selected as an approver; it does not route any bills to the agent. Send the admin to [Bill payments approvals](https://app.ramp.com/settings/expense-policy/bill-pay-policy#/d/bill-approvals) and have them add the agent to the approval step that matches its confirmed job.

Recommend conditions that keep the step within the agreed boundary, using only conditions available in the dashboard. For example, an agent responsible for higher-value software bills could be limited by amount and the relevant vendor or department rather than receiving every bill. Do not give the agent permission to edit approval policies and do not broaden its role to make this configuration work; an admin configures the chain in the dashboard.

If the confirmed job includes final payment release, also have the admin turn on additional approval for payment release, add the agent as a payer, and keep a human payer in the flow. Do not add payment-release instructions for an agent whose job ends at bill approval.

Have the admin review the resulting approval chain, then say:

```text
Let me know when it's configured.
```

### 7. Connect the agent to the runtime

Ask the user for the Client ID; it is safe to collect in chat. Never ask for the Client secret.

Keep the standalone agent's CLI authentication separate from the user's personal CLI authentication. Create a short filesystem-safe slug from the agent name, such as `weekly-finance-reporter`, and scope every agent command to:

```text
XDG_CONFIG_HOME="$HOME/.config/ramp-agents/AGENT_SLUG"
```

On macOS, generate a temporary `.command` helper containing the real Client ID, canonical environment, and slug. The helper may contain the Client ID because it is not a secret. It must never contain the Client secret. Before rendering the helper, use the mapping from step 1 and render exactly one of `RAMP_ENV='production'` or `RAMP_ENV='sandbox'`; never substitute user-provided text. Use a safely quoted Client ID and a slug containing only lowercase letters, numbers, and hyphens.

Create a private temporary directory with `mktemp -d`, set its mode to `700`, and create `connect.command` inside it with this structure:

```zsh
#!/bin/zsh
secret=''
# Render only RAMP_ENV='production' or RAMP_ENV='sandbox' from the allowlist.
RAMP_ENV='production'
cleanup() {
  unset secret
}
trap cleanup EXIT
trap 'exit 130' INT TERM

printf '%s\n' 'Connect your standalone agent to Ramp'
IFS= read -rs 'secret?Client secret: '
printf '\n'
RAMP_CLIENT_SECRET="$secret" \
  XDG_CONFIG_HOME="$HOME/.config/ramp-agents/AGENT_SLUG" \
  ramp -e "$RAMP_ENV" auth login --client-id 'CLIENT_ID'
result=$?

if (( result == 0 )); then
  printf '%s\n' 'Connected. Return to your agent to continue verification.'
else
  printf '%s\n' 'Connection failed. Return to your agent with the error above.'
fi
exit "$result"
```

Make the helper executable with mode `700`, then open its exact path directly in Terminal. Do these local actions for the user; do not ask them to copy or paste the helper, Client ID, or authentication command:

```bash
chmod 700 /PRIVATE_TEMP_DIRECTORY/connect.command
open -a Terminal /PRIVATE_TEMP_DIRECTORY/connect.command
```

Tell the user that Terminal is open and ask them to paste the Client secret into its hidden prompt and press Return. The secret is held only for the login process and is unset when the helper exits. If the runtime cannot create local files or open Terminal, explain that limitation and provide the helper as a file; ask the user to open the file rather than pasting a long command into their shell. Tailor the helper when the user's local shell or operating system is not zsh on macOS. The CLI does not currently provide its own secure Client-secret prompt.

Verify the isolated connection without replacing personal auth:

```bash
XDG_CONFIG_HOME="$HOME/.config/ramp-agents/AGENT_SLUG" ramp -e "$RAMP_ENV" auth status
```

Authentication status proves the isolated agent identity is connected; it does not prove that its access is correct. Agent access tokens expire and do not refresh automatically, so a long-running runtime must repeat the same client-credential login when needed without exposing the secret.

### 8. Verify one safe action

Inspect current CLI help for the job's read operation, then run one small, read-only check using the same command-scoped `XDG_CONFIG_HOME` prefix. This verification runs under the isolated agent session, not the admin's business session:

- finance reporting: list a few transactions or bills needed for the report
- bill intake: list a few draft bills; do not create one
- bill approval: list bills awaiting the agent; do not approve one
- expense cleanup: list a few transactions; do not edit one

Explain the expected result before running it. Success means the agent can read the minimum data its job needs. Do not require a deliberate authorization failure or probe unrelated company data.

If the expected read is unavailable, keep the role unchanged. Check the exact non-secret error, current CLI help, and whether the workflow is enabled for the business. If those do not distinguish product availability from role or authentication setup, route the user to [agents.ramp.com](https://agents.ramp.com/) or `agents@ramp.com`.

## Finish

Return a concise readiness summary:

```text
Agent: <name>
Environment: <environment>
Job and role: <bounded outcome; assigned role>
Credentials: stored securely; no secret values displayed
Runtime connection: connected / blocked
Safe verification: <read-only action and result>
Ready for: <the confirmed workflows>
Open blocker: <none, or owner and next action>
```

Do not stop after the readiness summary. Always add a **What you can do now** section with one or two concrete examples tailored to the confirmed job. For a bill approval agent, explain that the user can now ask the connected runtime to show bills routed to the agent, review a bill's available details, and approve or reject it under the user's stated decision rules. Example requests include:

```text
Show me the bills waiting for Bill Approval Agent.
Review the Acme bill and summarize anything I should check before approving it.
Approve the Acme bill if it matches the decision rules we agreed on; otherwise escalate it to me.
```

Make clear that routing conditions decide which bills reach the agent, while decision rules decide which of those bills it may approve. Before unattended approval, the user should define rules for amount limits, required documentation, vendor exceptions, accounting or policy checks, and when the agent must escalate to a human. If those rules have not been defined, say the agent is ready for interactive use but not yet ready for unattended approvals.

Then always add a **Ways to use this agent** section. This section is mandatory even when the user has not asked for deployment help. Proactively explain all of these options in customer terms:

- **Use it in the current connected runtime:** The user can make on-demand requests for the confirmed job, such as listing the approval queue, reviewing a bill, or approving a bill under confirmed decision rules.
- **Call the Ramp API:** The Client ID and Client secret can authenticate a service that calls the [Ramp API](https://docs.ramp.com/). For example, an internal approval service can check bills routed to this agent and act according to company rules. API access remains limited by the agent's assigned role and granted scopes.
- **Use the Ramp CLI:** The isolated agent login can be used for ad hoc commands or scripts without replacing the user's personal Ramp login. Ordinary unprefixed `ramp ...` commands continue using personal authentication; if `XDG_CONFIG_HOME` was exported, `unset XDG_CONFIG_HOME` returns to it.
- **Run it in an agent or automation:** The credentials can be stored in Claude managed agents, a Hermes agent, a cron job, or another runtime. That runtime can run the job on demand, poll or run on a schedule, and reauthenticate when the agent token expires.
- **Retain clear attribution:** Actions performed with these credentials are attributed to this standalone agent in Ramp activity logs and other Ramp surfaces, so the business can distinguish the agent's work from a person's actions.

Follow with a **Recommended next step** tailored to the job. For a bill approval agent, recommend documenting the approval decision rules and escalation path, then either continuing interactively in the connected runtime or placing the credentials and operational skill in the user's chosen long-running runtime. For a reporting agent, recommend defining the report contents and schedule. For other jobs, recommend the equivalent operating instructions and trigger.

When describing a long-running setup, give the concrete sequence without waiting for the user to ask:

1. Store the Client ID and Client secret in the runtime's secure credential storage; never paste the Client secret into chat or source code.
2. Give the runtime the operational instructions or skill for the confirmed job, including decision rules and escalation paths where actions can change data or move money.
3. Choose an on-demand or scheduled trigger appropriate to the job.
4. Reauthenticate with the client credentials when the agent token expires.

Offer to continue with the user's preferred option, but do not make the explanation above conditional on that choice.

Keep the handoff customer-facing. Do not mention repositories, local skill copies, installation provenance, internal validation, or whether a skill was pulled.

End by asking: `If you have feedback on this setup process, tell me now and I can submit it using the Ramp CLI feedback tool.` If the user provides feedback, submit their words with `ramp feedback "FEEDBACK"` and report whether the submission succeeded.
