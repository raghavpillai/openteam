# Event-triggered routines: remaining work

Status: durable state, routine lifecycle, schedule dispatch, trigger parsing, files, APIs, and
desktop inspector shipped; non-cron delivery and source-incomplete safety policy remain open
Last audited: 2026-09-01

## Supported contract awaiting delivery

OpenBot can parse and preserve Slack, GitHub, Origin, Microsoft Teams, Linear, Sentry, PagerDuty,
webhook, and allowed grouped triggers. Only cron/interval listeners currently have a production
execution transport. Unsupported event sources must continue to fail closed rather than appear
active.

## Open work

### Provider ingress

- Choose a polling, subscription, or authenticated webhook adapter per provider and bind every
  listener to an explicit installed connection/account grant.
- Normalize each provider event into a bounded durable envelope with source, connection, event ID,
  delivery ID, received time, subject, redacted metadata, and an immutable payload reference.
- Define acknowledgement, retry, backoff, dead-letter, ordering, replay, and retention behavior per
  source. A provider retry must not create a second routine execution.
- Define group-listener coalescing, the time window and maximum coalesced IDs, and the mapping into
  `runs.json` plus PostgreSQL execution history.
- Authenticate webhook senders, rotate/revoke sender keys, rate-limit ingress, and never expose the
  key to the model or transcript.

### Safety and spend policy

- Decide which user-authored versus external/untrusted routine changes require confirmation and
  how that decision is represented in files, APIs, and audit events.
- Specify spend-guard counting window, threshold, pause/disable action, notification, and explicit
  re-enable flow.
- Decide whether the five-minute cadence guard rewrites, clamps, or rejects each schedule form and
  define its notice lifecycle.
- Define failure-streak auto-pause and recovery behavior; do not infer policy from prompt text.
- Reauthorize connector grants and consequential calls when the event executes. Creating a routine
  never grants new capabilities or pre-approves future side effects.

## Acceptance gates

1. Every advertised trigger source can deliver a real event end to end through the bot mailbox and
   bot-wide lease while Electron is closed.
2. Duplicate, reordered, retried, coalesced, and replayed provider deliveries have deterministic
   execution/history results with no duplicate visible send caused by OpenBot.
3. Revoked connections and webhook keys stop new delivery immediately; payloads, credentials, and
   private provider data are redacted from prompts, logs, SSE, and audit projections as designed.
4. Grouped cron/event listeners preserve their exact trigger presentation, source IDs, and next
   schedule while sharing one routine prompt.
5. Confirmation, cadence, spend, overlap, failure, and re-enable behavior is documented in product
   copy and covered by restart and live-provider tests.

## Current code to extend

- `packages/messaging/src/automation-trigger.ts`
- `packages/messaging/src/routines.ts`
- `packages/messaging/src/automation-files.ts`
- `apps/server/src/services/plugin-service.ts`
- `apps/worker/src/worker.ts`
- `apps/desktop/src/renderer/components/openbot/routine-event-fields.tsx`
