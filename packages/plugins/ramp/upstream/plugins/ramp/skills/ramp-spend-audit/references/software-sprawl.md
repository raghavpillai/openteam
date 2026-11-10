# Software We May Be Paying For Twice

Use this review to find possible repeated software charges. It produces a review candidate, not a confirmed duplicate. Separate teams, products, seats, or valid individual plans can all explain why two people pay the same vendor.

## Investigation

1. Review six months of cleared card activity only. Normalize vendor names before
   comparing charges.
2. Keep currencies separate. For each vendor and currency, subtract refunds from
   spend before comparing totals.
3. Look for recurring charges with overlapping periods from different cardholders.
   Compare the dates, amounts, users, funds, and categories.
4. Exclude travel, dining, and group events. Also exclude multiple-attendee patterns
   and all bill activity from this audit.
5. Exclude trip-linked activity. trip_id = 0 means not travel-linked. Positive trip IDs are trip-linked and excluded.
6. Ask whether the charges cover separate teams, products, seats, or valid individual
   plans before saying that either charge is unnecessary.

## Recommended Output

```text
Finding X: <Vendor> may have two software plans during the same review period.
<Show the cleared card charges, refunds, currency, overlapping periods, and different
cardholders. State what is still unknown.>
Next step: Ask the cardholders whether both plans are needed before changing anything.
```

**Finding 1: Two people may have separate Zoom plans**
Alex and Sam both paid Zoom during the same six months. They may still need separate plans.

**Next step:** Ask Alex and Sam whether both plans are needed. I can show you the charges here, but cancellation must happen in Zoom.

Do not cancel a subscription, remove a card, or change a vendor payment method. If the
customer confirms that the vendor should remain and wants a Ramp control, use the
recurring-spend-controls guide.
