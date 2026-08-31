import type { Snapshot } from "@openbot/contracts";

type StoredAttempt = {
  id: string;
  parentRunId: string;
  parentChannelId: string;
  parentToolCallId: string;
  childRunId: string | null;
  description: string;
  runInBackground: boolean;
  status: string;
  result: string | null;
  error: unknown;
  startedAt: Date | null;
  completedAt: Date | null;
  stoppedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  subagent: {
    id: string;
    parentBotId: string;
    subagentType: string;
  };
};

export const subagentActivityView = (attempt: StoredAttempt): Snapshot["subagents"][number] => ({
  id: attempt.id,
  subagentId: attempt.subagent.id,
  parentBotId: attempt.subagent.parentBotId,
  parentRunId: attempt.parentRunId,
  parentChannelId: attempt.parentChannelId,
  parentToolCallId: attempt.parentToolCallId,
  currentRunId: attempt.childRunId,
  description: attempt.description,
  subagentType: attempt.subagent.subagentType as Snapshot["subagents"][number]["subagentType"],
  runInBackground: attempt.runInBackground,
  status: attempt.status as Snapshot["subagents"][number]["status"],
  // Completion text is a private parent wake. The renderer only needs durable
  // lineage for active-task rows and child approvals; do not project the
  // child's result or failure payload into the client snapshot.
  summary: null,
  errorMessage: null,
  startedAt: attempt.startedAt?.toISOString() ?? null,
  completedAt: attempt.completedAt?.toISOString() ?? null,
  stoppedAt: attempt.stoppedAt?.toISOString() ?? null,
  createdAt: attempt.createdAt.toISOString(),
  updatedAt: attempt.updatedAt.toISOString(),
});
