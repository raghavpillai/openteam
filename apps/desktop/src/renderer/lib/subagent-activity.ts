import type { ApprovalView, RunView, SubagentActivityView } from "@openbot/contracts";

export const conversationApprovals = (
  runs: RunView[],
  subagents: SubagentActivityView[],
  approvalsByRun: ReadonlyMap<string, ApprovalView[]>
): ApprovalView[] => {
  const runIds = [
    ...runs.map((run) => run.id),
    ...subagents.flatMap((subagent) => (subagent.currentRunId ? [subagent.currentRunId] : [])),
  ];
  const seen = new Set<string>();
  return runIds
    .flatMap((runId) =>
      (approvalsByRun.get(runId) ?? []).filter((approval) => {
        if (seen.has(approval.id)) return false;
        seen.add(approval.id);
        return true;
      })
    )
    .sort(
      (left, right) =>
        new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() ||
        left.id.localeCompare(right.id)
    );
};
