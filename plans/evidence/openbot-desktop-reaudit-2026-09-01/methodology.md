# Desktop re-audit methodology

## Isolation

- Audit date: 2026-09-01; host path: macOS Electron.
- Realistic fixture: fresh disposable database, 250 bots plus 25 groups, 275 channels, 5,506
  messages, 275 routines, and 6,557 search documents.
- Stress fixture: isolated database with 1,104 bots, 1,105 channels, 32,409 messages, 1,354
  routines, 35,967 search documents, and one 10,020-message conversation.
- Production renderer replays used disposable Electron profiles. They never opened the installed
  OpenBot profile.
- Data-rich CUA used the frozen production renderer on port 5175 and disposable server on port 8879.
  The isolated packaged directory retained the normal port-8787 tunnel and therefore validated fresh
  boot/authentication, not the heavy data path.

## Measurement classes

1. **Production Electron/CUA:** macOS accessibility performed clicks, typing, keyboard navigation,
   resizing/toggling, and right-click. Search, image menu, mentions, attachments, settings, and sidebar
   parity were evaluated through the visible app.
2. **CDP diagnostics:** read-only observation collected navigation/paint entries, rAF cadence, DOM
   bounds, listeners, heap/GC, resource timing, and CPU samples. For the 22 ms Search result, an
   observer was armed through diagnostics, CUA performed the click, and diagnostics read the resulting
   input timestamp; no diagnostic script clicked the UI.
3. **HTTP end-to-end:** each clock stopped only after the complete response body was consumed and JSON
   parsed. TTFB/server/transfer/decode were retained separately where available.
4. **Heap retention:** before/after snapshots followed retaining paths and counted the exact projection
   array/preview-string shapes. The post-fix HMR run is used only for structural absence, not a total
   heap comparison.
5. **Isolated A/B:** deterministic source-level loops compared old and optimized algorithms for
   notifications, updater parsing, mentions, row registration, and unchanged routines. The final run
   timestamp was `2026-09-01T18:28:18.990Z`.
6. **Build/package:** a coherent production build was budgeted, then an isolated macOS directory
   package was built. ASAR entries were enumerated for runtime dependencies, maps, WASM, and native
   modules before a fresh-profile boot/frame smoke.

## Workload protocol

- Cold navigation used a fresh profile/build load; warm switching cycled four channels so the
  three-channel warm cache could not make every transition a cache hit.
- Realistic navigation sampled ten cold first-opens and thirty warm switches. Stress navigation used
  sixty rapid switches and a separate long-conversation replay.
- Sidebar frame cadence covered 15,220 px over 120 animation frames. Final production/package frame
  samples also used 120 frames.
- Search timings retain the intentional 50 ms debounce. Search API results were capped at 24.
- DOM mount counts are reported alongside totals so virtualization can be distinguished from merely
  fast rendering of an unbounded list.

## Comparison rules

- Only the same view shape is used for the 42.3 → 18.8 ms visible A/B. The later 10,020-message,
  multi-surface CUA state is reported independently.
- Header/TTFB numbers are not substituted for full request times.
- Synthetic algorithm results are not described as Electron interaction times.
- Process working sets may double-count shared pages and are diagnostic, not unique physical memory.
- The missing post-fix notification-retention objects are valid structural evidence. Development HMR
  makes its total heap unsuitable for a flat before/after claim.

## Excluded harness artifacts and release gaps

- A blank audit window produced while a clean build replaced hashed chunks under a live static server
  was discarded. A stale CUA element identifier that briefly appeared blank was also discarded.
- No message was sent, image copied/saved, file attached, or account/profile setting changed.
- No signed/notarized artifact, live update/rollback, physical Windows/Linux device, multi-hour
  background-power soak, assistive-technology matrix, or exhaustive native dialog branch was tested.

Exact values are in [`summary.json`](./summary.json); interpretation and prioritized follow-ups are in
[`../../40-desktop-performance-reaudit.md`](../../40-desktop-performance-reaudit.md).
