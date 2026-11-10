---
name: ramp-agentic-purchase
metadata:
  title: Agent Card Checkout
area: Agentic Commerce
supported_surfaces: [browser, cli, mcp]
description: >-
  Agent Card Checkout: make one authorized browser checkout purchase. Use when a
  merchant checkout accepts card details. Do not use for Stripe MPP, x402, bill
  payment, procurement, travel booking, reimbursements, or account setup; route
  those to their dedicated skills.
---

# Agent Card Checkout

Use for a browser checkout that accepts card details. Load
[browser-checkout.md](browser-checkout.md) for headed browser operation and
human handoff.

## Access

If fund discovery returns no usable options, check whether the connected Ramp
user has access to an active fund that permits virtual cards and is not locked.
Explain which eligibility condition is missing and ask the customer or admin to
resolve it before proceeding. A connected Ramp user can purchase without
creating a standalone agent identity.

## Prepare the exact purchase

1. Inspect the cart or checkout before getting credentials. Confirm it contains
   only the intended items and the actual total, including known tax, shipping,
   fees, and currency. Do not leave previously saved cart items in scope.
2. If guest checkout needs contact or delivery details, ask for those details.
   Cardholder and billing values returned with payment credentials belong only in
   the payment form; do not copy them into merchant contact fields.
3. In Ramp MCP `tools/list`, use `ramp_get_agent_card_funds` (summary: "List funds that
   can be used for agent card payments") to find accessible eligible funds. It
   returns the eligible funds and available balance. Select only a fund that fits
   the customer's authorized purpose and funding choice. Check returned merchant
   and category restrictions, currency, balance information, and per-transaction
   limit against this purchase. Missing or incomparable balance data does not
   prove sufficient balance. `ramp funds get-agent-card-funds` is the optional
   CLI equivalent.
4. Check authorization already given by the customer. Proceed without another
   confirmation when it covers this exact merchant, purpose, total, currency,
   and fund. Ask only if one of those changes or no approval exists; there is no
   blanket percentage tolerance.

## Issue and submit credentials

In Ramp MCP `tools/list`, use `ramp_get_agent_card_creds` (summary: "Get a one-time
payment token for a fund") only for the prepared purchase. Its contract requires
`fund_id`, `merchant_name`, `merchant_url`, `merchant_country_code`, `amount`,
and `currency_code`; include the required rationale and preserve the same retry
identity for recovery when supplied. `ramp funds creds <fund_id>` is the optional
CLI equivalent; obtain its current flags with leaf `--help`.

Submit the returned card details immediately with any available browser capability
and verify the merchant's result. A credential is not a completed merchant
payment. If the checkout total changes but remains inside the customer's
explicitly approved limit, continue with the exact new total; otherwise obtain
approval for the changed purchase before issuing credentials.

## Recovery and completion

- If credential issuance fails before any merchant submission, recover only the
  same request with its existing retry identity. If the issuer reports that the
  original request cannot be safely recovered, do not start a new issuance attempt;
  report the issue.
- If merchant submission times out, the response is lost, or the result is
  unclear, reconcile that checkout and payment status before another credential
  or fund. Do not infer that no charge occurred.
- A clear decline or unsupported checkout does not authorize a different fund.
  Ask only when the proposed alternative changes the approved scope, budget, or
  funding; otherwise it may be used before any outstanding attempt.
- After a confirmed card purchase, locate its resulting transaction, check its
  required fields, and complete only the customer-authorized memo, coding, trip,
  and receipt work. Preserve the merchant confirmation as a receipt when it is
  available.
