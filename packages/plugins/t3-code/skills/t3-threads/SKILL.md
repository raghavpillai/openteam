---
name: t3-threads
description: Inspect, follow, continue, or stop existing T3 Code work without starting duplicate threads.
---

Resolve the intended connected T3 account, then discover its MCP tools. Prefer a saved thread/run reference from this task over searching by a mutable title. Use `t3_thread_list` with explicit `projectId` or `allProjects: true`, or `t3_thread_search`, when locating other work. Read a match before acting.

- For status or history, use `t3_thread_read` and report observed progress, result, failure, or pending human input. Keep reads bounded and follow cursors and text offsets to retrieve the relevant response. A read-only question does not need a coding launch.
- For follow-ups, send to the same thread. Choose `mode: queue` for a new turn, or deliberate steering for a requested mid-run change. Use a stable `clientRequestId` per send and retain its returned `runId` when following that result. Retry with the same key and payload within that OAuth session; after reauthorization, reconcile saved IDs before resending.
- To stop work, interrupt the specified remote run with `t3_thread_interrupt`, verify its resulting state, and only then end local tracking. Ask when multiple active jobs could match. Do not confuse stopping an OpenTeam worker with stopping its remote coding run.
- When T3 needs permission, report that state and the returned thread link for approval in T3. Do not impersonate a human approval through a text response or widen execution modes.

For long waits, pin `t3_thread_wait` to the saved `runId`, inspect settled delegated work when supported, and save the remote IDs, unfinished obligations, `nextAction`, and a future `checkAt` with ReportTaskProgress. A timeout is not cancellation. Keep credentials out of task records and preserve the server-returned link.
