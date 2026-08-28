import type { SubagentActivityView } from "@openbot/contracts";

export const ACTIVE_ASYNC_TASK_STATUSES = new Set<SubagentActivityView["status"]>([
  "provisioning",
  "queued",
  "running",
]);

const taskTimestamp = (task: SubagentActivityView) =>
  new Date(task.updatedAt || task.createdAt).getTime();

/**
 * GrokBot's async-task overlay is keyed by the reusable child session, not by
 * the parent Task tool call. A resume therefore replaces the active row while
 * historical attempts remain available to the runtime.
 */
export const activeAsyncTasksForBot = (
  attempts: readonly SubagentActivityView[],
  parentBotId: string
): SubagentActivityView[] => {
  const bySubagentId = new Map<string, SubagentActivityView>();
  for (const attempt of attempts) {
    if (attempt.parentBotId !== parentBotId || !ACTIVE_ASYNC_TASK_STATUSES.has(attempt.status)) {
      continue;
    }
    const current = bySubagentId.get(attempt.subagentId);
    if (!current || taskTimestamp(attempt) >= taskTimestamp(current)) {
      bySubagentId.set(attempt.subagentId, attempt);
    }
  }
  return [...bySubagentId.values()].sort(
    (left, right) =>
      new Date(left.startedAt ?? left.createdAt).getTime() -
        new Date(right.startedAt ?? right.createdAt).getTime() || left.id.localeCompare(right.id)
  );
};

export const activeAsyncTaskChannelIds = (
  attempts: readonly SubagentActivityView[]
): ReadonlySet<string> =>
  new Set(
    attempts
      .filter((attempt) => ACTIVE_ASYNC_TASK_STATUSES.has(attempt.status))
      .map((attempt) => attempt.parentChannelId)
  );

export const asyncTaskElapsed = (task: SubagentActivityView, nowMs: number): string => {
  const startedAtMs = new Date(task.startedAt ?? task.createdAt).getTime();
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  if (elapsedSeconds < 3_600) return `${Math.floor(elapsedSeconds / 60)}m`;
  if (elapsedSeconds < 86_400) return `${Math.floor(elapsedSeconds / 3_600)}h`;
  return `${Math.floor(elapsedSeconds / 86_400)}d`;
};
