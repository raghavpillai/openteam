---
name: ramp-run-sourcing-event
area: Procurement
supported_surfaces: [cli, mcp]
compatibility: Requires authenticated Ramp CLI or Ramp MCP access and permission to manage sourcing events.
description: |-
  Create and launch Ramp sourcing events: build an RFI, RFP, or RFQ
  questionnaire, set the vendor-facing cover sheet and pricing sheet, invite
  vendors, and publish to collect responses. Use when: 'run an RFP', 'create a
  sourcing event', 'draft an RFQ', 'send a questionnaire to vendors', 'invite
  vendors to bid', or 'publish our RFX'. Do NOT use to track responses, grade,
  award, or close a running event (use
  ramp-manage-sourcing), or to submit a purchase request for a chosen vendor
  (use ramp-submit-procurement-request). This is a requester-side skill; do not
  use it to RSVP or respond as a vendor.
---

# Run Sourcing Event

Guide the user conversationally through building and launching a vendor
evaluation. Use `ramp sourcing` commands. Resolve CLI flags, JSON shapes, and
object IDs without asking the user to understand them.

## Rules

- Run commands with `--agent` and pass `--rationale` every time except
  `sourcing upload`, whose multipart schema has no rationale field. With
  `--json`, put `rationale` in the JSON body.
- Command aliases are kebab-case; option names are snake_case. Required
  `*_id`/`*_uuid` inputs are positional. Complex payloads go in
  `--json '{...}'`.
- Keep identifiers labeled and distinct: `sourcing_event_id` (the evaluation
  container), `rfx_id` (one questionnaire), `invitation_id` (one vendor's
  invitation), `payee_uuid` (the vendor), `ramp_document_id` (an uploaded
  attachment). Never invent any of them; resolve vendors with
  `ramp vendors search`.
- Dates are sent as `YYYY-MM-DD` and must be in the future. Responses may render
  dates in HTTP-date form; convert them before showing the user.
- Everything before publish is a private draft; nothing is sent to vendors.
  Publishing sends the RFX externally to every active invitation contact, so it
  requires an explicit user confirmation after showing exactly who will be
  contacted.
- Adding a vendor to an already-PUBLISHED RFX can send that vendor access
  immediately. Do not use the CLI for that path because its vendor lookup does
  not expose the default contact needed for recipient-aware confirmation; send
  the user to the RFX vendor list in Ramp instead.
- The cover sheet and pricing sheet are vendor-facing. Get the user's explicit
  approval of their wording and every attachment before setting them.
- After any edit, re-fetch with `ramp sourcing rfx` and work from the returned
  state; do not reuse section or field IDs from earlier responses.
- Do not offer vendor clarification Q&A; it is not supported.
- `create` and `upload` are not safe to repeat after an ambiguous timeout.
  Re-list events before retrying `create`; do not retry an uncertain upload
  automatically.

## Workflow

```text
scope the evaluation -> create event + RFX questionnaire -> refine sections
-> optional cover sheet + pricing sheet -> invite vendors -> resolve contacts
-> preflight with rfx detail -> confirm recipients with user -> publish
```

## Unsupported Requests

Use the Ramp app when the user needs estimated amount/range, conditional
question visibility, questionnaire generation from an uploaded file,
post-publish due-date changes, or an NDA template. Ask whether an NDA is
required before publishing; this skill cannot configure or verify one.

Vendor RSVP, NDA signing, draft responses, XLSX import/export, final submission,
and pricing-line entry must be completed in the vendor portal. Do not attempt
those actions with this requester skill.

Creation supports one RFI, RFP, or RFQ in a new sourcing event. This skill
cannot add another RFX to an existing event; do not offer that workflow.

## Create the Event and RFX

Check what already exists before creating anything:

```bash
ramp sourcing list --rationale "List sourcing events before creating a new one" --agent
```

If `next_page_cursor` is not null, repeat with the exact cursor until it is null
before concluding that no matching event exists. Keep the same page size:

```bash
ramp sourcing list --page_size 20 --page_cursor "<next_page_cursor>" --rationale "Continue checking for an existing sourcing event" --agent
```

Choose the RFX type based on the user's goal, recommend one when the choice is
unclear, and confirm it before creation:

- Use **RFI** to gather capabilities or market information while requirements
  are still being shaped.
- Use **RFP** to compare proposed approaches and overall fit for a scoped need.
- Use **RFQ** to compare pricing and commercial terms for a well-defined need.

Build the selected RFX questionnaire as sections of fields.
Field types: TEXT, PARAGRAPH, NUMBER, BOOLEAN, DATE, FILE_UPLOAD,
TEXT_SINGLE_SELECT, TEXT_MULTI_SELECT, ADDRESS, CONTACT, EMAIL, LINK. `choices`
is a list of plain strings, required for the two select types and invalid
elsewhere. Section labels must be unique, as must field labels within a
section.

**Creating an RFX is a write** — confirm the type, name, deadlines, and section
outline with the user first. Omit `sourcing_event_id` so the tool creates the
parent event in the same call. `rfx_type` accepts `RFI`, `RFP`, or `RFQ` and
defaults to `RFP` when omitted:

```bash
ramp sourcing create --json '{
  "rationale": "User confirmed creating the RFP draft",
  "name": "Expense Management RFP",
  "rfx_type": "RFP",
  "close_date": "<future YYYY-MM-DD>",
  "response_submission_deadline": "<future YYYY-MM-DD on or after close_date>",
  "sections": [
    {
      "label": "Vendor Background",
      "fields": [
        {"label": "Company overview", "field_type": "PARAGRAPH", "required": true},
        {"label": "SOC 2 Type II certified", "field_type": "BOOLEAN", "required": true},
        {"label": "Deployment model", "field_type": "TEXT_SINGLE_SELECT",
         "required": true, "choices": ["Cloud", "On-prem", "Hybrid"]}
      ]
    }
  ]
}' --agent
```

`close_date` is the vendor RSVP deadline; `response_submission_deadline` is
when answers are due and must be on or after it. Both are required before
publishing.

Do not put pricing questions or an introduction section in the questionnaire —
pricing lives on the pricing sheet and the introduction on the cover sheet.

## Refine the Questionnaire

`ramp sourcing edit` replaces the entire questionnaire. Fetch the current
structure, apply the user's change to the full section list, and resubmit all
of it. Sections are recreated with new IDs; sending only the changed section
deletes the rest:

```bash
ramp sourcing rfx "<rfx_id>" --rationale "Fetch the current questionnaire before editing" --agent
ramp sourcing edit "<rfx_id>" --json '{
  "rationale": "Add the requested security section to the draft RFP",
  "name": "Expense Management RFP",
  "sections": [ <the complete updated section list> ]
}' --agent
```

Use `edit` only when the returned status is DRAFT. Do not edit a PUBLISHED RFX;
questionnaire changes cannot be sent to vendors through these commands. Omitted
scalar fields (name, dates, description) stay unchanged.

To discard a draft entirely, close the parent sourcing event with
`ramp sourcing close-event` (see ramp-manage-sourcing). This skill cannot delete
one RFX while keeping its event.

## Cover Sheet and Pricing Sheet (optional, vendor-facing)

Offer these after the questionnaire exists; never set them without the user
approving the exact content. Attachments are uploaded first, then referenced by
`ramp_document_id` (JPEG/JPG, PNG, HEIC/HEIF, WebP, PDF, DOC, DOCX, XLS, or
XLSX; at most 20 per sheet and 50 MB per file). Uploads require the Ramp CLI.
MCP callers must hand the upload step to a CLI-capable caller and resume with
the returned `ramp_document_id`:

```bash
ramp sourcing upload --file "/absolute/path/to/pricing-template.xlsx" --agent
```

Reuse the returned `ramp_document_id`. A successful upload is not idempotent;
do not upload the same file again merely because a later output-inspection step
failed.

The cover sheet is the introduction vendors see first:

```bash
ramp sourcing cover-sheet "<rfx_id>" --json '{
  "rationale": "Set the user-approved vendor-facing cover sheet",
  "body_markdown": "<user-approved introduction, timeline, and contact>",
  "attachment_ramp_document_ids": ["<ramp_document_id>"]
}' --agent
```

Creating a pricing sheet enables vendor pricing on the RFX; vendors then submit
line-item pricing alongside their answers:

```bash
ramp sourcing pricing-sheet "<rfx_id>" --json '{
  "rationale": "Enable vendor pricing with the user-approved guidance",
  "currency": "USD",
  "guidance_markdown": "<user-approved pricing instructions>",
  "attachment_ramp_document_ids": []
}' --agent
```

Attachment lists are ordered full replacements: `[]` clears, omit to leave
unchanged.

## Invite Vendors

Resolve each vendor to a `payee_uuid` first; present matches and use an
existing vendor over creating anything new:

```bash
ramp vendors search --search_term "<vendor name>" --limit 10 --rationale "Resolve the vendor to invite to the RFX" --agent
ramp sourcing invite "<rfx_id>" --json '{
  "rationale": "Invite the user-selected vendors to the draft RFX",
  "vendors": [{"payee_uuid": "<payee_uuid>"}]
}' --agent
```

If no suitable vendor exists and the user wants to create one, collect the
exact vendor name and contact email, show them to the user, and confirm before
creating the persistent vendor record:

```bash
ramp vendors create --json '{"rationale": "User confirmed creating this vendor for the sourcing event", "name": "<vendor name>", "contact": {"email": "<contact email>", "first_name": "<optional>", "last_name": "<optional>"}}' --agent
```

Use the returned `payee_uuid`; the returned contact becomes the vendor's
default and is selected automatically when inviting.

A vendor with no contact on file is added as a DRAFT invitation and blocks
publishing until resolved. Send the user to the RFX vendor list in Ramp to set
the vendor's default contact, then re-fetch the RFX. To remove the vendor
instead, confirm that choice first:

```bash
ramp sourcing revoke "<invitation_id>" --rationale "Remove the vendor at the user's request" --agent
```

Revoking is irreversible; a DRAFT invitation is deleted,
while an ACTIVE invitation is revoked. On a published RFX the vendor immediately
loses access and an outstanding e-sign envelope is voided. Show those effects
and get explicit confirmation before revoking. Publishing requires between 1
and 10 active invitations. To let teammates help edit a DRAFT RFX, add them as
collaborators after resolving their user UUIDs; never guess them:

```bash
ramp sourcing collaborators "<rfx_id>" --json '{"rationale": "Add the user-confirmed RFX collaborators", "add_user_uuids": ["<user_uuid>"]}' --agent
```

Events use automatic scoring. To remove a collaborator, use the same command
with `remove_user_uuids` after confirming the exact user whose access will be
removed.

## Preflight and Publish

Always preflight immediately before publishing:

```bash
ramp sourcing rfx "<rfx_id>" --rationale "Preflight the RFX before publishing" --agent
```

Check `available_actions` for the `publish` entry: when denied, fix the stated
blocker (missing dates, draft invitations without contacts, vendor count)
instead of retrying. Then show the user, in plain language: the RFX name and
type, the deadlines, the section count, and **the exact contacts for only the
`vendors` entries whose `invitation_status` is ACTIVE**. Those are the publish
recipients; DRAFT and REVOKED invitations are not. Publish only after the user
explicitly confirms that list — a confirmation given before seeing it does not
count:

```bash
ramp sourcing publish "<rfx_id>" --rationale "User confirmed sending the RFP to the listed vendor contacts" --agent
```

Read the response: `submitted_for_approval: true` with status `IN_REVIEW` means
a publish approval policy routed it to the designated approvers in the Ramp app
first — nothing was sent yet, and it publishes automatically once approved.
There is no CLI approval step. Status `PUBLISHED` means the active vendor
contacts have been notified. A second publish call fails cleanly.

If approval is rejected, status becomes `REJECTED` and no vendor was notified.
When the user wants to revise it, return it to DRAFT, re-fetch it, restore the
RSVP deadline (returning to draft clears `close_date`), and submit a full-section
edit before publishing again:

```bash
ramp sourcing return-to-draft "<rfx_id>" --rationale "Return the rejected RFX to draft for the user's requested revisions" --agent
```

Published questionnaire changes cannot be sent through these commands. If the
questionnaire must change, create a new sourcing event with a corrected RFX;
confirm with the user before closing the old event.

## Stop and Ask

Stop instead of guessing when:

- More than one existing sourcing event or RFX plausibly matches the user's
  request.
- Vendor search returns multiple plausible matches.
- No existing vendor matches and the user has not confirmed creating one, or
  an existing vendor has no default contact.
- The user has not approved the exact cover sheet or pricing sheet content, or
  which uploaded file to attach.
- `available_actions.publish` stays denied after fixing the stated blockers.

Once responses arrive, hand off tracking, grading, awarding, and closing to
`ramp-manage-sourcing`. Include the `sourcing_event_id` and `rfx_id`.
