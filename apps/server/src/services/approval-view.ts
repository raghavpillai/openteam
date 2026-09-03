import type { ApprovalView } from "@openteam/contracts";

type StoredApproval = {
  id: string;
  runId: string;
  runItemId: string | null;
  kind: string;
  status: string;
  details: unknown;
  createdAt: Date;
};

type StoredRun = {
  id: string;
  conversationId: string;
};

type StoredAttempt = {
  parentRunId: string;
  parentToolCallId: string;
  childRunId: string | null;
  subagent: { id: string };
};

/**
 * Child runtimes emit approvals on their own run. GrokBot renders and resolves
 * those approvals through the parent conversation and preserves Task-attempt
 * lineage, so expose both identities rather than pretending the child run is
 * the owner.
 */
export const approvalViews = (
  approvals: readonly StoredApproval[],
  runs: readonly StoredRun[],
  attempts: readonly StoredAttempt[]
): ApprovalView[] => {
  const conversationByRunId = new Map(runs.map((run) => [run.id, run.conversationId]));
  const attemptByChildRunId = new Map(
    attempts.flatMap((attempt) =>
      attempt.childRunId ? ([[attempt.childRunId, attempt]] as const) : []
    )
  );

  return approvals.map((approval) => {
    const attempt = attemptByChildRunId.get(approval.runId);
    const parentRunId = attempt?.parentRunId ?? approval.runId;
    return {
      id: approval.id,
      runId: approval.runId,
      runItemId: approval.runItemId,
      kind: approval.kind,
      status: approval.status,
      details: approval.details,
      createdAt: approval.createdAt.toISOString(),
      ownerConversationId:
        conversationByRunId.get(parentRunId) ?? conversationByRunId.get(approval.runId) ?? "",
      parentRunId,
      parentToolCallId: attempt?.parentToolCallId ?? null,
      subagentId: attempt?.subagent.id ?? null,
    };
  });
};
