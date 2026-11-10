# Vendors We Pay In More Than One Way

Use this review when a vendor is paid by bill and card. It helps choose the future
payment owner and future payment route. It does not decide that spending was wrong.

## Investigation

1. Compare only activity with the same normalized vendor and currency across bill and
   card activity.
2. Keep bill activity separate from card activity. A bill invoice amount may not equal
   the amount paid in the review period, especially with partial payments.
3. Matching dates and amounts do not prove duplicate spend. Bill and card matches are
   not duplicate spend, so do not assign savings to them. Do not label the activity duplicate.
4. Review recurring patterns, payment dates, funds, and the people who use each route.
   Ask whether invoices and employee purchases have different valid reasons.
5. Ask the business to choose the future payment owner and future payment route for
   the vendor.

## Recommended Output

```text
Finding X: <Vendor> is paid by bill and card during the review period.
<Show the separate bill and card activity, currency, dates, and people or funds involved.>
Next step: Choose the future payment owner and future payment route before changing a Ramp control.
```

**Finding 1: Anthropic is paid by both bill and card**
The company used both payment methods during the review period. Both may be valid.

**Next step:** Choose who should own future Anthropic payments and which payment method to keep. I can show the bill and card activity here, but I cannot change Anthropics website.

Do not change a payment method or set a Ramp control until the business chooses the
future owner and route. Then use the recurring-spend-controls guide for a precise
control proposal.
