---
name: t3-threads
description: Inspect, follow, continue, or stop existing T3 Code work without starting duplicate threads.
---

Resolve the intended connected T3 account, then discover its MCP tools. Prefer a saved thread/run reference from this task over searching by a mutable title. Use `t3_thread_list` with explicit `projectId` or `allProjects: true`, or `t3_thread_search`, when locating other work. Read a match before acting.

- For status or history, use `t3_thread_read` and report observed progress, result, failure, or pending human input. Keep reads bounded and follow cursors to retrieve the relevant response. A read-only question does not need a coding launch.
- For follow-ups, send to the same thread. Choose `mode: queue` for a new turn, or deliberate steering for a requested mid-run change. Use a stable `clientRequestId` per send and retain its returned `runId` when following that result.
- To stop work, interrupt the specified remote run with `t3_thread_interrupt`, verify its resulting state, and only then end local tracking. Ask when multiple active jobs could match. Do not confuse stopping an OpenTeam worker with stopping its remote coding run.
- When T3 needs permission, report that state and the returned thread link for approval in T3. Do not impersonate a human approval through a text response or widen execution modes.

Long-running observation belongs to OpenTeam's executor Task with saved progress and future checks; the main bot remains available. Read [the shared reference](../t3-code/references/orchestration.md) for pagination, retries, settled results, and cancellation semantics. Preserve the server-returned link in the result.
