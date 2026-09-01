# Message pagination: remaining rollout gate

Status: bounded latest/history/context implementation is present in the current worktree; packaged
Electron A/B and complete parity signoff remain open
Last audited: 2026-09-01

The selected policy is a five-page/500-message normal window with a separately enforced retained
byte ceiling. Ordinary history loads older pages only; centered search, deep-link, and reconnect-gap
contexts may load in either direction. Jumping to the present resets to the canonical latest tail.

Retained baseline evidence:

- [deterministic methodology](./evidence/openbot-message-pagination-2026-09-01/methodology.md)
- [deterministic results](./evidence/openbot-message-pagination-2026-09-01/summary.json)
- [live API methodology](./evidence/openbot-message-pagination-2026-09-01/live-api-methodology.md)
- [live API results](./evidence/openbot-message-pagination-2026-09-01/live-api.json)
- [prior Electron observation](./evidence/openbot-message-pagination-2026-09-01/electron-current.json)

## Open validation

### Functional and correctness matrix

- Prepend anchoring, repeated older loads, latest reset, search before/after continuation, message
  links, unread/reconnect gaps, and disjoint realtime arrivals.
- Thread roots/replies, pending sends, edits/reactions, attachments/rich cards, retry/offline
  recovery, channel switching, warm-view/LRU eviction, stale request cancellation, selection,
  keyboard focus, and screen-reader order.
- No missing or duplicate IDs after overlapping pages, byte/count eviction, channel changes,
  reconnects, context changes, and resets. Never evict the active anchor, pending local send,
  centered target, required thread ancestry, or latest-tail unread metadata.

### Matched UI parity

- Run CUA screenshots and geometry checks at 100, 500, and 5,000 messages across the supported
  desktop resolutions on matched current and candidate builds.
- Require no unintended change in message/card styling, density, composer, header/sidebar,
  controls, scroll position, selection, focus, or accessibility behavior.

### Packaged Electron A/B

- Compare current and candidate with identical production bundle settings, isolated profile,
  database fixture, viewport, route, payloads, warmups, and sample counts.
- Record input-to-next-paint for page loads, sustained scroll frames, long tasks, React commits,
  heap after controlled GC, mounted DOM/listeners, API bytes, anchor error, latest reset, and
  search-context target-to-paint.
- Require bounded steady-state heap, the configured count/byte caps, no new long-task/frame or
  anchor regression, and no loss of search/deep-link/thread usability. Keep failures and retries in
  the dataset.

## Completion rule

Delete this plan after the deterministic/API suites, packaged Electron A/B, and full multi-resolution
CUA replay pass against the same candidate. The implementation existing in source is not by itself
the final rollout evidence.

## Current code to validate

- `apps/desktop/src/renderer/lib/message-history-window.ts`
- `apps/desktop/src/renderer/state/use-openbot.ts`
- `apps/desktop/src/renderer/components/openbot/chat-pane.tsx`
- `apps/desktop/test/message-history-window.test.ts`
- `scripts/performance/benchmark-message-pagination.ts`
