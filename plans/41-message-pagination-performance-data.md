# Message pagination: packaged rollout gate

Status: production reducer, live API, deterministic scaling, and focused correctness evidence pass;
matched packaged candidate Electron and multi-resolution parity remain open
Last audited: 2026-09-01

The selected policy is implemented in the current worktree:

- 100-row keyset network pages;
- ordinary history loads older only;
- search, deep-link, and detected-gap contexts load in both directions;
- one deduplicated 500-message / 2 MiB retained union across primary history, ancestry, centered
  context, and cached latest tail;
- viewport-pivot eviction with scroll-direction runway;
- immediate cached-tail reset;
- three warm channel histories and a separate 100-message / 512 KiB open-thread pin.

## Retained evidence

- [full report](./evidence/openbot-message-pagination-2026-09-01/report.md)
- [deterministic methodology](./evidence/openbot-message-pagination-2026-09-01/methodology.md)
- [deterministic results](./evidence/openbot-message-pagination-2026-09-01/summary.json)
- [live API methodology](./evidence/openbot-message-pagination-2026-09-01/live-api-methodology.md)
- [live API results](./evidence/openbot-message-pagination-2026-09-01/live-api.json)
- [packaged Electron A/B methodology](./evidence/openbot-message-pagination-2026-09-01/electron-ab-methodology.md)
- [superseded preliminary renderer observation](./evidence/openbot-message-pagination-2026-09-01/electron-current.json)

## Passing gates

- Two full deterministic runs reproduce observable checksum `7077200170`. Every measured candidate
  window stays within 500 unique rows and 2 MiB; the largest peak is 2,097,141 bytes.
- The isolated 10,040-row API fixture completes a full keyset walk and the centered/pathological,
  page-size, thread-ancestry, and reconnect probes. A 100-row page remains the selected network
  compromise.
- Focused reducer/scroll/thread/motion coverage passes 53 tests, 0 failures, and 271 assertions.
- A uniquely packaged pre-feature baseline and its 100-row, 5,000-depth, realistic, stress,
  reversal, context, and latest-reference captures are complete.

## Remaining gate

Finish the uniquely packaged candidate replay against the same API fixture, viewport, interaction
cadence, and fresh-profile rules. Fill every `PENDING_CANDIDATE` field in the report and Electron
methodology, then require:

- forced-GC heap plateaus under deep traversal and exact retained telemetry remains within limits;
- 12-second realistic, 60-second stress, and 15-second reversal rAF distributions do not regress;
- the visible anchor settles within 1 px and survives at least one second through older/newer,
  refresh, and direction-reversal transitions;
- search target paint, bidirectional continuation, cached jump-latest, reply target, and open
  thread remain usable;
- screenshots/geometry, focus, reduced motion, keyboard navigation, list semantics, and supported
  compact/minimum-window layouts preserve the prior UI contract;
- production build, bundle budget, typecheck, and relevant full test gates pass from the isolated
  candidate source.

## Completion rule

Delete this plan and its row in `plans/00-index.md` only after the packaged candidate metrics and
multi-resolution CUA parity are recorded without a regression. Source implementation and unit tests
alone are not the rollout gate.
