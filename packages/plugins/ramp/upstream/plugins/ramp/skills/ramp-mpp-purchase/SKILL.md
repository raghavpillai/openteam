---
name: ramp-mpp-purchase
area: Agentic Commerce
supported_surfaces: [cli, mcp]
description: >-
  Make one authorized Stripe MPP purchase from a compatible merchant challenge.
  Use when a merchant returns a Stripe MPP WWW-Authenticate challenge. Do not
  use for Agent Card Checkout, x402, bill payment, procurement, travel booking,
  reimbursements, or account setup; route those to their dedicated skills.
---

# Stripe MPP Purchase

Use only when the merchant has returned a Stripe Machine Payments Protocol
(MPP) `WWW-Authenticate` challenge for the exact request the customer approved.
MPP binds an existing authorized Ramp fund to that merchant challenge; it does
not make a payment until the merchant receives and accepts the credential.

## Preconditions

- If Ramp MCP `tools/list` exposes `ramp_mpp_creds` (summary: "Issue or recover
  a Stripe MPP credential using an existing fund"), use its supplied schema:
  `fund_id`, `www_authenticate`, and `rationale` are required;
  `idempotency_key`, `body_digest`, and `selected_challenge_id` are optional.
  Supply and retain a stable `idempotency_key` for retries; omission generates a
  new key. The connector maps it to `X-Idempotency-Key` and removes the local
  `rationale` before sending the request. If the tool is absent from the
  connected MCP list, report that MPP credential issuance is unavailable on that
  connection; do not install or require the CLI. `ramp funds mpp-creds` remains
  an optional CLI-client path.
- The connection needs `cards:read_agentic`; legacy `mpp:write` alone is
  insufficient. The acting principal also needs an effective MPP payment
  capability. Custom roles start with this capability off: an admin must
  explicitly enable "Make MPP payments using accessible funds" on an applicable
  role. Most purchases use a connected Ramp user. A standalone agent is optional
  early access; it needs its own fund membership and payment grant, and both the
  agent and its owner must be active. A visible `ramp_mpp_creds` tool does not
  establish that new issuance is enabled for this business.
- List candidate funds accessible to the acting principal using an available
  general fund-listing surface (for example, `ramp funds list` in the CLI).
  `ramp_get_agent_card_funds` / `get-agent-card-funds` filters for Agent Cards
  and is not an exhaustive MPP fund directory. Check each candidate against
  the approved purpose, currency, available balance, merchant and category
  restrictions, per-transaction limits, and actor/member limits. Missing or
  incomparable data does not establish eligibility; MPP issuance is the
  authoritative eligibility check. If no suitable authorized fund exists,
  stop and ask the customer or admin. Do not create, fund, infer, or switch
  funds automatically.
- Keep the exact merchant URL, HTTP method, request body, and the complete
  `WWW-Authenticate` header values from the challenge.
- Before the unpaid challenge request and again before the credential-bearing
  retry, require HTTPS with no embedded credentials and allow only `GET` or
  `POST`. Resolve the hostname and reject loopback, private, link-local,
  reserved, multicast, or otherwise non-public IP addresses. Pin the request to
  a validated address while preserving TLS verification for the original
  hostname. If the available HTTP capability cannot pin that address, do not
  call the merchant. Do not follow redirects automatically; validate the new URL
  and ask the user to reconfirm it before continuing.
- If the challenge binds a body digest, calculate it from the exact body that
  will be sent as an RFC 9530 structured digest, for example
  `sha-256=:<base64 SHA-256 digest bytes>:`. Do not use a hexadecimal digest or
  change that body after issuing the credential.

## Procedure

1. Use only a merchant that offers a compatible Stripe MPP challenge. Reuse a
   retained live challenge and request when resuming the same purchase.
   Otherwise make the intended unpaid request and retain the returned
   `WWW-Authenticate` header values. A challenge from another URL, method, or
   body is not usable.
2. If several compatible Stripe MPP challenges are offered, identify one and
   retain its exact `selected_challenge_id`. Do not re-select a different
   challenge later. Decode the selected Stripe `charge` challenge's request and
   read its `amount` (in atomic units) and `currency`; convert the atomic amount
   to the corresponding currency amount without rounding. Do not infer the
   charge from a displayed quote. Reject an absent or unsupported amount or
   currency.
3. Before issuing a credential, compare the final all-in charge (including
   taxes, shipping, and fees) and purpose against the customer's existing
   approval. Show the merchant, URL, method, purpose, fund, and decoded amount
   and currency. Proceed only when the approval covers this exact purchase and
   request binding. A changed amount, currency, merchant, purpose, fund, or
   request binding needs matching approval (an existing approved limit can
   cover a changed amount); showing a quote is not approval. If the final
   all-in amount is unknown or not covered, stop and ask.
4. If a usable prepared credential matches the exact challenge and request,
   submit it and skip issuance. Otherwise generate one idempotency key for this
   new issuance. Reuse it only to recover the same fund, challenge, selected
   challenge, and request binding. A changed intent must not reuse the key.
5. When the connected MCP tool list includes `ramp_mpp_creds`, call it with the
   discovered schema and a concise rationale. For a CLI client, the equivalent is:

   ```bash
   ramp funds mpp-creds "<fund_id>" \
     --www_authenticate '<JSON array of exact WWW-Authenticate header values>' \
     --selected_challenge_id "<selected_challenge_id>" \
     --body_digest "<digest when the challenge binds one>" \
     --idempotency_key "<stable_key>"
   ```

   The CLI command sends `idempotency_key` as a header option. Do not add
   `--rationale` or unrelated JSON fields; this command does not support them.
   On a scope, permission, or rollout-disabled error, explain the specific
   connection, role, or availability gap and stop; do not change funds or rails.
6. Ramp issues the credential; the caller's HTTP capability sends the exact
   challenged merchant request. The response serializes exactly `id` and
   `credential`; use the returned `credential` immediately in an HTTP request
   as `Authorization: Payment <credential>` with the exact challenged URL,
   method, and body. Keep it private: do not display it in chat, logs,
   screenshots, or saved artifacts.
7. Verify the merchant response and settlement result. An issued or pending
   credential can be usable while awaiting merchant consumption, so submit it;
   do not wait for merchant success before sending it.

## Record completion

After a confirmed merchant response, use available transaction listing and
completion tools to locate the resulting Ramp transaction when it becomes
available. Do not invent an immediate transaction ID. When the transaction is
found, complete only customer-authorized receipt, memo, and accounting
requirements. If posting is delayed or the available connection cannot locate
the transaction, report record completion as pending rather than claiming it is
finished.

## Recovery

- If credential issuance has a lost or recoverable result before merchant
  submission, recover only the same request with the same idempotency key and
  unchanged challenge binding.
- If merchant submission has an unknown outcome, reconcile the original request
  with the merchant and Ramp before another credential or payment call.
- If the merchant rejects the credential, report the exact response. Do not
  create another payment until the rejection confirms no payment is outstanding.
  End this MPP attempt; do not select or route to another payment method.
- If the challenge is not Stripe MPP, has no supported compatible option, or
  does not match the approved request, stop. Do not rewrite the challenge.
