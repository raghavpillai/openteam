---
name: ramp-manage-sourcing
area: Procurement
supported_surfaces: [cli, mcp]
compatibility: Requires authenticated Ramp CLI or Ramp MCP access and permission to manage sourcing events.
description: |-
  Track and decide running Ramp sourcing events: monitor vendor responses to an
  RFX (RFP, RFI, RFQ), send reminders, review grading outcomes,
  award the winning vendor, and close out. Use when: 'who responded to our
  RFP', 'compare RFP responses', 'remind vendors to respond', 'award the RFP',
  or 'close the sourcing event'. Do NOT use to create, edit, or publish an RFX
  or invite vendors (use ramp-run-sourcing-event), or to fill and submit the
  follow-on purchase request (use ramp-submit-procurement-request).
---

# Manage Sourcing

Use this skill after an RFX is published: response tracking, reminders,
grading review, awarding, closing, and the handoff into a procurement request
for the winning vendor.

For building or changing the questionnaire, sheets, vendor list, or publishing,
use `ramp-run-sourcing-event`.

## Rules

- Run commands with `--agent` and pass `--rationale` every time; with `--json`,
  put `rationale` in the JSON body. Command aliases are kebab-case, option
  names are snake_case, and required `*_id`/`*_uuid` inputs are positional.
- Keep identifiers labeled: `sourcing_event_id` (award/close act on this),
  `rfx_id` (tracking acts on this), `invitation_id`, `payee_uuid`. Never
  invent IDs; take them from prior responses.
- Awarding decides the event for one vendor and closing ends it — both need
  the user's explicit confirmation after seeing the current state.
- A direct award notifies the winner and eligible non-winning vendors outside
  Ramp. Confirmation must show those recipients, not just the proposed winner.
- When an action is unavailable for the current status, fix the state or stop;
  do not retry blindly.
- Responses render dates in HTTP-date form; convert before showing the user.
- Do not offer vendor clarification Q&A; it is not supported.
- For pricing comparisons, send the user to the RFX Pricing tab in Ramp.
- This is a requester-side skill. Vendor RSVP, NDA signing, draft responses,
  XLSX import/export, final submission, and pricing-line entry belong in the
  vendor portal and cannot be completed with this requester skill.

## Workflow

1. Locate the evaluation, then load its full state:

   ```bash
   ramp sourcing list --rationale "Find the sourcing event the user is asking about" --agent
   ramp sourcing event "<sourcing_event_id>" --rationale "Load event status, RFXs, and vendor progress" --agent
   ```

   If `next_page_cursor` is not null, continue listing with `--page_cursor`
   until it is null before concluding the event is absent. Preserve the same
   `--page_size` on every page and never alter the returned cursor.

   The event payload includes each RFX with per-vendor invitation status,
   acceptance, and whether a response was submitted.

2. Track one RFX. Use `summary` for progress counts and grading mode, and
   `responses` only when the user wants the actual submitted answers:

   ```bash
   ramp sourcing summary "<rfx_id>" --rationale "Check vendor response and grading progress" --agent
   ramp sourcing responses "<rfx_id>" --rationale "Review the submitted vendor answers" --agent
   ```

   `grading_mode` is `AI_ONLY` or `MANUAL_REVIEW`.
   `suggested_grading_status` reports AI grade generation for a response, not
   overall or manual grading completion.

3. Nudge vendors with an ACTIVE invitation who have not rejected participation
   or submitted a response. A per-vendor cooldown prevents duplicate reminders.
   Show the exact vendors and contacts that will receive a reminder and get the
   user's confirmation before sending. Pass invitation IDs to remind a confirmed
   subset:

   ```bash
   ramp sourcing remind "<rfx_id>" --json '{"rationale": "Remind the confirmed vendors before the deadline", "rfx_vendor_invitation_ids": ["<invitation_id>", "<invitation_id>"]}' --agent
   ```

   Omit `rfx_vendor_invitation_ids` only when the user has confirmed every
   eligible vendor. Report which reminders were scheduled and which were
   skipped due to cooldown.

4. Review outcomes. The grading overview — AI-generated takeaways,
   recommendation, per-vendor section scores, and recorded field grades —
   becomes available once the RFX is GRADED or CLOSED. The RFX becomes GRADED
   after all accepted vendors have submitted, automated grading completes, and
   no still-open pending RSVP blocks completion.

   `mark-graded` is the normal UI's destructive **End submissions early**
   action, not general finalization. Use it only when at least one response was
   submitted and the user explicitly wants to stop remaining vendors from
   RSVPing or submitting. Show every unfinished active vendor and confirm that
   submissions cannot resume before calling it:

   ```bash
   ramp sourcing mark-graded "<rfx_id>" --rationale "User confirmed ending remaining vendor submissions early" --agent
   ramp sourcing grading "<rfx_id>" --rationale "Review grading outcomes and the AI recommendation" --agent
   ```

   Check `grading_insight.status`; do not claim there is an AI recommendation
   when the insight or recommended vendor is absent. Present any recommendation
   as input, not a decision — the user chooses the winner. Each recorded grade's
   `grade_state` distinguishes an `AUTO_ACCEPTED` AI grade from a
   `HUMAN_EDITED` grade.

5. Award the winner. Grading must be complete on the current RFX, and the
   winner must have an ACTIVE invitation, have accepted, and have submitted a
   response. Re-fetch the RFX before confirmation. Show the grading outcome,
   explain that vendor settings may deactivate draft vendor records used only
   for non-winning invitations, and show the exact contacts who will be
   notified: the winner, plus every non-winning
   ACTIVE vendor that has not rejected participation. State that a direct award
   decides the event, closes its current RFX, and sends those notifications;
   act only on explicit confirmation after showing that list:

   ```bash
   ramp sourcing rfx "<rfx_id>" --rationale "Preflight award eligibility and notification recipients" --agent
   ```

   ```bash
   ramp sourcing award "<payee_uuid>" "<sourcing_event_id>" --rationale "User confirmed awarding the event to the selected vendor" --agent
   ```

   `submitted_for_approval: true` means an award approval policy routed the
   decision to approvers in the Ramp app first; the event is still ACTIVE and
   no award notifications have been sent yet. Tell the user and stop — there is
   no CLI approval step. Approval later decides the event and sends the vendor
   notifications.

6. Close out. Closing archives the event and cascades every RFX to CLOSED
   (voiding outstanding e-sign envelopes). On an ACTIVE event this ends it
   without an award; on a DECIDED event it archives the already-awarded event.
   Confirm the event and those effects first:

   ```bash
   ramp sourcing close-event "<sourcing_event_id>" --rationale "User confirmed archiving the sourcing event and closing all child RFXs" --agent
   ```

7. Hand off to purchase. After awarding, list procurement spend programs. Show
   the best matching program by name/description and alternatives; if multiple
   programs fit, require the user to choose. Then confirm before creating the
   persistent draft. Pass the selected spend intent, awarded vendor, and
   awarded RFX so the request is pre-filled with the correct response context.
   This call is not deduplicated, so do not repeat it after an ambiguous
   timeout:

   ```bash
   ramp procurement_requests spend-intents --page_size 50 --rationale "List procurement spend programs for the awarded sourcing event" --agent
   ramp sourcing draft-spend-request "<sourcing_event_id>" --rfx_id "<rfx_id>" --payee_uuid "<awarded_payee_uuid>" --spend_intent_uuid "<selected_spend_intent_uuid>" --rationale "User confirmed drafting the purchase request under the selected spend program" --agent
   ```

   Then switch to `ramp-submit-procurement-request` to fill and submit the
   returned draft.

## Output

For event or RFX tracking, keep rows compact using returned fields:

```text
vendor | invitation status | accepted? | responded? | contact
```

For a decision summary before award:

```text
Event:
RFX and type:
Responses submitted:
Grading status:
Top-scored vendor:
AI recommendation and reasoning:
Proposed winner:
Winner notification contact:
Non-winning notification contacts:
```

After any write, report the returned status and message verbatim in user
language. Never show CLI commands, flags, or JSON to the end user.

## Handoff

Hand off instead of guessing when the user asks to change the questionnaire,
sheets, vendors, or publish state (`ramp-run-sourcing-event`); to fill or
submit the purchase request (`ramp-submit-procurement-request`); or when a
publish or award is pending approval in the Ramp app. Include:

```text
Sourcing event ID:
RFX ID:
RFX status:
Pending approval: publish / award / none
Awarded vendor payee UUID (if any):
Draft spend request UUID (if any):
```
