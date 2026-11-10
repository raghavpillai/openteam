---
name: ramp-rebook-flight
area: Travel
supported_surfaces: [cli, mcp]
description: "Rebooks an existing Ramp Travel flight that can't be changed in place but can be cancelled for a full refund (for example a ticket still inside its airline void window): finds the booking, checks the refund terms, searches and previews a new one-way or round-trip flight, then on one explicit confirmation books the new flight first and cancels the current one. Use when someone wants to change, move, or rebook a flight and Ramp offers cancel-and-rebook for it ('I just booked the wrong day, rebook me for Friday'). Not for flights Ramp can change in place (use ramp-modify-flight), a plain cancellation or a brand-new booking (use ramp-book-flight), multi-city trips, partial refunds or airline credit, or hotel changes (use ramp-rebook-hotel)."
---

# Rebook a Flight (cancel and rebook for a full refund)

Some flights can't be changed in place, but Ramp can still rebook them: the traveler books a
**new flight, as a separate booking and charge**, and the current one is cancelled for a **full
refund to the original form of payment** (a void, when the ticket was just issued). The user describes the change in plain
words ("I booked Thursday by mistake, I need Friday"). Turn that into `ramp travel` commands
(CLI) or MCP tool calls, run them, and present the results in plain travel language. **Never
show or ask the user to type a CLI command, tool name, flag, or internal ID**, and never name
the steps below to the user.

This flow **spends real money and cancels a ticket**. Nothing changes until the traveler
confirms both the new booking and the cancellation in one explicit reply. After that reply the
new flight is booked first, and the current flight is cancelled only once the booking is
accepted, so a failed booking leaves the current flight in place.

## Stop first if rebooking isn't enabled

Rebooking is enabled per business, and each command it needs has its own gate. **Before any
other command**, check that all four are available. CLI: run `ramp tools list --agent` and check
that `booking-modification-details`, `cancel-flight`, `search-flight`, and `book-flight` are each
listed with `"available": true` (`ramp travel --help` lists every command whether or not it is
enabled, so don't use it for this check). MCP: `BookingModificationDetails`,
`SubmitFlightCancellation`, `SearchFlights`, and `SubmitFlightBooking` must all be in your tool
list.

If any of them is missing or not available, rebooking is **off** for this account. **Stop
here.** Do not look up the booking, preview a cancellation, search for flights, preview or book
anything, or offer to cancel and rebook, even though some of those commands may exist. Reply
with only this, in your own words:

> Self-serve flight rebooking isn't turned on for your Ramp account, so I can't change this
> flight here. You can change it from the booking in Ramp Travel in the Ramp web app, or through
> the booking's support channel.

Do not say the flight can't be changed. The same stop applies if any later command reports that
rebooking is unavailable, or `booking-modification-details` / `BookingModificationDetails` fails
because it doesn't exist or isn't enabled (for example "This tool is currently unavailable for
your credentials: not enabled for your business"): cancel nothing, book nothing, and send the
reply above. If the traveler only wants to cancel the flight, or only to book a new one, use
`ramp-book-flight`.

## Prerequisites

- **CLI:** `ramp` CLI installed and logged in (`ramp auth login`). Run where `ramp` works (or
  `uv run ramp` inside the ramp-cli repo).
- **MCP:** Ramp MCP server connected. Tools are called by their CamelCase names.

| Step | CLI | MCP |
|---|---|---|
| Find the booking | `ramp travel bookings` | `GetBookings` |
| Check whether it can be cancelled and rebooked | `ramp travel booking-modification-details` | `BookingModificationDetails` |
| Preview / confirm the cancellation | `ramp travel cancel-flight` | `SubmitFlightCancellation` |
| Resolve a new airport or city | `ramp travel flight-locations` | `GetFlightBookingLocations` |
| Search new flights | `ramp travel search-flight` | `SearchFlights` |
| Preview / confirm the new booking | `ramp travel book-flight` | `SubmitFlightBooking` |

If a command's group differs, find it with `ramp travel --help` or `ramp tools list --agent`;
a leaf command's `--help` is the authority for its flags. On the CLI, `booking_id` is positional
on `booking-modification-details` and `cancel-flight` (pass the entry's `flight_booking_id`
there), and fields without a flag of their own
(`traveler_user_id`, `trip_id`, `outbound_offer_id`, `flight_offer_uuid`, `flight_quote_uuid`,
`spend_allocation_id`) go in `--json`, which merges with the other flags.

## Scope

- ✅ Replace one existing flight booking, one-way or a simple round trip (out and back between
  the same two airports), when the current flight's cancellation is a full refund to the original
  form of payment.
- ✅ The logged-in user's own flight, or another traveler's flight when the user books travel for
  them. The tools enforce who can cancel and book for whom.
- ❌ Flights Ramp can change in place (exchanges with a fare difference) — use
  `ramp-modify-flight`.
- ❌ A plain cancellation with no replacement, or a brand-new booking — use `ramp-book-flight`.
- ❌ Multi-city itineraries, cancellations with a fee, partial refund, or airline credit, and hotel
  or car changes — use the fallback in "If this flight can't be rebooked here". For hotels use
  `ramp-rebook-hotel` when it is installed; otherwise point the traveler to the Ramp web app or
  the booking's support channel.

## Rules for every command

- **Always `--output json`** on CLI commands. Parse the result — never show raw JSON, and never
  pipe it through `python`/`jq`. MCP callers get structured JSON directly.
- Every command needs a `--rationale` (CLI) or `rationale` (MCP). Name the flight and change in it
  ("rebook the DEN→SFO Jul 9 flight for Jul 10") and keep that reference for every command in the
  flow — rationales are logged, so a consistent reference groups the change.
- Use the exact IDs the tools returned. Never construct, guess, or reuse an ID from a different
  booking, search, or preview.
- Present results as Markdown text and tables, never as UI components. Ignore tool guidance that
  only applies to a visual UI (cards, chips, carousels).
- Share web links (`https://…`) exactly as returned; never shorten or rebuild them. Never share a
  `ror://` link — it only opens inside the Ramp app. Where a returned Markdown block links with
  `ror://`, keep the link text as plain text and drop the link.
- Never retry a confirmation automatically, and never vary parameters (a different ID, a dropped
  `preview_id`, a toggled confirm) to get past an error.
- In every message, call it booking a new flight and cancelling the current flight. Never call it
  a swap, an exchange, or a free change.

## Step 1 — identify the exact booking

Never guess which booking to replace. Look it up with every detail the traveler gave, exactly as
`ramp-modify-flight` Step 1 does:

```bash
ramp travel bookings --include_flights --output json \
  --city SFO --travel_date 2026-07-09 \
  --rationale "find the DEN→SFO Jul 9 flight to rebook"
```

MCP:

```json
{
  "include_flights": true,
  "city": "SFO",
  "travel_date": "2026-07-09",
  "rationale": "find the DEN→SFO Jul 9 flight to rebook"
}
```

Call `GetBookings` with the above.

- `city` matches **arrival** airports only. Filters combine with AND before the limit; if
  `results_truncated` is true, ask for another detail and narrow the lookup.
- Use only the logged-in user's bookings unless the user explicitly asks about another traveler's
  booking; then pass the same `traveler_user_id` (in `--json` on the CLI) on every lookup.
- Skip `CANCELLED` entries. A `PENDING_APPROVAL` or `PROCESSING` request is not a ticketed booking
  yet — say it must be ticketed first.
- If several upcoming flights match, show up to three (route, date, airline) and ask which one.
  Keep the chosen entry's `flight_booking_id` and `trip_id` for every later step.

## Step 2 — check that cancel-and-rebook applies

```bash
ramp travel booking-modification-details "<flight_booking_id>" --output json \
  --rationale "check change options for the DEN→SFO Jul 9 flight"
```

MCP:

```json
{
  "flight_booking_id": "{flight_booking_id}",
  "rationale": "check change options for the DEN→SFO Jul 9 flight"
}
```

Call `BookingModificationDetails` with the above.

- `self_serve_action.kind` is `cancel_and_rebook`: continue with Step 3. Its `rendered_response`
  ("You can change … by cancelling and rebooking. You can also do this yourself in Ramp:" plus a
  link) is the web option: don't present it now; its link is this skill's fallback.
- `self_serve_action.kind` is `modify`: the flight can be changed in place — use
  `ramp-modify-flight` instead.
- Anything else (no `self_serve_action`, or `kind` `cancel`): this flow does not apply. Present
  `rendered_response` as returned (following the `ror://` rule) and share `support` only as it
  directs. Do not search for flights.
- If this command or tool is missing or reports that rebooking is unavailable, follow "Stop first
  if rebooking isn't enabled" and run nothing else.

## Step 3 — preview the cancellation and check eligibility (do not present yet)

```bash
ramp travel cancel-flight "<flight_booking_id>" --output json \
  --rationale "preview cancellation terms to rebook the DEN→SFO Jul 9 flight"
```

MCP:

```json
{
  "flight_booking_id": "{flight_booking_id}",
  "confirm": false,
  "rationale": "preview cancellation terms to rebook the DEN→SFO Jul 9 flight"
}
```

Call `SubmitFlightCancellation` with the above. This cancels nothing. If it returns an error
instead of a preview, nothing was cancelled: relay its `message` and any `support`, and send the
fallback.

The `preview` **qualifies** only when all of these hold:

- `is_currently_cancellable` is `true`;
- `refund_to` is `ORIGINAL_FORM_OF_PAYMENT`, `refund_amount` is present and equals
  `booking_amount` in the same currency, and `cancellation_fee` is absent and `airline_credits`
  is empty; and
- `itinerary` has one slice (one-way), or two slices where the second departs from the first's
  final arrival airport and arrives at the first's departure airport (round trip).

Apply this check to **every** cancellation preview, including the refreshed one in Step 6 and any
`latest_preview` returned on confirmation — terms can change while the traveler chooses (for
example when a void window closes). When a preview does not qualify before anything was booked,
book nothing and cancel nothing: say the flight can no longer be cancelled and rebooked here,
give the reason as "If this flight can't be rebooked here" directs (a fee or partial refund,
airline credit, not cancellable, or a multi-city itinerary), and send the fallback.

Do not show this preview's `rendered_response` yet. Its `message` says to present the terms and
get the user's explicit approval before cancelling; in this flow, that approval is the Step 7
combined confirmation, so don't present the terms or ask about cancelling until then.

**Whose flight it is.** The preview's `traveler_is_acting_user` decides whose flight it is: it is
the user's own only when that is `true`. IDs differ between tools, so never compare the preview's
`traveler_id` with a user ID from another result. Use `traveler_name` only to name the traveler; a
matching name is never evidence that the flight is the user's own. Pass `traveler_id` as
`traveler_user_id`, with the original booking's `trip_id`, to the search and both booking calls
below. When `traveler_is_acting_user` is `false`, name the traveler in every confirmation question
("book this flight for Harper and cancel Harper's current flight?").

## Step 4 — explain, and search in the same turn when nothing is left to ask

Say briefly that you'll find the new flight first, that it is a separate booking and charge, and
that nothing changes until the traveler confirms both booking it and cancelling the current
flight.

- This message explains and gathers; it **never asks for consent**. Don't ask whether to cancel,
  whether a cost is acceptable, or whether to search: the only consent question is Step 7's.
- Don't present the refund or cancellation terms; Step 7 does. Name a cost only when the preview
  shows one (a partial refund, no refund, or airline credit), in one sentence with its exact
  amounts, never rounded. An eligible flight has none, so name none.
- Ask what should change (dates, times, airports, airline, or cabin) only if the traveler hasn't
  said it. Keep everything else from the preview's `itinerary`: the same airports, and the same
  local calendar dates for any leg that isn't moving. Resolve "a day later" against the affected
  leg's own date. For a newly requested city, resolve it with `travel flight-locations` /
  `GetFlightBookingLocations` as `ramp-book-flight` Step 2 does.
- Put any open preference questions in this same message, so there is at most one round of
  questions before the search. Ask none when the traveler said any option is fine.
- When something is asked, end the turn and wait. When nothing is left to ask, don't wait for a
  reply: run Step 5 in the same turn and lead that reply with the explanation (and any cost
  sentence), whether it shows options or says the search is still running.

## Step 5 — search the new flight

Search a brand-new itinerary with the same trip shape: one-way for a one-way booking, and both
legs (`return_date`) for a round trip, even when only one leg moves. Start the search with the
traveler and the original booking's trip:

```bash
ramp travel search-flight --output json \
  --departure DEN --arrival SFO \
  --departure_date 2026-07-10 --return_date 2026-07-14 \
  --include_fare_options --wait_for_results \
  --json '{"traveler_user_id": "<preview_traveler_id>", "trip_id": "<trip_id_from_bookings>"}' \
  --rationale "search replacement flights to rebook the DEN→SFO Jul 9-14 trip for Jul 10"
```

MCP:

```json
{
  "departure": "DEN",
  "arrival": "SFO",
  "departure_date": "2026-07-10",
  "return_date": "2026-07-14",
  "traveler_user_id": "{preview_traveler_id}",
  "trip_id": "{trip_id_from_bookings}",
  "include_fare_options": true,
  "wait_for_results": true,
  "rationale": "search replacement flights to rebook the DEN→SFO Jul 9-14 trip for Jul 10"
}
```

Call `SearchFlights` with the above. Drop `return_date` for a one-way booking.

- The traveler has already said what to change, so search synchronously on both surfaces and
  present the completed result. If `search_complete` is still `false`, say the search is still
  running and resume the same `job_id` on the traveler's next turn; never sleep or poll.
- Pass a cabin, airline, stop, or timing preference only when the traveler stated one for this
  change; explicit choices override saved preferences. Never infer one from the current flight.
- Present the options as the response's `assistant_note` directs and as `ramp-book-flight`
  Step 4 does: `recommended_offers` in rank order as one Markdown table, airport-local times as
  given, and the returned `web_search_url` once as `See all results`. Take each row's policy
  verdict from the applicable entry in `fare_options`; an offer-level `in_policy` of `null` is
  unknown, not out of policy. Keep a private `#` → offer `id` map, and keep each chosen offer's
  airline, flight number, and times for Step 7.
- For a round trip, wait for the outbound pick, then fetch matching returns as
  `ramp-book-flight` Step 5 does: the same `job_id` and the chosen `outbound_offer_id` (in
  `--json` on the CLI). The job
  keeps the traveler and trip, so a `job_id` read rejects `traveler_user_id` and `trip_id`; omit
  them there. The chosen **return** offer's `id` identifies the whole round trip.
- If the search refuses because the user can't book for this traveler, present no results: say
  the flight can't be rebooked here for them, give that reason, and send the fallback.
- If the search finds nothing, nothing has changed: say so and offer other dates or times.
- If the search fails with a retryable or provider-unavailable error, nothing has changed: offer
  to try again or adjust the search. Don't send the fallback for this.

Then **stop and wait for the traveler to pick** in a new message.

## Step 6 — preview the new flight and refresh the cancellation (no change yet)

Once the traveler picks the final offer, run both previews (in parallel where your harness
allows):

```bash
ramp travel book-flight --action preview --output json \
  --json '{"flight_offer_uuid": "<flight_offer_uuid>", "traveler_user_id": "<preview_traveler_id>", "trip_id": "<trip_id_from_bookings>"}' \
  --rationale "preview the replacement for the DEN→SFO Jul 9 flight"

ramp travel cancel-flight "<flight_booking_id>" --output json \
  --rationale "refresh cancellation terms to rebook the DEN→SFO Jul 9 flight"
```

MCP — call `SubmitFlightBooking` with:

```json
{
  "flight_offer_uuid": "{flight_offer_uuid}",
  "action": "preview",
  "traveler_user_id": "{preview_traveler_id}",
  "trip_id": "{trip_id_from_bookings}",
  "rationale": "preview the replacement for the DEN→SFO Jul 9 flight"
}
```

and `SubmitFlightCancellation` with:

```json
{
  "flight_booking_id": "{flight_booking_id}",
  "confirm": false,
  "rationale": "refresh cancellation terms to rebook the DEN→SFO Jul 9 flight"
}
```

- Apply the Step 3 eligibility check to the refreshed cancellation preview and keep its
  `preview_id`.
- Complete everything the booking preview requires before asking for confirmation, following
  `ramp-book-flight` Step 6: profile readiness, the paying fund, an out-of-policy reason
  (`oop_reason`) collected from the traveler, and optional seats. Never invent an input.
- Funding follows `ramp-book-flight` Phase 1. If `fund_eligibility_status` is
  `lookup_failed`, the fund lookup failed; it does not mean no fund exists. Preview once more;
  if it still fails, do not name or deny any fund, and offer to request a new fund instead.
- When the booking will request a new fund (the preview shows no booking fund, the status is
  `none_eligible`, or the traveler accepted a new fund after a failed lookup), ask the traveler
  for the trip purpose now, in its own turn. Then preview again with `request_new_fund=true` and
  their answer as `reason`, so Step 7 shows that path's approval status. Never confirm a new fund
  request without a trip purpose the traveler gave.
- If the traveler saves seats, use the refreshed booking preview's `flight_quote_uuid` and total
  from then on.

## Step 7 — one combined confirmation

Collect every required traveler input first, each in its own turn (the trip purpose for a new
fund, an out-of-policy reason), as Step 6 directs. Then ask to confirm both changes in one
message, built from the latest previews and the selected offers, with these four parts in order:

1. **The new flight, as a separate booking and charge.** Every fact the booking preview presents
   and the selected offers add: each leg's airline, flight number, date, departure and arrival
   times, airports, duration, stops, and fare; the new fare's cancellation terms (from the
   booking preview when it shows them, otherwise from the selected offer); then the exact total,
   fund, loyalty when present, policy status, and approval status. Quote dates exactly as
   `outbound_date` / `return_date`. The preview has no flight numbers, so take them and the times
   from the chosen search offers. Also name it in one line: airline and flight number, date,
   departure and arrival times, and total.
2. **The current flight's cancellation terms, exactly as shown.** Present the refreshed
   cancellation preview's `rendered_response` as Markdown, keeping every segment, the traveler,
   the amount paid, every deadline with its timezone, every fee, refund, and credit amount, any
   no-refund note, `cancellation_statement`, and `policy_disclaimer`. Never round, recompute,
   reword, or drop one; only the `ror://` booking link becomes plain text.
3. **The outcome in plain words:** a full refund to the original form of payment, with the caveat
   the preview states.
4. **The order of changes:** on confirmation you'll book the new flight first and then cancel the
   current one, which is final. When the booking preview's `approval_display_status` is
   `Approval required before booking`, say the current flight will still be cancelled right after
   this confirmation even though the new flight waits for approval, so a rejection leaves the
   traveler without a flight.

Then ask **exactly one question** naming the new flight, its total, the current flight being
cancelled, and any cost, for example: *book United 1008 for USD 312.00 and cancel your current
SFO → JFK flight?* Ask nothing else in this message, and never reuse a question or call to action
from either preview's `message` or `rendered_response`; they describe a plain booking or a plain
cancellation. End the turn.

- Agreement is a clear affirmative to this latest question (`yes`, `ok`, `confirm`) in a new
  reply. The original request, a selection, a reason, a question, a conditional answer, an
  instruction not to ask questions, or a reply to an earlier message is not confirmation.
- A different selection or a changed preview needs fresh previews and a new confirmation.
- If the traveler declines, change nothing and offer to search again.

## Step 8 — book the new flight (only after the explicit yes)

Confirm the booking once, with the exact quote, total, and funding path from the latest preview:

```bash
ramp travel book-flight --action confirm \
  --expected_total_amount <preview_expected_total_amount> \
  --json '{"flight_offer_uuid": "<flight_offer_uuid>", "spend_allocation_id": "<fund_uuid_from_latest_preview>", "traveler_user_id": "<preview_traveler_id>", "trip_id": "<trip_id_from_bookings>"}' \
  --output json \
  --rationale "book the replacement for the DEN→SFO Jul 9 flight; traveler approved both changes"
```

MCP:

```json
{
  "flight_offer_uuid": "{flight_offer_uuid}",
  "action": "confirm",
  "expected_total_amount": "{preview_expected_total_amount}",
  "spend_allocation_id": "{fund_uuid_from_latest_preview}",
  "traveler_user_id": "{preview_traveler_id}",
  "trip_id": "{trip_id_from_bookings}",
  "rationale": "book the replacement for the DEN→SFO Jul 9 flight; traveler approved both changes"
}
```

Call `SubmitFlightBooking` with the above. Use `flight_quote_uuid` instead of
`flight_offer_uuid` if seats were saved, pass exactly one funding path (`spend_allocation_id`, or
`request_new_fund=true` with `reason`), and add `oop_reason` for an out-of-policy flight.

Act on the first case that matches:

- **The total changed:** nothing was booked or cancelled. Run the booking preview again (with the
  same `flight_quote_uuid` when the error names one) to get the new total, present it, and ask the
  Step 7 question again.
- **Unknown outcome** (a timeout, a dropped connection, or an unexplained server error, including
  one that only names an internal failure such as `Error running tool …`): the
  booking may have been created before the error. Never confirm again and never search for
  another flight. Check `travel bookings` / `GetBookings` for the traveler; continue to Step 9
  only if it shows the new booking. Otherwise cancel nothing, say the outcome is unknown, and
  share the booking's `support`.
- **"A booking request has already been submitted for this flight"**: a request for this flight
  already exists, but it is not this submission. Repeating this same confirm returns its booking
  instead of this error, so the request may be for another traveler, by another booker, or older.
  Never confirm again, never search for or submit another flight, and **cancel nothing**, because
  nothing shows that request replaces this flight for this traveler. Look up the request with
  `travel booking-details` / `GetBookingDetails` when the error names it. The CLI prints only the
  error's message, without the request ID: find it with `ramp travel bookings --include_flights
  --include_failed --output json` and the new flight's arrival city and date (the entry with the
  new flight's airline, flight numbers, and dates). Then say the current flight is unchanged,
  report that request's status as shown (or that it couldn't be found), and share the booking's
  `support`.
- **Any other error that says why the booking was refused** (for example a missing input such as
  the trip purpose, a policy or permission refusal, or an unavailable fare): nothing was booked,
  so cancel nothing. Say the current flight is unchanged, relay the `message`, and offer to search
  again. If the error names a missing input, collect it and ask the Step 7 question again before
  another confirm.
- **`booking.status` is `rejected`:** the new flight was not booked, so cancel nothing. Say the
  current flight is unchanged, relay the result's message, and offer to search again.
- **Otherwise the booking was accepted:** keep `booking.booking_request_id` and continue to
  Step 9 right away, without asking again. When `booking.status` is `approved`, the new flight is
  still being booked; say so when reporting, without calling it confirmed or ticketed.

## Step 9 — cancel the current flight

Confirm the cancellation once, with the `preview_id` from the latest qualifying preview:

```bash
ramp travel cancel-flight "<flight_booking_id>" --confirm \
  --preview_id "<preview_id>" --output json \
  --rationale "cancel the DEN→SFO Jul 9 flight after booking its replacement; traveler approved"
```

MCP:

```json
{
  "flight_booking_id": "{flight_booking_id}",
  "confirm": true,
  "preview_id": "{preview_id}",
  "rationale": "cancel the DEN→SFO Jul 9 flight after booking its replacement; traveler approved"
}
```

Call `SubmitFlightCancellation` with the above. The new flight is already booked, so any outcome
that leaves the current flight active means the traveler holds **both flights** until it is
cancelled — say so. Act on the first case that matches:

- **An error with `latest_preview`** (the terms changed, or the flight is no longer
  cancellable): nothing was cancelled. The CLI prints only the message (for example
  "Cancellation terms changed since the preview"); run the Step 3 preview again and use it as
  `latest_preview`. If `latest_preview` qualifies, present its
  `rendered_response` the same way, say the new flight is booked, and ask: cancel your current
  flight now? On a new, explicit yes, confirm once with its `preview_id` and handle the result
  with these same cases. If it doesn't qualify, say the new flight is booked, the current flight
  can't be cancelled for a full refund here and why, and send the fallback.
- **Unknown outcome** (a timeout, a dropped connection, or an unexplained server error, including
  one that only names an internal failure such as `Error running tool …`): the
  cancellation may have gone through before the error, so do not say it wasn't cancelled. Check
  the flight with `travel bookings` / `GetBookings`, report what it shows, and share `support`.
  **Never retry the cancellation.**
- **Any other error that says why the cancellation was refused** (for example a permission
  error, or the flight can't be cancelled here): the flight was not cancelled. Relay its
  `message` and any `support`, and send the fallback.
- **`result.already_requested` is `true`:** a cancellation was already requested elsewhere. Say
  so, check `travel bookings` / `GetBookings`, and report what it shows.
- **`result.cancellation_state` is `PENDING`, `PROCESSING`, or `SUCCESS`:** the cancellation is
  in progress (complete for `SUCCESS`) and the full refund to the original form of payment is
  processing.
- **`result.cancellation_state` is `ACTION_REQUIRED`:** the flight is not cancelled yet. Relay
  `result.message` and `result.support`.
- **No `cancellation_state`, or anything else unexpected:** the cancellation may still go
  through, so do not say it wasn't cancelled. Check the flight with `travel bookings` /
  `GetBookings`, report what it shows, and share `support`. **Never retry the cancellation.**

## Step 10 — report both results

Report the new flight first: its returned status, its flight segments (airline, flight number,
date, and times), and the confirmation email when present. Then report the current flight's
cancellation in the result's own words.

- Never call the original flight cancelled unless `cancellation_state` is `SUCCESS`; for
  `PENDING` or `PROCESSING`, say it is being cancelled. Never say the change is complete while
  either side is pending.
- Never call the new flight ticketed, confirmed, or approved unless its result says so. The
  booking confirm response is optimistic: to check fulfillment, pass the `booking_request_id`
  you kept to `travel booking-details` / `GetBookingDetails` (fulfilled entries in
  `travel bookings` may not carry it). The flight is ticketed only when its `flight.status` is
  `CONFIRMED` and `flight.ticketing_status` is `TICKETED`; `TICKETING` is still in progress.
- Never promise a refund timeline the responses didn't state; route later "where's my refund?"
  questions to the Ramp web app or the booking's support channel.

## If this flight can't be rebooked here

The fallback is the `self_serve_action.deep_link_url` from Step 2, shared once with its
`cta_label` as the link text, so the traveler can cancel and rebook in the Ramp web app. Share no
other link for this. If there is no such link, point them to the booking in the Ramp web app or
the booking's support channel.

- Give the reason from the cancellation preview's fields (`is_currently_cancellable`,
  `blocked_reason`, `refund_to`, `refund_amount`, `airline_credits`, `cancellation_fee`, or a
  multi-city `itinerary`), never from the self-serve action alone. If this conversation has no
  preview yet, run the Step 3 preview first. When the tool returned an error instead of a
  preview, the error's `message` is the reason.
- Send the fallback in the same message as the reason. Don't ask whether the traveler wants it.

## Gotchas

- Keep passing the `flight_booking_id` from `travel bookings`. Previews and results may echo a
  different (parent) booking ID; do not switch to it.
- The cancellation preview's `message` and `rendered_response` describe a plain cancellation.
  Never present the cancellation on its own before the new flight is chosen, and never confirm it
  before the new booking is accepted.
- The booking tools only create new bookings. Never pass the current booking's ID or quote to
  `travel book-flight` / `SubmitFlightBooking`.
- Search and cancellation times are airport-local with that airport's UTC offset. Present them
  as-is; never convert them.
- Offers expire. If a preview reports an expired offer, say so and search again; a fresh
  selection needs fresh previews and a new confirmation.
