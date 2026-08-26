# Renderer performance optimization and monitoring

Status: implemented and production-profiled  
Last updated: 2026-08-25

## Outcome

OpenBot's Electron renderer now performs one small client-specific bootstrap, keeps recent views warm, and records local performance diagnostics without adding telemetry. Production browser profiling against the real Compose stack measured a 40 ms first paint, a 76 ms first contentful paint, and 8.3 ms average click-to-painted-view latency across 30 warm bot switches. No long tasks were observed.

## Bottlenecks found and fixed

The initial client had an effect dependency cycle: every snapshot response created a new snapshot object, which reran the bootstrap effect and requested another full snapshot. A 68-second profile accumulated hundreds of requests and roughly 52 seconds of task time. Bootstrap is now one-shot, reconnect retries consult a ref, and React Strict Mode cannot duplicate the request.

The former `/api/v0/snapshot` response included every archived bot's internal model transcript, all run items, and all historical records. In the live QA database it was 104,001 bytes. The renderer now uses `/api/v0/client-snapshot`, which:

- returns only non-archived bots and active channels;
- scopes messages, rounds, runs, items, and approvals to those channels;
- omits internal `Message` transcript records;
- omits agent-message and reasoning run items that the UI intentionally does not render;
- caches computer/Codex health for two seconds and coalesces concurrent checks;
- exposes `Server-Timing` for the snapshot query.

The same live state is 2,236 bytes, a 97.8% reduction. Ordinary GETs also stopped attaching a JSON `Content-Type`, eliminating cross-origin preflights from the Vite/Electron renderer.

## Rendering strategy

- Reconciliation preserves both entity identity and collection identity and prunes stale cache entries.
- Runtime/workspace records keep their identity when unchanged; a cursor-only refresh does not commit a React update.
- Snapshot indexes are memoized per collection. Per-channel arrays remain stable when activity in another channel changes.
- Warm chat panes compare only their own run-item and approval groups, so activity in another bot cannot invalidate them.
- The active channel and two recent channels keep both chat and inspector trees mounted. Drafts, scroll state, screen state, and layout stay hot.
- Hidden inspectors stop screen polling and release any graphical input lease.
- A preview click sets noVNC to interactive mode on its first navigation, preventing a view-only load followed by a second navigation.
- Plain text messages bypass Streamdown entirely. Basic Markdown and advanced code/math/diagram rendering use separate lazy boundaries.
- Bot and group form code is split from startup and prefetched during browser idle time, keeping both bootstrap and later dialog opening fast.
- Quiet SSE reconciliation commits through a React transition; clicks and typing remain urgent.
- Invisible token/reasoning events advance the replay cursor but do not request a client snapshot.
- Focus and visibility wakes coalesce, and an SSE wake is skipped when the latest snapshot cursor already contains that event.

## Local performance monitor

`window.openbotPerformance` exposes a bounded in-memory ring buffer in DevTools:

```js
window.openbotPerformance.summary()
window.openbotPerformance.snapshot()
window.openbotPerformance.clear()
```

It records successful and failed API latency, response size, server timing, snapshot reconciliation, startup paint milestones, channel switching, dialog/details opening, desktop/noVNC readiness, Event Timing, and Chromium long tasks. Nothing is transmitted or persisted. Development builds—and production builds opened explicitly with `?profile=1`—also mirror the rolling summary and latest 50 samples onto `data-openbot-performance` attributes for browser-driven regression profiling.

## Measured production profile

| Metric | Result |
| --- | ---: |
| Legacy full snapshot | 104,001 bytes |
| Client snapshot | 2,236 bytes |
| Snapshot reduction | 97.8% |
| Quiet startup requests | 1 client snapshot + 1 selected-screen status; no polling growth |
| Client snapshot server time | 2.2–12.8 ms in local QA |
| Snapshot reconciliation | 0.2 ms |
| First paint | 40 ms |
| First contentful paint | 76 ms |
| First UI paint marker | 51.6 ms |
| Warm channel click-to-painted-view, 30 switches | 8.3 ms average, 10.3 ms p95, 10.5 ms max |
| Chromium click Event Timing | 34.1 ms average, 48 ms max |
| Desktop overlay click-to-paint | 9.8 ms |
| noVNC interactive-ready | 51.2 ms |
| Renderer long tasks | 0 |
| noVNC navigations on interactive open | 1, immediately `view_only=false` |

The production entry chunk is 372.7 KB minified / 118.3 KB gzip. Forms are isolated in an 8.36 KB / 3.03 KB gzip chunk. The normal message response wrapper is 0.30 KB; the 585.1 KB advanced code/math/diagram path remains lazy and does not load for plain chat.

## Performance budgets

- one client snapshot on a quiet startup;
- no snapshot polling while idle;
- under 100 KB compressed for the entry script and under 15 KB compressed for shell CSS are stretch targets; the current entry script is 116.5 KB and remains the next bundle target;
- under one 16.7 ms frame for a warm view switch on a normal 60 Hz display;
- under 100 ms for the interactive desktop viewer to become ready on the local Compose stack;
- no renderer long task over 50 ms during startup or switching;
- no hidden screen polling or retained takeover lease;
- rich Markdown/code/diagram chunks load only when content requires them.

## Next scale boundary

The remaining unbounded path is visible channel history. v0 intentionally keeps the complete active transcript available, with `content-visibility` protecting off-screen rows. Before large deployments, add cursor-paginated history with scroll anchoring and an accessible virtualizer, driven by measurements rather than an arbitrary message cutoff.
