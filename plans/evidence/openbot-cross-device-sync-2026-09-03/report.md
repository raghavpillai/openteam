# Desktop ↔ iOS message-sync verification — September 3, 2026

## Verified behavior

- **Mobile → desktop and desktop → mobile:** the sender displays its optimistic message immediately; the peer receives the committed message automatically, without switching conversations or refreshing.
- **Incoming replies:** visible on both clients. The live audit used explicitly labeled simulated agent replies, not paid inference or third-party conversations.
- **Background iOS:** messages and replies sent while suspended appeared after foregrounding. A suspended iOS UI is not expected to update instantly.
- **Offline sending:** mobile showed the message with “Will send when reconnected,” then delivered it exactly once after the local proxy returned. Desktop reconnected and caught up too.
- **Delayed acknowledgements:** an 8-second pre-commit delay plus an 8-second acknowledgement delay did not block local optimistic display or cause duplicate rows. Delivery is pending until acceptance, not falsely labeled as sent.
- **Read failure and bursts:** both clients recovered after an injected HTTP 503; a live 30-message incoming burst reached both. Automated tests additionally cover 150 events across multiple bounded event batches.

## Fixes

1. Keep the first coalescing timer during continuous traffic, rather than restarting it for every event and potentially starving refreshes. Refreshes remain serialized.
2. Make mobile snapshot/history/activity reads coherent, with operation/channel/revision guards. Retry updates skipped by hydration, paging, or a competing local history change, even if there is no subsequent event. Global previews can still refresh while history work is pending.
3. Retry failed desktop snapshot reads even while the event stream remains connected. Retry timers stop during suspension/disposal; fallback polling intervals are unchanged.
4. Fix an intermittent **two-slot durable journal** bug on both clients. Deriving each generation from wall-clock parity could overwrite the same slot twice and lose the recovery copy. A shared monotonic generation helper now alternates slots regardless of clock jumps or write timing. A deterministic corruption-recovery test reproduces the original failure.

These changes do not modify rendering structure, animation durations/easing, layout, haptics, or history/virtualization budgets.

## Automated verification

- **1,182 tests passed**, all 18 workspace test tasks and all 12 typecheck tasks.
- The 23 focused sync/journal tests passed **10 consecutive runs**.
- Real loopback HTTP regression tests use the production server SSE/poll implementations, the real client transports, shared live-sync controller, durable send controller, and outgoing-message projection. The event/data source is in-memory; these are integration tests, not full native UI tests.
- Covered: local display before disk persistence/network acceptance, echo before HTTP acknowledgement, both sending directions, incoming messages, ordering/deduplication across event batches, final-update read failure, transport reconnect, background/resume, hydration races, account/channel retirement, bigint cursor precision, and journal corruption recovery.
- Both production JavaScript builds, architecture/duplication checks, mobile native configuration, and existing bundle budgets passed. No budget was raised.
- Final bundle measurements: desktop entry **712,493 B**, startup **1,012,851 B**; iOS Hermes **4,655,858 B**, **2,201 modules**, **26 assets**.

## Live audit and profiling

Isolated Compose project/database `openbot-client-perf-20260903` / `openbot_perf_audit`; 1,103 synthetic conversations. Dedicated Simulator device `OpenBot Performance 0903`, Release native shell and production Hermes bundle; separate Electron profile with production renderer. The normal stack and user conversations were not used. A loopback-only proxy injected delay/disconnection/read failure without changing OS networking.

The Electron observer recorded **15 ms from send-button click to optimistic DOM insertion**. For one mobile send, the desktop DOM updated **169 ms after the upstream acceptance response**, while the sender's HTTP acknowledgement was still deliberately held. These are individual observations, not percentile latency claims or paint timestamps. iOS displayed a busy/pending row in the first UI observation, well before the injected 8-second acceptance delay elapsed; no sub-frame native timing claim is made.

A 30-second Electron CPU/timeline/frame capture during incoming delivery recorded:

| Metric | Observed |
|---|---:|
| Focused, visible frame intervals | 1,788 |
| Frame interval p95 / p99 | 17.6 / 17.7 ms |
| Intervals over 25 ms | 1 |
| Long tasks | 0 |
| History merge p95 | 0.5 ms |
| Snapshot reconciliation p95 | 2.1 ms |
| Mounted message rows at end | 38 |

This is a receive-load sanity check, not a new matched baseline or a guarantee for every device. See the [earlier full performance audit](../openbot-client-performance-2026-09-03/report.md) for matched traces and native profiling limitations. Physical-iPhone, cellular, 120 Hz, energy/thermal, and APNs delivery measurements remain unverified here.

The workspace underwent a separate OpenBot → OpenTeam namespace/native-target rename during this audit. The main live matrix and receive trace use frozen pre-rename production app artifacts; the final automated checks and bundle gates use the updated workspace. Afterward, **both final apps were rebuilt and retested**: a full Xcode Release build (`dev.openteam.mobile`, arm64 UUID `B0A24560-21EE-399D-93C3-F9FA09D9748E`) and the final production Electron renderer. Both sending directions and an incoming reply passed again. Actual disk journals on both apps retained two consecutive alternating generations, and accepted sends retired from the newest journal. This sync change does not claim to validate unrelated branding edits.

## Evidence

- [Machine-readable summary and source hashes](./summary.json)
- [Receive-profile summary](./desktop-receive-profile.json)
- [Final native/desktop journal-slot verification](./final-journal-slots.json)
- Raw HTTP/DOM timestamps, CPU profile, Chromium timeline, builds, repeat-test logs, and native build logs:

```text
/var/folders/qz/z9zw1vg957n39ddb4x5qqjqm0000gp/T/openbot-client-perf-20260903-lfn0e3wc/sync
```

The isolated audit services, Electron processes, and dedicated simulator were stopped after verification; synthetic data and evidence remain available for reproduction.
