---
name: t3-code
description: Implement features, fix bugs, test, or research code through a connected T3 Code environment and follow the result.
---

Use the connected T3 MCP account through GetDynamicTools and CallDynamicTool. This skill coordinates agents running in T3; OpenTeam's filesystem and provider credentials are separate. Honor a user-selected local coding workflow instead of silently moving it to T3.

The main bot gives its existing executor Task the user's goal, chosen environment/project/model, constraints, authorization, and expected output. The executor owns the result while the main conversation stays available. Account instructions are not automatically injected into workers: pass relevant preferences explicitly.

1. Resolve the correct account with `t3_environment_read`, `t3_project_list`, and `t3_project_read`. Use `orchestrator_capabilities` to discover live provider/model choices; honor an explicit choice and otherwise use project defaults. Ask only when the destination is materially ambiguous. A repository must already exist on the T3 host.
2. Save the intended launch and a stable `clientRequestId` in task progress before sending it. Start a normal thread with `t3_thread_launch`, explicit `projectId`, the full task brief, and an explicit workspace strategy. Independent code changes use a worktree from the actual remote default branch with `startFromOrigin: true`; dependent unpublished changes use their local base with `startFromOrigin: false`. Uncommitted OpenTeam files are not copied there.
3. Immediately record the returned account/environment, `threadId`, `runId`, `link`, and retry key in task evidence. A launch receipt is not completion. Report meaningful milestones through the existing OpenTeam task-progress mechanism.
4. Follow the exact run using bounded `t3_thread_wait` and incremental `t3_thread_read`. When advertised, wait with `untilDelegatedWorkSettled: true` and use `resultRun` to locate the final answer. For long external waits, save `state: waiting`, the remote identifiers, unfinished obligations, `nextAction`, and a future `checkAt` through ReportTaskProgress. OpenTeam resumes that same task; do not launch again on continuation.
5. If T3 needs human approval, report the observed waiting state and its real thread link. Approval happens in T3. If a host is offline or sign-in is required, retain the reference and report that condition; do not claim the remote run failed or stopped.
6. Read the settled response and verify the requested outcome. Return changed behavior, tests actually run, unresolved issues, and the server-returned thread link verbatim. Include a PR only when requested/authorized. Clear remaining task obligations after the result is verified so OpenTeam can deliver completion to the originating chat.

Use outside-client tools, not `delegate_task`, `task_status`, `task_cancel`, or `create_threads`, which require an internal T3 parent session. T3's agent may do its own delegation. For recovery, text pagination, and follow-ups, read [the shared reference](references/orchestration.md).
