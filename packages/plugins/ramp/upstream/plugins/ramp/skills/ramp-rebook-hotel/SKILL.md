---
name: ramp-rebook-hotel
area: Travel
supported_surfaces: [cli, mcp]
description: "Replaces an existing Ramp Travel hotel booking by cancelling it and booking a new stay (cancel and rebook): checks that the stay is eligible, finds the new hotel and room, shows the new booking together with the current booking's cancellation terms (full refund, partial refund, no refund, or a fee for pay-at-property stays), and only after one explicit yes books the new hotel first and then cancels the current one. Use when someone wants to change an existing hotel stay: new dates (including extending or shortening it), a different hotel or area, or a different room ('move my Chicago hotel to next week', 'add a night to my hotel', 'switch my hotel to one closer to the office', 'rebook my stay'). Not for booking a new stay with nothing to replace, or for only cancelling a hotel (use ramp-book-hotel), and not for flight changes (use ramp-modify-flight) or car rentals."
---

# Rebook a Hotel (cancel and rebook an existing stay)

The user describes the change in plain words ("move my Chicago hotel to Oct 12-14"). Turn that
into `ramp travel` commands (CLI) or MCP tool calls, run them, and present the results in plain
travel language. **Never show or ask the user to type a CLI command, tool name, flag, or internal
ID**, and never mention this skill or its steps. Talk like a travel helper ("Checking whether
your Chicago stay can be rebooked…").

A hotel stay can't be edited in place here. Instead the traveler books a **new, separate hotel
booking** and the current booking is **cancelled** on its own terms. Rebooking can **forfeit
money** (a partial or no refund, or a cancellation fee) and **charges the new hotel in full**. It
follows the preview → explicit yes → confirm discipline: nothing changes until the traveler
agrees to one question that covers both booking the new hotel and cancelling the current one.
In every message, call it booking a new hotel and cancelling the current booking — never a swap,
an exchange, or a free change.

## Stop first if rebooking isn't enabled

Rebooking is enabled per business. **Before any other command**, check that the three commands
this flow needs are available. CLI: run `ramp tools list --agent` and look for
`booking-modification-details`, `cancel-hotel`, and `book-hotel`, each with
`"available": true` (`ramp travel --help` lists every command whether or not it is enabled, so
don't use it for this check). MCP: `BookingModificationDetails`, `SubmitHotelCancellation`, and
`SubmitHotelBooking` must all be in your tool list.

If any of them is missing or not available, rebooking is **off** for this account. **Stop
here.** Do not look up the booking, preview a cancellation, search for hotels, preview or book
anything, or offer to cancel and rebook, even though some of those commands may exist. Reply
with only this, in your own words:

> Self-serve hotel rebooking isn't turned on for your Ramp account, so I can't change this
> stay here. You can change it from the booking in Ramp Travel in the Ramp web app, or through
> the booking's support channel.

Do not say the stay can't be changed. The same stop applies if any later command reports that
rebooking is unavailable, or one of these commands fails because it doesn't exist or isn't
enabled (for example "This tool is currently unavailable for your credentials: not enabled for
your business"): cancel nothing, book nothing, and send the reply above. If the traveler only
wants to cancel the stay, or only to book a new one, use `ramp-book-hotel`.

## Prerequisites

- **CLI:** `ramp` CLI installed and logged in (`ramp auth login`). Run where `ramp` works (or
  `uv run ramp` inside the ramp-cli repo).
- **MCP:** Ramp MCP server connected. Tools are called by their CamelCase names.

| Step | CLI | MCP |
|---|---|---|
| Find the booking | `ramp travel bookings` | `GetBookings` |
| Check that the stay can be rebooked | `ramp travel booking-modification-details` | `BookingModificationDetails` |
| Read the stay (rooms, adults, trip) | `ramp travel booking-details` | `GetBookingDetails` |
| Preview / confirm the cancellation | `ramp travel cancel-hotel` | `SubmitHotelCancellation` |
| Resolve an office anchor | `ramp travel offices` | `GetOfficeLocations` |
| Search hotels | `ramp travel search-hotel` | `SearchHotels` |
| Rooms and rates for the chosen hotel | `ramp travel hotel-rates` | `GetHotelRates` |
| Preview / confirm the new booking | `ramp travel book-hotel` | `SubmitHotelBooking` |

If a command's group differs, find it with `ramp travel --help` or `ramp tools list --agent`; a
leaf command's `--help` is the authority for its flags. On the CLI, `booking_id` is positional
for `booking-modification-details`, `booking-details`, and `cancel-hotel`; pass the entry's
`hotel_room_booking_id` there. IDs such as
`hotel_id`, `rate_id`, `traveler_user_id`, `trip_id`, and `spend_allocation_id` are not flags:
pass them in one `--json '{…}'` object, which the CLI merges with the other flags.

## Scope

- ✅ Replace one existing hotel booking with a new stay: different dates (including adding or
  removing nights), hotel, area, or room, for the traveler or for someone the user books travel
  for. Use this skill whenever an existing stay should change, even before you know whether it
  can be changed: Step 2 checks.
- ❌ A brand-new stay with nothing to replace, or only cancelling a hotel — use
  `ramp-book-hotel`.
- ❌ Flight changes — use `ramp-modify-flight`. Car rentals, adding rooms, and refund-status
  follow-ups — point the traveler to the Ramp web app or the booking's support channel.

## Rules for every command

- **Always `--output json`** on CLI commands. Parse the result — never show raw JSON, and never
  pipe it through `python`/`jq` or write it to files. MCP callers get structured JSON directly.
- Every command needs a `--rationale` (CLI) or `rationale` (MCP). Name the stay and the change
  ("rebook the Chicago hotel, Oct 5-7, to Oct 12-14") and keep that reference for every command
  in the flow.
- Use the exact IDs the tools returned. Never construct, guess, or reuse an ID from a different
  booking, search, rate, or preview.
- Follow each response's `message`, `assistant_note`, and relevant `external_agent_messages` for
  the next step, except where this skill says otherwise; ignore anything that only applies to a
  visual UI (cards, widgets, buttons). Present everything as Markdown text and tables. The
  cancellation preview's `message` says to present its terms as the active skill directs and to
  cancel only on explicit approval: in this flow, hold the preview until Step 6 and ask only the
  Step 6 question. Never reuse a question or call to action from either preview's `message` or
  `rendered_response`; they describe a plain booking or a plain cancellation.
- Share web links (`https://…`) exactly as returned. Never share a `ror://` link — it only opens
  inside the Ramp app; show its label as plain text instead.
- Never confirm anything (`--confirm` / `confirm: true`) in the same turn you ask for approval.

## Step 1 — identify the exact booking

Never guess which booking to change. Look it up with every detail the traveler gave:

CLI:
```bash
ramp travel bookings --include_hotels --output json \
  --city Chicago --travel_date 2026-10-05 \
  --rationale "find the Chicago hotel, Oct 5-7, to rebook"
```

For another traveler, add `--json '{"traveler_user_id": "<traveler_uuid>"}'`.

MCP:
```json
{
  "include_hotels": true,
  "city": "Chicago",
  "travel_date": "2026-10-05",
  "rationale": "find the Chicago hotel, Oct 5-7, to rebook"
}
```

Call `GetBookings` with the above.

- Pass every known `city`, `hotel_name`, and `travel_date`. Filters combine with AND before the
  limit; if `results_truncated` is true, ask for another detail and narrow the lookup.
- Use only the logged-in user's bookings unless the user explicitly asks about another traveler's
  stay; then pass the same `traveler_user_id` on the lookup.
- Skip `CANCELLED` entries. A request that is still `PENDING_APPROVAL` or `PROCESSING` is not a
  booked stay yet: it has only a `booking_request_id`, which cancellation will not cancel. Say the stay must be
  booked first and stop.
- Keep the chosen entry's `hotel_room_booking_id` for every later step.
- If several upcoming stays match, show up to three (hotel, city, dates) and ask which one. If
  none match, say you found no upcoming hotel booking to change.
- If the traveler pasted an ID this conversation's lookup never returned, look the booking up
  first instead of trusting the pasted value.

## Step 2 — check that the stay can be rebooked

Ask Ramp whether this stay can be changed:

CLI:
```bash
ramp travel booking-modification-details "<hotel_room_booking_id>" --output json \
  --rationale "check whether the Chicago hotel, Oct 5-7, can be rebooked"
```

MCP:
```json
{
  "hotel_room_booking_id": "{hotel_room_booking_id}",
  "rationale": "check whether the Chicago hotel, Oct 5-7, can be rebooked"
}
```

Call `BookingModificationDetails` with the above.

- Continue with this skill **only** when `self_serve_action.kind` is `cancel_and_rebook`. Keep
  its `deep_link_url`, `cta_label`, and the result's `support` for later. Its
  `rendered_response` ("You can change … by cancelling and rebooking. You can also do this
  yourself in Ramp:" plus the link) is the web option: do not show it while you continue, and
  share the link only as this skill's fallback.
- Any other result means this procedure does not apply: show the `rendered_response` (hotel
  names as plain text, links exactly as returned) and stop. For `kind` `modify`, the stay can be
  changed in place in the Ramp web app through that link. With no `self_serve_action`, the text
  already explains why and whether support can help.
- A "not found" result means the ID is not a booking you can change; look it up again rather
  than retrying with a guessed ID.

Then, in parallel, preview the cancellation (read-only, cancels nothing) and read the stay:

CLI:
```bash
ramp travel cancel-hotel "<hotel_room_booking_id>" --output json \
  --rationale "preview cancellation terms to rebook the Chicago hotel, Oct 5-7"
ramp travel booking-details "<hotel_room_booking_id>" --output json \
  --rationale "read the Chicago hotel stay, Oct 5-7, to rebook it"
```

MCP:
```json
{
  "hotel_room_booking_id": "{hotel_room_booking_id}",
  "confirm": false,
  "rationale": "preview cancellation terms to rebook the Chicago hotel, Oct 5-7"
}
```

Call `SubmitHotelCancellation` with the above, and `GetBookingDetails` with the same
`hotel_room_booking_id` and a rationale. Do not present the preview yet.

### Eligibility checks

Whose stay it is:

- The cancellation preview's `traveler_is_acting_user` decides: the stay is the user's own only
  when it is true. IDs differ between tools, so never compare the preview's `traveler_id` with a
  user ID from another result. Use `traveler_name` only to name the traveler; a matching name is
  never evidence that the stay is the user's own.
- The tools enforce who can cancel and book for whom: appearing in the bookings list is not
  enough.
- Pass the preview's `traveler_id` as `traveler_user_id` to every later search, rates, and
  booking call, **including for the traveler's own stay** (unlike a fresh `ramp-book-hotel`
  booking, where it is added only for someone else).
- When `traveler_is_acting_user` is false, name the traveler in every confirmation question
  ("book this hotel for Harper and cancel Harper's current booking?") so the user knows whose
  stay changes.
- When `hotel.number_of_rooms` in the booking details is above 1, the stay can't be rebooked
  here: a replacement books one room.

A cancellation preview **qualifies** only when `is_currently_cancellable` is true and
`refund_amount` is present. Work out the **cancellation cost** in the preview's currency:

- Prepaid stay (`is_pre_paid` true): `booking_amount` minus `refund_amount`, even when a smaller
  `cancellation_fee` is shown.
- Stay paid at the property (`is_pre_paid` false): `cancellation_fee` when present, otherwise
  `booking_amount` minus `refund_amount`.

Each qualifying preview has exactly one **outcome**:

| Outcome | When | What the traveler is told |
|---|---|---|
| Full refund | cost is zero | the full `refund_amount` goes back to the original form of payment; paid at the property: it cancels with no cancellation fee |
| Partial refund | cost above zero and `refund_amount` above zero | they get `refund_amount` back and lose the cost; paid at the property: cancelling incurs the cost as a cancellation fee (mention no refund) |
| No refund | `refund_amount` is zero | they lose the full `booking_amount`; paid at the property: the cost as a cancellation fee |

For a stay paid at the property, never say the traveler gets money back or is refunded, wherever
you describe the outcome, even when the preview shows a refund amount: describe only the
cancellation fee or its absence. Its `rendered_response` shows "Stay total (paid at the hotel)"
and "Cancellation fee" (an amount, or "none") instead of a refund line.

`is_pre_paid` says how the rate is paid, not whether a deposit or advance night was charged:
never say nothing was charged, or promise more back than the preview shows. State amounts exactly
as the preview shows them, with their currency; never round, estimate, or imply that a fee is
waived or credited toward the new hotel. Apply these checks to **every** cancellation preview,
including the refreshed one in Step 5 and any `latest_preview` returned on confirmation — terms
can change while the traveler chooses, for example when a free-cancellation deadline passes.

**Ineligible before anything was booked:** when a preview does not qualify, the traveler can't be
booked for, or the stay has more than one room, cancel nothing and book nothing. Say the hotel
can't be cancelled and rebooked here, give the reason from the evidence's fields (not cancellable
or its `blocked_reason`, refund terms unavailable, a traveler the user can't book for, or more
than one room), and send the fallback in the same message (see "Fallback").

## Step 3 — explain, and gather only what's missing

In one message, briefly explain the process: you'll find the new hotel first, it is a separate
booking, and nothing changes until the traveler confirms both booking it and cancelling the
current one.

- This message explains and gathers; it **never asks for consent**. Don't ask whether to cancel,
  whether the cost is acceptable, or whether to search: the only consent question is Step 6.
- Name the cost only for a **partial refund** or **no refund**, in one sentence with its exact
  amounts, never rounded, so the traveler knows before choosing new dates or hotels. Otherwise
  don't mention the refund or cancellation terms; Step 6 presents them.
- Ask what should change (dates, hotel, area, or room) only if the traveler hasn't said it.
- Put any open hotel or room preference questions from `ramp-book-hotel` in this same message,
  so there is at most one round of questions before the search. Ask none when the traveler
  already gave them or said any hotel is fine.

Keep everything else from the original stay: the preview's `check_in_date` and `check_out_date`
exactly as shown, the original hotel's address and city as the place to stay near, and the booking
details' `hotel.number_of_adults`. When `number_of_adults` is missing, ask how many adults are
staying in the same message.

When something is asked, end the turn and wait; the traveler's answer confirms the dates, place,
and adults for the new search. When nothing is left to ask (for example "move it to Oct 12-14,
same hotel"), don't wait for a reply: run Step 4 in the same turn, and lead that reply with the
explanation, what you're searching for, and any cost sentence — whether it shows hotel options or
says the search is still running.

## Step 4 — find the new hotel and room

Search, present, and fetch rates exactly as `ramp-book-hotel` describes ("Office and headquarters
destinations", "Search hotels", "Present the hotel comparison", and "Fetch and present
selected-hotel rates"), with these differences:

- Skip its "Resolve the traveler" section: the traveler comes from the cancellation preview, and
  the stay being replaced means a traveler profile exists. If the booking preview later reports
  a missing profile detail, follow `ramp-book-hotel` to update the profile before Step 6.
- Resolve dates without a year to their next upcoming occurrence, and say back the full dates
  you'll search for.

- Pass the preview's `traveler_id` as `traveler_user_id` on the search and on `hotel-rates` /
  `GetHotelRates`, and the adults as `num_adults` when not one.
- When only the dates change, also search for the original hotel by name (`hotel_name`) and offer
  it first if it is available: a nearby-area search may not rank it in the first page.
- Explicit choices for this change override saved preferences. Preference questions belong in
  Step 3, not here. Don't offer to save preferences during a rebooking.
- If the search refuses because the user can't book for that traveler, present no results and
  follow the ineligible path in Step 2.
- If no hotel `is_available`, nothing has changed: say no rooms are available for the new stay
  right now, and offer other dates or another area.
- If the search rejects the request (for example "check_in_date must be today or later"),
  nothing has changed: say what needs to change and ask for new dates or details. Don't send
  the fallback link for this.
- If the search fails with a retryable or provider-unavailable error, nothing has changed: offer
  to try again or adjust the search. Don't send or mention the fallback web link for this, not
  even as a manual alternative: the search can simply be retried here.

CLI:
```bash
ramp travel search-hotel --output json --wait_for_results \
  --location_query "233 N Michigan Ave, Chicago" \
  --check_in_date 2026-10-12 --check_out_date 2026-10-14 \
  --json '{"traveler_user_id": "<traveler_id>"}' \
  --rationale "search hotels to rebook the Chicago hotel, Oct 5-7, to Oct 12-14"
ramp travel hotel-rates --output json \
  --check_in_date 2026-10-12 --check_out_date 2026-10-14 \
  --json '{"hotel_id": "<selected_hotel_id>", "traveler_user_id": "<traveler_id>"}' \
  --rationale "fetch rooms and rates to rebook the Chicago hotel, Oct 5-7, to Oct 12-14"
```

MCP: call `SearchHotels` and `GetHotelRates` with the same fields plus `traveler_user_id`.

Search results can show a different payment type, refundability, or price than the rates for the
same hotel; only `hotel-rates` and the booking preview are authoritative. Wait for the traveler to
pick a hotel, then a room and rate, each in a new message.

## Step 5 — preview the new booking and refresh the cancellation terms

Once the traveler selects a rate, run **in parallel**:

- the `ramp travel book-hotel` / `SubmitHotelBooking` preview (no `--confirm`) for the selected
  hotel ID, rate ID, and stay dates, with `traveler_user_id` set to the cancellation preview's
  `traveler_id`, presented as `ramp-book-hotel` "Preview the selected rate" describes;

  ```bash
  ramp travel book-hotel --output json \
    --check_in_date 2026-10-12 --check_out_date 2026-10-14 \
    --json '{"hotel_id": "<selected_hotel_id>", "rate_id": "<selected_rate_id>",
      "traveler_user_id": "<traveler_id>"}' \
    --rationale "preview the new hotel to rebook the Chicago hotel, Oct 5-7, to Oct 12-14"
  ```

  Leave `trip_id` out of the preview: Ramp resolves it only on confirm (Step 7).

- a fresh `ramp travel cancel-hotel` / `SubmitHotelCancellation` preview (`confirm: false`) for
  the current booking. Apply the eligibility checks to it; it supersedes the earlier preview.

Complete anything the booking preview requires before asking for confirmation. Collect required
traveler inputs from the traveler, **each in its own turn before Step 6** — never invent them:

- Out of policy: show every violation and ask why the traveler needs that rate; keep the exact
  answer as `oop_reason`.
- No booking fund (`fund_eligibility_status` `none_eligible`): the booking requests a new fund.
  Ask for the trip purpose and pass the answer as `reason` with `request_new_fund`. Never confirm
  a new fund request without a trip purpose the traveler gave.
- `fund_eligibility_status` `lookup_failed` means Ramp couldn't check the traveler's funds: never
  confirm it. Preview once more; if it fails again, stop with nothing changed. Tell the traveler
  you couldn't check how the new stay would be paid for, so nothing was booked or cancelled and
  the current stay is unchanged, and send the fallback in the same message.
- A fund choice or change means a fresh booking preview, per `ramp-book-hotel`.

## Step 6 — one confirmation for both changes

Ask to confirm both changes in **one** message, with these four parts in this order:

1. **The new hotel, as a separate booking.** Present the booking preview as `ramp-book-hotel`
   directs, with every fact it presents: hotel name and address, traveler, stay dates, room,
   exact total, payment timing, the new rate's cancellation terms, fund, loyalty when present,
   policy status, and approval status. Name it in one line of text (hotel, stay dates, room, and
   total).
2. **The current stay's cancellation terms.** For a stay paid at the property, the preview's
   statement line may still read "Fully refundable until …": keep that line exactly as shown,
   since it is Ramp's policy text, but never use the word refund in your own words (part 3 and
   everywhere else). Show the latest cancellation preview's
   `rendered_response` as Markdown, keeping the hotel, traveler, and stay dates and every term
   exactly as shown: the statement with its deadline and timezone, the amount paid or stay total,
   any cancellation fee, the refund, any no-refund note, and the policy disclaimer. Show the
   hotel name as plain text instead of its `ror://` link; never round, recompute, reword, or drop
   anything else.
3. **The outcome in plain words**, per the outcome table, including its pay-at-property wording:
   - Full refund: the full `refund_amount` goes back to the original form of payment (paid at
     the property: it cancels with no cancellation fee).
   - Partial refund or no refund: exactly what the traveler loses and gets back (paid at the
     property: the cancellation fee), that this cost applies even if the new hotel isn't
     approved, and that the new hotel is charged in full on top of it.
4. **The order of changes:** on confirmation you'll book the new hotel first and then cancel the
   current booking, which is final. When the booking preview's `approval_display_status` is
   `Approval required before booking`, say the current booking will still be cancelled right
   after this confirmation even though the new hotel waits for approval, so a rejection leaves
   the traveler without a hotel and any cancellation cost still applies.

Then ask **exactly one** question that names the new hotel, its total, the current hotel, and,
for a partial or no refund, the cost:

- Full refund: "Book the Hyatt Regency for USD 512.36 and cancel your current booking at the
  Hilton Chicago?"
- Partial refund: "…and cancel your current booking at the Hilton Chicago, losing USD 300.00 of
  the USD 600.00 you paid?"
- No refund: "…losing the full USD 600.00?" Paid at the property: "…with a USD 150.00
  cancellation fee?"

Ask nothing else in this message (no loyalty or preference saves), and never reuse a question or
call to action from either preview. End the turn and wait for a new, explicit reply that agrees
to this latest question, such as "yes", "ok", or "confirm". The original request, a selection, a
reason, a question, a conditional answer, an instruction not to ask questions, or agreement to an
earlier preview with a different cost is **not** confirmation. If the reply is unclear or
questions the cost, answer and ask again. A different selection or changed preview needs fresh
previews and a new confirmation. If the traveler declines, change nothing and offer to search
again.

## Step 7 — book the new hotel (first)

After that confirmation, call `ramp travel book-hotel` / `SubmitHotelBooking` **once** with
`--confirm` / `confirm: true`, as `ramp-book-hotel` "Confirm only after explicit approval"
describes: the same hotel, rate, dates, and traveler, the preview's numeric
`expected_total_amount` verbatim, exactly one funding path from the latest preview, and any
`oop_reason`. Pass the original booking's `hotel.trip_id` from the booking details as
`trip_id` when known, unless the traveler asked to move the new hotel to a
different trip.

CLI:
```bash
ramp travel book-hotel --confirm \
  --check_in_date 2026-10-12 --check_out_date 2026-10-14 \
  --expected_total_amount <preview_expected_total_amount> --output json \
  --json '{"hotel_id": "<selected_hotel_id>", "rate_id": "<selected_rate_id>",
    "traveler_user_id": "<traveler_id>", "trip_id": "<trip_id>",
    "spend_allocation_id": "<fund_uuid_from_latest_preview>"}' \
  --rationale "rebook the Chicago hotel, Oct 5-7, to Oct 12-14; traveler approved booking it and cancelling the current stay"
```

MCP:
```json
{
  "hotel_id": "{selected_hotel_id}",
  "rate_id": "{selected_rate_id}",
  "check_in_date": "2026-10-12",
  "check_out_date": "2026-10-14",
  "traveler_user_id": "{traveler_id}",
  "trip_id": "{trip_id}",
  "spend_allocation_id": "{fund_uuid_from_latest_preview}",
  "confirm": true,
  "expected_total_amount": "{preview_expected_total_amount}",
  "rationale": "rebook the Chicago hotel, Oct 5-7, to Oct 12-14; traveler approved booking it and cancelling the current stay"
}
```

Call `SubmitHotelBooking` with the above.

Act on the **first** case that matches:

| Booking result | Meaning | Do |
|---|---|---|
| The total changed | nothing was booked or cancelled | present the new total and ask the Step 6 question again |
| A booking request has already been submitted for this rate | an existing request, not this submission | never submit again and cancel nothing; follow "Already submitted" below |
| Any other error, including a missing input such as the trip purpose | nothing was booked | cancel nothing; say the current booking is unchanged, relay the `message`, offer to search again. If it names a missing input, collect it and ask the Step 6 question again before another confirm |
| Unknown outcome (timeout, or an error without a typed message) | a booking request may exist | check `ramp travel bookings` / `GetBookings` for the new stay. Continue to Step 8 only if it shows the new booking; otherwise cancel nothing, say what is known, and share the `support` from Step 2 |
| `booking.status` is `rejected` | the new hotel was not booked | cancel nothing; say the current booking is unchanged, relay the result's message, offer to search again |
| Otherwise | the booking was accepted | continue to Step 8 **in the same turn**. When `booking.status` is `approved`, the new hotel is still being booked; say so without calling it confirmed |

Never retry the booking confirmation automatically.

### Already submitted

This error never means this confirm went through: a repeat of the same confirm returns its
booking instead. The existing request may be for another traveler, by another booker, or older,
so nothing shows it replaces this stay for this traveler. Never submit the booking again, never
search again, and **cancel nothing**. Only report what exists:

1. **Find the request.** If the error names the existing booking ID (the MCP error's guidance
   does), use it. The CLI prints only the error's message, so on the CLI look it up instead:

   ```bash
   ramp travel bookings --include_hotels --include_failed --output json \
     --hotel_name "<new hotel name>" --travel_date <new check-in date> \
     --json '{"traveler_user_id": "<traveler_id>"}' \
     --rationale "find the existing hotel request for the Chicago rebooking, Oct 12-14"
   ```

   Keep only entries with the new hotel's name and exactly the new stay's check-in and
   check-out dates, excluding the current booking. Exactly one match identifies it: use its `hotel_room_booking_id` when present (already
   fulfilled), otherwise its `booking_request_id`.
   No match, or more than one, means its status is unreadable.
2. **Read its status** with `ramp travel booking-details` / `GetBookingDetails`, passing that ID
   under the same field name.
3. **Report and stop.** Whatever the status, say the current booking is unchanged, report that
   request's status as shown (or that you couldn't read it), and share the `support` from Step 2.
   Never continue to Step 8 from this path.

## Step 8 — cancel the current booking (second)

Cancel only after the booking confirm returned a booking result rather than an error. Call
`ramp travel cancel-hotel` / `SubmitHotelCancellation` **once** with `--confirm` / `confirm: true`
and the `preview_id` from the latest cancellation preview, unchanged. Pass
**exactly the same `hotel_room_booking_id` you passed to the cancellation preview** (from
`travel bookings`). Never use an ID that appears inside the preview or any other response, such
as a parent booking ID or `booking_request_id`, even when it looks like the booking's ID:

CLI:
```bash
ramp travel cancel-hotel "<hotel_room_booking_id>" --confirm \
  --preview_id "<latest_preview_id>" --output json \
  --rationale "cancel the Chicago hotel, Oct 5-7, after booking its replacement; traveler approved the previewed terms"
```

MCP:
```json
{
  "hotel_room_booking_id": "{hotel_room_booking_id}",
  "confirm": true,
  "preview_id": "{latest_preview_id}",
  "rationale": "cancel the Chicago hotel, Oct 5-7, after booking its replacement; traveler approved the previewed terms"
}
```

Call `SubmitHotelCancellation` with the above.

The new hotel is already booked, so every outcome that leaves the current booking active means
the traveler has **both bookings** until it is cancelled — say so. Act on the first case that
matches:

- **Terms changed, or no longer cancellable** (an error with `latest_preview`, or a message
  such as "Cancellation terms changed since the preview" or "Self-service cancellation is not
  currently available"): nothing was cancelled. The CLI prints only the error's message, so
  when `latest_preview` isn't shown, run the cancellation preview again (`confirm: false`, no
  `--confirm`) and use it as `latest_preview`. If `latest_preview` qualifies, show its `rendered_response` the same way, state its
  outcome, say what changed and that the new hotel is booked, and ask the Step 6 cancellation
  question for the current booking alone. On a new, explicit yes, confirm once with its
  `preview_id` and handle the result with these same cases. If it doesn't qualify, say the new
  hotel is booked, the current booking can't be cancelled here and why, and send the fallback in
  the same message.
- **Any other error** (including `not_found`, a failed cancellation, or a permission error):
  the current booking was not cancelled. Relay the `message` and the `support` from Step 2, and
  send the fallback. **Never retry with a different ID.**
- **`result.already_requested` is true**: a cancellation was already requested elsewhere. Say so,
  check `ramp travel bookings` / `GetBookings`, and report what it shows.
- **`result.cancellation_state` is `PENDING`, `PROCESSING`, or `SUCCESS`**: the cancellation is in
  progress (complete for `SUCCESS`). Say what it means for the traveler's money per the outcome:
  the refund of `refund_amount` that is processing, the cancellation fee, or that no refund is
  coming. Never promise a refund timeline the response didn't state.
- **`result.cancellation_state` is `ACTION_REQUIRED`**: not complete; Ramp's travel team must
  finish it. Relay `result.message` and the `support` from Step 2.
- **Missing `cancellation_state`, a timeout, or anything unexpected**: the cancellation may still
  go through, so do not say it wasn't cancelled. Check `ramp travel bookings` / `GetBookings`,
  report what it shows, and share the `support` from Step 2. **Never retry the cancellation.**

## Report the result

Report the new hotel first: its returned `booking.status`, its address, total,
`booking.next_steps`, and the confirmation email when present. Then report the current booking's
cancellation in its result's own words. To verify the new stay, follow `ramp-book-hotel` "Verify
the booking request".

- Never call the original booking cancelled unless `cancellation_state` is `SUCCESS`; for
  `PENDING` or `PROCESSING`, say it is being cancelled (the traveler gets an email when it
  completes).
- Never call the new hotel confirmed or approved unless its result says so, and never say the
  change is complete while either side is pending.
- For a stay paid at the property, never describe the cancellation as a refund.
- Never retry a confirmation automatically. After a failure, keep recovery in this conversation:
  offer to search again unless this skill directs the fallback.

## Fallback

When this flow can't finish here, share the Step 2 `self_serve_action.deep_link_url` once, with
its `cta_label` as the link text, so the traveler can cancel and rebook in the Ramp web app.

- Give the reason first, from the cancellation preview's fields (`is_currently_cancellable`,
  `blocked_reason`, `refund_amount`, `cancellation_fee`) or the booking details'
  `number_of_rooms` — never from the self-serve action alone. Preview the cancellation first if
  this conversation has none. When the tool returned an error instead of a preview, the error's
  message is the reason.
- Send the link in the same message as the reason. Don't ask whether the traveler wants it.
- Share no other link for this. Mention the booking's `support` only when the evidence calls for
  it (a failed or stuck cancellation) or the traveler asks to talk to someone.

## Gotchas

- Order matters: book first, cancel second. Never cancel before the new booking is accepted, and
  never cancel with a `preview_id` the traveler didn't approve.
- Search and rates amounts, payment types, and refundability are for choosing; only the booking
  preview and the cancellation preview are authoritative.
