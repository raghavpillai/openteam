/** Public routine owner represented by the API. */
export type RoutineOwnerKind = "bot" | "group";

export interface RoutineExecutionView {
  id: string;
  routineId: string;
  runId: string | null;
  kind: "scheduled" | "test";
  status:
    | "queued"
    | "running"
    | "waiting_approval"
    | "completed"
    | "failed"
    | "cancelled"
    | "skipped";
  scheduledFor: string;
  enqueuedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  skipReason: string | null;
  error: unknown;
  createdAt: string;
}

/** Portable API projection. Scheduling and persistence behavior remain server-side. */
export interface RoutineView {
  id: string;
  folder: string;
  ownerId: string;
  ownerKind: RoutineOwnerKind;
  botId: string | null;
  channelId: string | null;
  name: string;
  prompt: string;
  schedule: string;
  schedules: string[];
  scheduleKind: "cron" | "interval" | "event";
  cronExpression: string | null;
  intervalSeconds: number | null;
  timezone: string;
  timezoneMode: string;
  enabled: boolean;
  revision: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  latestExecution: RoutineExecutionView | null;
  trigger?: unknown;
  triggerPresentation: unknown;
}

export interface CreateRoutineInput {
  name: string;
  prompt: string;
  schedule?: string;
  trigger?: unknown;
  presentation?: unknown;
  enabled: boolean;
}

export interface UpdateRoutineInput {
  name?: string;
  prompt?: string;
  schedule?: string;
  trigger?: unknown;
  presentation?: unknown;
  enabled?: boolean;
  expectedRevision: number;
}
