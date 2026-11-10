# Regular Payments That Need Better Controls

Use this review when recurring vendor charges lack a clear owner, dedicated fund, or
appropriate spending cap. The goal is exposure reduction and clearer accountability, not
vendor cancellation or a claim of savings.

## Investigation

1. From the shared scan, identify vendors with repeated cleared charges across at least
   two cycles.
2. Confirm the vendor, currency, charge cadence, route, owner, users, and whether a
   general-purpose card or fund currently pays the vendor.
3. Rank the recurring-spend candidates from the shared scan, then read live details for no
   more than the ten strongest candidates needed for the five-result output. Check members,
   limits, merchant restrictions, pending activity, and existing vendor-specific funds.
4. Resolve the merchant before proposing a merchant restriction.
5. Ask the accountable owner to confirm the vendor is expected to continue and to choose
   an appropriate periodic and per-transaction limit.

## Available Recommendations

Depending on controls the current connection and permission confirm are available,
recommend one of these Ramp controls:

- A dedicated vendor-restricted fund for expected recurring charges.
- A lower positive periodic limit based on expected use.
- A per-transaction limit for predictable charge sizes.
- A lock for a dormant fund after the unused-funds review confirms it is safe.

Do not claim to migrate the vendor, update a vendor website, cancel service, or guarantee
that a future charge will be prevented outside the confirmed Ramp control.

## Safe Change Sequence

1. Before creating a vendor-restricted fund, use the authoritative live fund catalog and
   live details surface that exposes vendor restrictions to complete the paginated
   matching-restriction check. Include inactive relevant funds when that surface supports
   them. This is a separate action-time safety gate that paginates to completion regardless
   of the audit detail-read cap: do not rely on the activity shortlist or the capped audit
   detail reads. If a matching vendor restriction already supports the intended route, do
   not create another.
2. Show the exact proposed restriction or limit and its consequences.
3. Receive explicit customer confirmation.
4. Re-read the exact target and repeat the complete matching-restriction check immediately
   before creating a fund. Make the Ramp change only when the current connection and
   permission confirm it is available.
5. If creation returns a timeout or other ambiguous error, do not retry yet. Re-read the
   complete matching set; if the new fund is present, report it and stop. Retry only when
   that complete re-read confirms no matching fund was created.
6. Re-read the created or changed fund and report the verified result.

## Recommended Output

```text
Finding X: <vendor> may need a recurring-spend control.
<Describe the recurrence, route, and current control state. State the exact restriction
or limit, then ask the owner to confirm the vendor, members, and target amount.>
Next step: Apply the exact control only after confirmation.
```
