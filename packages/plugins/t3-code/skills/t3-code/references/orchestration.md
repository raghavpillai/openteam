# T3 outside-client details

- Account identity matters. Carry the connection/environment, project, thread, run, returned link, launch/send retry key, and read cursor into every continuation. Do not retain credentials or one-time approval codes in task records.
- Discover schemas from the connected server. Older servers may omit capabilities. Unsupported outside-client operations should be explained rather than replaced with internal database or WebSocket calls.
- Retry launch/send with the same `clientRequestId` and payload in the same authorized session. A newly authorized session changes the request namespace: reconcile saved IDs before another launch. If a server has no launch retry key, inspect existing threads after an uncertain response rather than blindly retrying.
- `t3_thread_read` defaults to messages. Keep `limit` and `maxCharsPerItem` small. Use `afterPosition` / `nextPosition` for subsequent items and `itemId`, `textOffset`, `nextTextOffset` for truncated text. Use the activity view only when relevant.
- Pin a wait to the recorded `runId`. A timeout is not cancellation. A successful parent turn may still have delegated/background work; inspect the advertised settled-wait result before reporting the final answer. An outside OAuth client receives no automatic T3 parent wake-up; OpenTeam's existing Task continuation owns observation.
- Use `t3_thread_send` with `mode: queue` for a separate follow-up. `auto` can steer an active run. Use deliberate steering only for the user's change of scope. Save a new stable request key per send operation.
- For an explicit remote-stop request, use `t3_thread_interrupt` on the identified run and verify its state. Stopping an OpenTeam observer alone does not interrupt T3. A timeout, disconnect, account removal, or local Stop control is not evidence of remote cancellation.
- A read-only grant cannot start/send/interrupt. The approved T3 permission ceiling governs launches; do not widen modes to bypass approvals. Auto uses provider automatic review; providers can still ask for approval. Text replies to pending questions cannot approve commands or permissions.
- Preserve the real `link` in tool results. Outside clients normally receive a hosted HTTPS link. Do not construct guessed links from IDs. Direct the user there when T3 requires attention.
- T3's OAuth client session expires and may need reapproval; the inspected server does not issue refresh tokens. Use the host's plugin sign-in flow. Do not mint administrator tokens or copy T3's internal provider-session credential.

Sources: [outside agents](https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md), [permission modes](https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md).
