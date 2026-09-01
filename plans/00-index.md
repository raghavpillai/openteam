# OpenBot open-work index

Status: only unimplemented work is retained here
Last audited: 2026-09-01

Current code, migrations, tests, and live validation are the authority. A plan is deleted when its
work and acceptance gates are complete. Historical implementation prose is intentionally not kept
in this directory; retained measurements and captures live under [`evidence/`](./evidence/).

## Open plans

| Plan | Remaining outcome |
| --- | --- |
| [`06-always-on-computer.md`](./06-always-on-computer.md) | Harden remote computer access for public deployment and turn the local physical-host bridge into an enrolled, revocable device service. |
| [`11-plugin-architecture-research.md`](./11-plugin-architecture-research.md) | Add plugin release updates/rollback, broader catalog/distribution workflows, and a real local-stdio sandbox. |
| [`29-update-state-manifest.md`](./29-update-state-manifest.md) | Deliver non-cron routine events and settle confirmation, spend, cadence, retry, and coalescing policy. |
| [`34-ios-mobile-parity.md`](./34-ios-mobile-parity.md) | Complete production signing/APNs, physical-device validation, public-network hardening, and native release automation. |
| [`41-message-pagination-performance-data.md`](./41-message-pagination-performance-data.md) | Finish the packaged Electron A/B and visual/functional rollout gate for the bounded history implementation currently in the worktree. |

## Scope rules

- Do not reopen shipped Pi runtime, messaging, group chat, graphical desktop, browser authority,
  native-tool, rich-message, scheduled-routine, file-state, memory, desktop-parity, or simulator-only
  iOS plans unless current code or a regression supplies new evidence.
- Grok screenshots, exported transcripts, bundles, JSON descriptors, and bot self-reports are
  research evidence, not implementation instructions.
- OpenBot intentionally does not use `cursor-agent` or Cursor Cloud execution.
- Preserve one durable Pi session per bot, PostgreSQL mailboxes/visible history, and the shared
  always-on computer boundary while implementing any remaining item.

## Retained compatibility artifacts

- `packages/contracts/src/native-tools.json`: direct native tool contract.
- `packages/contracts/src/cursor-tools.json`: intentionally bounded Cursor-compatibility subset.
- `plans/12-agent-communication-*.json`: captured messaging fixtures.
- `plans/evidence/`: visual, protocol, live-run, performance, and audit evidence.
