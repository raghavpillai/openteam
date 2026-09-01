import type { RunStatus } from "@openbot/contracts";
import type { RoutineExecutionView } from "@openbot/contracts/routine-types";

export type ActiveRunStatus = Extract<RunStatus, "queued" | "running" | "waiting_approval">;
export type TransientRoutineExecutionStatus = Extract<
  RoutineExecutionView["status"],
  ActiveRunStatus
>;

export const ACTIVE_RUN_STATUSES: ReadonlySet<ActiveRunStatus> = new Set([
  "queued",
  "running",
  "waiting_approval",
]);

export const isActiveRunStatus = (status: string): status is ActiveRunStatus =>
  ACTIVE_RUN_STATUSES.has(status as ActiveRunStatus);

export const isTransientRoutineExecutionStatus = (
  status: string
): status is TransientRoutineExecutionStatus => isActiveRunStatus(status);

export const hasTransientRoutineExecution = (
  executions: readonly Pick<RoutineExecutionView, "status">[]
): boolean => executions.some((execution) => isTransientRoutineExecutionStatus(execution.status));
