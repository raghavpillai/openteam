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

const userVisibleSummary = (result: string | null): string | null => {
  if (!result) return null;
  const tagged = result.match(
    /<user_visible_high_level_summary>\s*([\s\S]*?)\s*<\/user_visible_high_level_summary>/i
  )?.[1];
  return (tagged ?? result).trim() || null;
};

const userVisibleError = (error: unknown): string | null => {
  if (!error) return null;
  if (typeof error === "string") return error;
  if (typeof error === "object" && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return "The background task failed.";
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
  summary: userVisibleSummary(attempt.result),
  errorMessage: userVisibleError(attempt.error),
  startedAt: attempt.startedAt?.toISOString() ?? null,
  completedAt: attempt.completedAt?.toISOString() ?? null,
  stoppedAt: attempt.stoppedAt?.toISOString() ?? null,
  createdAt: attempt.createdAt.toISOString(),
  updatedAt: attempt.updatedAt.toISOString(),
});
