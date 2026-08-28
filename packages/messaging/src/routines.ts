import { ApiError } from "@openbot/contracts";
import { Prisma, type PrismaClient } from "@openbot/db";
import { CronExpressionParser } from "cron-parser";
import { cronSchedules, firstCronSchedule, parseStoredTrigger } from "./automation-trigger";
import { uniqueSlug } from "./file-state";

const MIN_INTERVAL_SECONDS = 5 * 60;
const MAX_INTERVAL_SECONDS = 30 * 24 * 60 * 60;
const MAX_ROUTINES_PER_BOT = 50;

export interface RoutineMutationInput {
  action: "create" | "update" | "pause" | "resume" | "delete";
  id?: string;
  name?: string;
  prompt?: string;
  schedule?: string;
  trigger?: unknown;
  presentation?: unknown;
  enabled?: boolean;
  expectedRevision?: number;
  source?: "agent" | "ui";
}

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

export interface RoutineView {
  id: string;
  folder: string;
  botId: string;
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
  triggerPresentation: unknown;
}

export interface NormalizedSchedule {
  scheduleText: string;
  scheduleKind: "cron" | "interval";
  cronExpression: string | null;
  intervalSeconds: number | null;
  timezoneMode: "installation" | "pinned";
  timezone: string;
}

interface RoutineFileStore {
  listRoutineFolderIds?(botId: string): Promise<string[]>;
  writeRoutine(botId: string, id: string, tx?: Prisma.TransactionClient): Promise<void>;
  deleteRoutine(botId: string, id: string, tx?: Prisma.TransactionClient): Promise<void>;
}

type StoredSchedule =
  | NormalizedSchedule
  | {
      scheduleText: string;
      scheduleKind: "event";
      cronExpression: null;
      intervalSeconds: null;
      timezoneMode: "installation";
      timezone: string;
    };

interface RoutineWakeHost {
  defaultTimeZone: string;
  enqueueWake(
    tx: Prisma.TransactionClient,
    input: {
      botId: string;
      channelId: string;
      origin: "routine";
      type: string;
      content: string;
      clientId: string;
      priority: number;
      availableAt?: Date;
      occurredAt?: Date;
      timeZone?: string | null;
      automationTrigger?: string;
    }
  ): Promise<{ run: { id: string } }>;
}

const required = (value: string | undefined, field: string): string => {
  const text = value?.trim();
  if (!text) throw new Error(`${field} is required for this routine action`);
  return text;
};

const jsonInput = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const routineIdentifierWhere = (id: string) =>
  UUID_PATTERN.test(id) ? { OR: [{ id }, { slug: id }] } : { slug: id };

export interface RoutineRunLedgerEntry {
  id: string;
  trigger: "schedule" | "manual" | "event";
  startedAt: number;
  finishedAt?: number | null;
  status: "ok" | "error" | "running";
  [key: string]: unknown;
}

const humanSchedule = (schedule: string): string => {
  const normalized = schedule.replace(/^(?:CRON_TZ|TZ)=[^\s]+\s+/, "").trim();
  if (normalized === "0 * * * *") return "Every hour";
  if (normalized === "0 0 * * *") return "Every day at 12:00 AM";
  const weekdays = normalized.match(/^(\d+) (\d+) \* \* 1-5$/);
  if (weekdays) {
    const date = new Date(2026, 0, 1, Number(weekdays[2]), Number(weekdays[1]));
    return `Weekdays at ${date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
  }
  const interval = normalized.match(/^@every\s+(.+)$/i);
  return interval ? `Every ${interval[1]}` : `Cron ${normalized}`;
};

const routineWakeContent = (input: {
  name: string;
  folder?: string;
  schedule?: string;
  firedAt: Date;
  prompt: string;
  provenance?: string;
  kind: "scheduled" | "manual";
  routineStatuses?: ReadonlyArray<{ name: string; folder: string; status: string }>;
}): string => {
  const trusted = input.provenance === "user" ? "[SAND_TRUSTED_AUTOMATION_PROMPT]" : "";
  const schedule = input.schedule ?? "scheduled routine";
  const folder = input.folder ?? input.name;
  const routineStatuses = input.routineStatuses ?? [];
  const reminder = routineStatuses.length
    ? [
        "<system_reminder>",
        "<automation_status>",
        "Current routine runtime status. This snapshot is authoritative for this turn and supersedes earlier routine status reminders.",
        ...routineStatuses.map(
          (routine) => `- ${routine.name} (folder ${routine.folder}): ${routine.status}`
        ),
        "</automation_status>",
        "</system_reminder>",
        "",
      ]
    : [];
  return [
    `[SAND_HIDDEN_PROMPT]${trusted}`,
    ...reminder,
    input.kind === "manual"
      ? `[routine] ${JSON.stringify(input.name)} (folder ${folder}) was run on demand — ${humanSchedule(schedule)} (${schedule}), fired ${input.firedAt.toISOString()}.`
      : `[routine] ${JSON.stringify(input.name)} (folder ${folder}) is due — ${humanSchedule(schedule)} (${schedule}), fired ${input.firedAt.toISOString()}.`,
    input.kind === "manual"
      ? "The user pressed Run now on this routine in the app."
      : "This is your own routine firing on schedule, not a message the user just typed.",
    "",
    input.prompt,
    "",
    "Use current sources; report missing or stale inputs instead of inventing data.",
    "Use SendToUser to deliver a meaningful result or a failure that needs attention. Finishing silently is valid when the saved instruction says there is nothing to report.",
  ]
    .filter((line, index) => line || index > 0)
    .join("\n");
};

export const scheduledRoutineWakeContent = (input: {
  name: string;
  folder?: string;
  schedule?: string;
  scheduledFor: Date;
  prompt: string;
  provenance?: string;
  routineStatuses?: ReadonlyArray<{ name: string; folder: string; status: string }>;
}): string =>
  routineWakeContent({
    ...input,
    firedAt: input.scheduledFor,
    kind: "scheduled",
  });

export const manualRoutineWakeContent = (input: {
  name: string;
  folder: string;
  schedule: string;
  firedAt: Date;
  prompt: string;
  provenance: string;
  routineStatuses?: ReadonlyArray<{ name: string; folder: string; status: string }>;
}): string => routineWakeContent({ ...input, kind: "manual" });

export const scheduledRoutineTriggerContext = (input: {
  name: string;
  scheduledFor: Date;
}): string =>
  [
    "<automation_trigger_info>",
    `[OpenBot routine: ${input.name}]`,
    `Scheduled occurrence: ${input.scheduledFor.toISOString()}`,
    "</automation_trigger_info>",
  ].join("\n");

export const appendRoutineRunLedger = (
  current: unknown,
  entry: RoutineRunLedgerEntry
): Prisma.InputJsonValue => {
  const ledger = Array.isArray(current)
    ? current.filter(
        (candidate): candidate is Record<string, unknown> =>
          Boolean(candidate) &&
          typeof candidate === "object" &&
          !Array.isArray(candidate) &&
          (candidate as { id?: unknown }).id !== entry.id
      )
    : [];
  return jsonInput(
    [...ledger, entry]
      .sort((left, right) => Number(right.startedAt ?? 0) - Number(left.startedAt ?? 0))
      .slice(0, 20)
  );
};

const validZone = (zone: string): string => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date());
    return zone;
  } catch {
    throw new Error(`Invalid IANA time zone: ${zone}`);
  }
};

const aliases: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

const durationMilliseconds = (value: string): number | null => {
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/gi;
  let consumed = "";
  let total = 0;
  for (const match of value.matchAll(pattern)) {
    consumed += match[0];
    const amount = Number(match[1]);
    const unit = match[2]?.toLowerCase();
    const multiplier =
      unit === "ms"
        ? 1
        : unit === "s"
          ? 1_000
          : unit === "m"
            ? 60_000
            : unit === "h"
              ? 3_600_000
              : 86_400_000;
    total += amount * multiplier;
  }
  return consumed.toLowerCase() === value.toLowerCase() && total > 0 ? total : null;
};

export const normalizeRoutineSchedule = (
  original: string,
  installationZone: string,
  options: { enforceMinimum?: boolean } = {}
): NormalizedSchedule => {
  const scheduleText = original.trim();
  const interval = scheduleText.match(/^@every\s+([^/\s]+)(?:\/([^/\s]+))?$/i);
  if (interval?.[1]) {
    const intervalMs = durationMilliseconds(interval[1]);
    const phaseMs = interval[2] ? durationMilliseconds(interval[2]) : 0;
    const minimumMs = options.enforceMinimum === false ? 1_000 : MIN_INTERVAL_SECONDS * 1_000;
    if (
      intervalMs === null ||
      phaseMs === null ||
      phaseMs >= intervalMs ||
      intervalMs < minimumMs ||
      intervalMs > MAX_INTERVAL_SECONDS * 1_000
    ) {
      throw new Error(
        `Routine intervals must be between ${minimumMs === 1_000 ? "1 second" : "5 minutes"} and 30 days and use a phase shorter than the interval`
      );
    }
    const intervalSeconds = Math.ceil(intervalMs / 1_000);
    return {
      scheduleText,
      scheduleKind: "interval",
      cronExpression: null,
      intervalSeconds,
      timezoneMode: "installation",
      timezone: validZone(installationZone),
    };
  }

  const zoneMatch = scheduleText.match(/^(?:CRON_TZ|TZ)=([^\s]+)\s+(.+)$/);
  const timezone = validZone(zoneMatch?.[1] ?? installationZone);
  const rawExpression = zoneMatch?.[2] ?? scheduleText;
  const cronExpression = aliases[rawExpression.toLowerCase()] ?? rawExpression;
  if (cronExpression.trim().split(/\s+/).length !== 5) {
    throw new Error("Routine cron schedules must contain exactly five fields");
  }
  const parser = CronExpressionParser.parse(cronExpression, {
    currentDate: new Date(),
    tz: timezone,
  });
  const occurrences = parser.take(8).map((date) => date.toDate().getTime());
  if (
    options.enforceMinimum !== false &&
    occurrences.some((time, index) => {
      const previous = occurrences[index - 1];
      return previous !== undefined && time - previous < MIN_INTERVAL_SECONDS * 1_000;
    })
  ) {
    throw new Error("Routine cron schedules may not run more often than every 5 minutes");
  }
  return {
    scheduleText,
    scheduleKind: "cron",
    cronExpression,
    intervalSeconds: null,
    timezoneMode: zoneMatch ? "pinned" : "installation",
    timezone,
  };
};

const normalizeMutationTrigger = (
  input: { schedule?: string; trigger?: unknown },
  installationZone: string
): { trigger: Record<string, unknown>; schedule: StoredSchedule } => {
  const trigger = input.trigger
    ? parseStoredTrigger(input.trigger)
    : { type: "cron", schedule: required(input.schedule, "schedule") };
  if (input.schedule !== undefined) {
    trigger.type = "cron";
    trigger.schedule = required(input.schedule, "schedule");
  }
  const cronSchedule = firstCronSchedule(trigger);
  if (cronSchedule !== null) {
    const enforceMinimum = process.env.OPENBOT_ENFORCE_AUTOMATION_MINIMUM === "true";
    const normalizedSchedules = cronSchedules(trigger).map((candidate) =>
      normalizeRoutineSchedule(required(candidate, "trigger.schedule"), installationZone, {
        enforceMinimum,
      })
    );
    const schedule =
      normalizedSchedules[0] ??
      normalizeRoutineSchedule(required(cronSchedule, "trigger.schedule"), installationZone, {
        enforceMinimum,
      });
    const normalizedTrigger =
      trigger.type === "cron"
        ? { ...trigger, schedule: schedule.scheduleText }
        : {
            ...trigger,
            listeners: Array.isArray(trigger.listeners)
              ? trigger.listeners.map((listener) => {
                  if (!listener || typeof listener !== "object" || Array.isArray(listener)) {
                    return listener;
                  }
                  const item = listener as Record<string, unknown>;
                  if (item.type !== "cron" || typeof item.schedule !== "string") return item;
                  const normalized = normalizedSchedules.shift();
                  return { ...item, schedule: normalized?.scheduleText ?? item.schedule };
                })
              : trigger.listeners,
          };
    return {
      trigger: normalizedTrigger,
      schedule,
    };
  }
  return {
    trigger,
    schedule: {
      scheduleText: JSON.stringify(trigger),
      scheduleKind: "event",
      cronExpression: null,
      intervalSeconds: null,
      timezoneMode: "installation",
      timezone: validZone(installationZone),
    },
  };
};

export const nextRoutineRun = (
  schedule: {
    scheduleKind: "cron" | "interval" | "event";
    scheduleText?: string;
    cronExpression: string | null;
    intervalSeconds: number | null;
    timezone: string;
  },
  after: Date
): Date => {
  if (schedule.scheduleKind === "event") {
    throw new Error("Event routines do not have a scheduled next run");
  }
  if (schedule.scheduleKind === "interval") {
    const every = schedule.scheduleText?.match(/^@every\s+([^/\s]+)(?:\/([^/\s]+))?$/i);
    const exactInterval = every?.[1] ? durationMilliseconds(every[1]) : null;
    const intervalMs = exactInterval ?? (schedule.intervalSeconds ?? 0) * 1_000;
    const phaseMs = every?.[2] ? durationMilliseconds(every[2]) : 0;
    if (phaseMs && phaseMs < intervalMs) {
      return new Date(
        Math.floor((after.getTime() - phaseMs) / intervalMs + 1) * intervalMs + phaseMs
      );
    }
    return new Date(after.getTime() + intervalMs);
  }
  return CronExpressionParser.parse(
    required(schedule.cronExpression ?? undefined, "cronExpression"),
    {
      currentDate: after,
      tz: schedule.timezone,
    }
  )
    .next()
    .toDate();
};

export const nextRoutineTriggerRun = (
  trigger: Record<string, unknown>,
  fallback: {
    scheduleKind: "cron" | "interval" | "event";
    scheduleText?: string;
    cronExpression: string | null;
    intervalSeconds: number | null;
    timezone: string;
  },
  after: Date,
  installationZone = fallback.timezone
): Date => {
  const schedules = cronSchedules(trigger);
  if (schedules.length === 0) return nextRoutineRun(fallback, after);
  const nextRuns = schedules.map((schedule) =>
    nextRoutineRun(
      normalizeRoutineSchedule(schedule, installationZone, { enforceMinimum: false }),
      after
    )
  );
  return new Date(Math.min(...nextRuns.map((next) => next.getTime())));
};

const view = (routine: {
  id: string;
  slug: string;
  name: string;
  prompt: string;
  scheduleText: string;
  scheduleKind: string;
  cronExpression: string | null;
  intervalSeconds: number | null;
  timezone: string;
  timezoneMode: string;
  enabled: boolean;
  revision: number;
  nextRunAt: Date | null;
  trigger: unknown;
  provenance: string;
  lastRunAt: Date | null;
}) => ({
  target: "routine",
  id: routine.id,
  folder: routine.slug,
  name: routine.name,
  prompt: routine.prompt,
  schedule: routine.scheduleText,
  schedule_kind: routine.scheduleKind,
  cron_expression: routine.cronExpression,
  interval_seconds: routine.intervalSeconds,
  timezone: routine.timezone,
  timezone_mode: routine.timezoneMode,
  enabled: routine.enabled,
  revision: routine.revision,
  next_run_at: routine.nextRunAt?.toISOString() ?? null,
  last_run_at: routine.lastRunAt?.toISOString() ?? null,
  trigger: routine.trigger,
  provenance: routine.provenance,
});

const executionView = (execution: {
  id: string;
  routineId: string;
  runId: string | null;
  kind: string;
  status: string;
  scheduledFor: Date;
  enqueuedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  skipReason: string | null;
  error: unknown;
  createdAt: Date;
}): RoutineExecutionView => ({
  id: execution.id,
  routineId: execution.routineId,
  runId: execution.runId,
  kind: execution.kind as RoutineExecutionView["kind"],
  status: execution.status as RoutineExecutionView["status"],
  scheduledFor: execution.scheduledFor.toISOString(),
  enqueuedAt: execution.enqueuedAt?.toISOString() ?? null,
  startedAt: execution.startedAt?.toISOString() ?? null,
  completedAt: execution.completedAt?.toISOString() ?? null,
  skipReason: execution.skipReason,
  error: execution.error,
  createdAt: execution.createdAt.toISOString(),
});

const uiView = (routine: {
  id: string;
  slug: string;
  botId: string;
  name: string;
  prompt: string;
  scheduleText: string;
  scheduleKind: string;
  cronExpression: string | null;
  intervalSeconds: number | null;
  timezone: string;
  timezoneMode: string;
  enabled: boolean;
  revision: number;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  trigger: unknown;
  triggerPresentation: unknown;
  executions?: Array<Parameters<typeof executionView>[0]>;
}): RoutineView => ({
  id: routine.id,
  folder: routine.slug,
  botId: routine.botId,
  name: routine.name,
  prompt: routine.prompt,
  schedule: routine.scheduleText,
  schedules: cronSchedules(routine.trigger as Record<string, unknown>),
  scheduleKind: routine.scheduleKind as RoutineView["scheduleKind"],
  cronExpression: routine.cronExpression,
  intervalSeconds: routine.intervalSeconds,
  timezone: routine.timezone,
  timezoneMode: routine.timezoneMode,
  enabled: routine.enabled,
  revision: routine.revision,
  nextRunAt: routine.nextRunAt?.toISOString() ?? null,
  lastRunAt: routine.lastRunAt?.toISOString() ?? null,
  createdAt: routine.createdAt.toISOString(),
  updatedAt: routine.updatedAt.toISOString(),
  latestExecution: routine.executions?.[0] ? executionView(routine.executions[0]) : null,
  triggerPresentation: routine.triggerPresentation,
});

const routineRuntimeStatus = (
  routine: { runLedger: unknown; lastRunAt: Date | null },
  timeZone: string
): string => {
  const ledger = Array.isArray(routine.runLedger)
    ? routine.runLedger.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
      )
    : [];
  const latest = ledger
    .slice()
    .sort((left, right) => Number(right.startedAt ?? 0) - Number(left.startedAt ?? 0))[0];
  const lastRun = latest?.finishedAt ?? latest?.startedAt ?? routine.lastRunAt;
  if (!lastRun) return "never run";
  const at = lastRun instanceof Date ? lastRun : new Date(Number(lastRun));
  if (!Number.isFinite(at.getTime())) return "last run status unknown";
  const outcome =
    latest?.status === "ok"
      ? "succeeded"
      : latest?.status === "error"
        ? "failed"
        : latest?.status === "running"
          ? "running"
          : "unknown";
  const rendered = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(at);
  return `last run ${rendered} (${outcome})`;
};

const routineStatusSnapshot = async (
  tx: Prisma.TransactionClient,
  botId: string,
  timeZone: string
): Promise<Array<{ name: string; folder: string; status: string }>> => {
  const conversation = await tx.conversation.findUnique({
    where: { botId },
    select: { id: true },
  });
  if (conversation) {
    const latestCompaction = await tx.contextCompaction.findFirst({
      where: {
        status: "adopted",
        completedAt: { not: null },
        contextSession: { botId, scope: "home", scopeId: conversation.id },
      },
      orderBy: { completedAt: "desc" },
      select: { completedAt: true },
    });
    const alreadyDelivered = await tx.message.findFirst({
      where: {
        conversationId: conversation.id,
        ...(latestCompaction?.completedAt
          ? { createdAt: { gt: latestCompaction.completedAt } }
          : {}),
        content: { contains: "<automation_status>" },
      },
      select: { id: true },
    });
    if (alreadyDelivered) return [];
  }
  return (
    await tx.routine.findMany({
      where: { botId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: { name: true, slug: true, runLedger: true, lastRunAt: true },
    })
  ).map((routine) => ({
    name: routine.name,
    folder: routine.slug,
    status: routineRuntimeStatus(routine, timeZone),
  }));
};

export class RoutineService {
  readonly installationZone: string;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly host: RoutineWakeHost,
    private readonly files?: RoutineFileStore,
    installationZone = process.env.OPENBOT_TIME_ZONE ?? "UTC"
  ) {
    this.installationZone = validZone(installationZone);
  }

  async mutate(
    botId: string,
    callId: string,
    runId: string | null,
    input: RoutineMutationInput
  ): Promise<Record<string, unknown>> {
    switch (input.action) {
      case "create":
        return this.create(botId, callId, runId, input);
      case "update":
        return this.update(botId, callId, runId, input);
      case "pause":
      case "resume":
      case "delete":
        return this.lifecycle(botId, callId, runId, input);
    }
  }

  async list(botId: string): Promise<RoutineView[]> {
    const routines = await this.prisma.routine.findMany({
      where: { botId, deletedAt: null },
      include: { executions: { orderBy: { createdAt: "desc" }, take: 1 } },
      orderBy: [{ nextRunAt: "asc" }, { createdAt: "asc" }],
    });
    return routines.map(uiView);
  }

  async ownerId(id: string): Promise<string> {
    const routine = await this.prisma.routine.findFirst({
      where: { deletedAt: null, ...routineIdentifierWhere(id) },
      select: { botId: true },
    });
    if (!routine) throw new ApiError(404, "routine_not_found", "Routine not found");
    return routine.botId;
  }

  async detail(botId: string, id: string): Promise<RoutineView> {
    const routine = await this.prisma.routine.findFirst({
      where: { botId, deletedAt: null, ...routineIdentifierWhere(id) },
      include: { executions: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    if (!routine) throw new ApiError(404, "routine_not_found", "Routine not found");
    return uiView(routine);
  }

  async executions(botId: string, id: string, limit = 20): Promise<RoutineExecutionView[]> {
    const routine = await this.prisma.routine.findFirst({
      where: { botId, deletedAt: null, ...routineIdentifierWhere(id) },
      select: { id: true },
    });
    if (!routine) throw new ApiError(404, "routine_not_found", "Routine not found");
    return (
      await this.prisma.routineExecution.findMany({
        where: { routineId: routine.id },
        orderBy: { createdAt: "desc" },
        take: Math.max(1, Math.min(20, limit)),
      })
    ).map(executionView);
  }

  async runNow(
    botId: string,
    id: string,
    requestId: string,
    firedAt = new Date()
  ): Promise<RoutineExecutionView> {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`routine-run:${botId}:${id}`}))`;
      const routine = await tx.routine.findFirst({
        where: { botId, deletedAt: null, ...routineIdentifierWhere(id) },
      });
      if (!routine) throw new ApiError(404, "routine_not_found", "Routine not found");
      const duplicate = await tx.routineExecution.findUnique({
        where: { dedupeKey: `routine:${routine.id}:manual:${requestId}` },
      });
      if (duplicate) return duplicate;
      const active = await tx.routineExecution.count({
        where: {
          routineId: routine.id,
          status: { in: ["queued", "running", "waiting_approval"] },
        },
      });
      if (active > 0) {
        throw new ApiError(409, "routine_already_running", "This routine is already running");
      }
      const channel = await tx.channel.findUnique({
        where: { directKey: `bot:${routine.botId}` },
      });
      if (!channel || channel.archivedAt) {
        throw new ApiError(409, "routine_channel_unavailable", "The Bot chat is unavailable");
      }
      const revision = await tx.routineRevision.findUniqueOrThrow({
        where: {
          routineId_revision: { routineId: routine.id, revision: routine.revision },
        },
      });
      const dedupeKey = `routine:${routine.id}:manual:${requestId}`;
      const execution = await tx.routineExecution.create({
        data: {
          routineId: routine.id,
          routineRevisionId: revision.id,
          kind: "test",
          status: "queued",
          dedupeKey,
          scheduledFor: firedAt,
          enqueuedAt: firedAt,
        },
      });
      const wake = await this.host.enqueueWake(tx, {
        botId: routine.botId,
        channelId: channel.id,
        origin: "routine",
        type: "routine.manual",
        content: manualRoutineWakeContent({
          name: routine.name,
          folder: routine.slug,
          schedule: routine.scheduleText,
          firedAt,
          prompt: routine.prompt,
          provenance: routine.provenance,
          routineStatuses: await routineStatusSnapshot(tx, routine.botId, routine.timezone),
        }),
        automationTrigger: scheduledRoutineTriggerContext({
          name: routine.name,
          scheduledFor: firedAt,
        }),
        clientId: dedupeKey,
        priority: 290,
        occurredAt: firedAt,
        timeZone: routine.timezone,
      });
      const queued = await tx.routineExecution.update({
        where: { id: execution.id },
        data: { runId: wake.run.id },
      });
      await tx.routine.update({
        where: { id: routine.id },
        data: {
          lastRunAt: firedAt,
          runLedger: appendRoutineRunLedger(routine.runLedger, {
            id: execution.id,
            trigger: "manual",
            startedAt: firedAt.getTime(),
            finishedAt: null,
            status: "running",
          }),
        },
      });
      await tx.event.create({
        data: {
          topic: "routine.execution.queued",
          entityId: execution.id,
          payload: {
            executionId: execution.id,
            routineId: routine.id,
            runId: wake.run.id,
            kind: "test",
          },
        },
      });
      return queued;
    });
    await this.files?.writeRoutine(botId, result.routineId);
    return executionView(result);
  }

  private async create(
    botId: string,
    callId: string,
    runId: string | null,
    input: RoutineMutationInput
  ) {
    const name = required(input.name, "name").replace(/\s+/g, " ").slice(0, 80);
    const prompt = required(input.prompt, "prompt");
    const { schedule, trigger } = normalizeMutationTrigger(input, this.installationZone);
    const enabled = input.enabled ?? true;
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent-files:${botId}`}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`routine-bot:${botId}`}))`;
      if ((await tx.bot.count({ where: { id: botId, status: "active" } })) === 0) {
        throw new Error("Cannot create a routine for an inactive bot");
      }
      const count = await tx.routine.count({
        where: { botId, deletedAt: null },
      });
      if (count >= MAX_ROUTINES_PER_BOT) throw new Error("A bot may have at most 50 routines");
      const occupied = new Set(
        (
          await tx.routine.findMany({
            where: { botId },
            select: { slug: true },
          })
        ).map((routine) => routine.slug)
      );
      const fileSlugs = new Set((await this.files?.listRoutineFolderIds?.(botId)) ?? []);
      for (const slug of fileSlugs) occupied.add(slug);
      const slug = uniqueSlug(name, "automation", occupied);
      const now = new Date();
      const routine = await tx.routine.create({
        data: {
          botId,
          slug,
          name,
          prompt,
          trigger: jsonInput(trigger),
          triggerPresentation: jsonInput(input.presentation ?? { version: 1, trigger }),
          provenance: input.source === "ui" ? "user" : "untrusted",
          ...schedule,
          enabled,
          nextRunAt:
            enabled && schedule.scheduleKind !== "event"
              ? nextRoutineTriggerRun(trigger, schedule, now, this.installationZone)
              : null,
          pausedAt: enabled ? null : now,
        },
      });
      await tx.routineRevision.create({
        data: {
          routineId: routine.id,
          revision: routine.revision,
          name,
          prompt,
          ...schedule,
          enabled,
          source: input.source ?? "agent",
          callId,
          runId,
        },
      });
      await tx.event.create({
        data: {
          topic: "routine.created",
          entityId: routine.id,
          payload: { routineId: routine.id, botId, revision: 1 },
        },
      });
      await this.files?.writeRoutine(botId, routine.id, tx);
      return { ...view(routine), action: "create", created: true };
    });
  }

  private async update(
    botId: string,
    callId: string,
    runId: string | null,
    input: RoutineMutationInput
  ) {
    const id = required(input.id, "id");
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent-files:${botId}`}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`routine-bot:${botId}`}))`;
      if ((await tx.bot.count({ where: { id: botId, status: "active" } })) === 0) {
        throw new Error("Cannot update a routine for an inactive bot");
      }
      const current = await tx.routine.findFirst({
        where: { botId, deletedAt: null, ...routineIdentifierWhere(id) },
      });
      if (!current) throw new Error("Routine not found");
      if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
        throw new ApiError(
          409,
          "routine_revision_conflict",
          "This routine changed somewhere else. Reload it and try again."
        );
      }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`routine:${current.id}`}))`;
      const normalized =
        input.schedule !== undefined || input.trigger !== undefined
          ? normalizeMutationTrigger(input, this.installationZone)
          : {
              trigger: current.trigger as Record<string, unknown>,
              schedule: {
                scheduleText: current.scheduleText,
                scheduleKind: current.scheduleKind,
                cronExpression: current.cronExpression,
                intervalSeconds: current.intervalSeconds,
                timezoneMode: current.timezoneMode as "installation" | "pinned",
                timezone: current.timezone,
              } as StoredSchedule,
            };
      const { schedule, trigger } = normalized;
      const name =
        input.name === undefined
          ? current.name
          : required(input.name, "name").replace(/\s+/g, " ").slice(0, 80);
      const prompt = input.prompt === undefined ? current.prompt : required(input.prompt, "prompt");
      const enabled = input.enabled ?? current.enabled;
      const revision = current.revision + 1;
      const now = new Date();
      const routine = await tx.routine.update({
        where: { id: current.id },
        data: {
          name,
          prompt,
          trigger: jsonInput(trigger),
          triggerPresentation:
            input.presentation !== undefined
              ? jsonInput(input.presentation)
              : current.triggerPresentation
                ? jsonInput({ version: 1, trigger })
                : Prisma.JsonNull,
          ...schedule,
          enabled,
          provenance: input.source === "ui" ? "user" : current.provenance,
          revision,
          nextRunAt:
            enabled && schedule.scheduleKind !== "event"
              ? nextRoutineTriggerRun(trigger, schedule, now, this.installationZone)
              : null,
          pausedAt: enabled ? null : (current.pausedAt ?? now),
        },
      });
      await tx.routineRevision.create({
        data: {
          routineId: current.id,
          revision,
          name,
          prompt,
          ...schedule,
          enabled,
          source: input.source ?? "agent",
          callId,
          runId,
        },
      });
      await tx.event.create({
        data: {
          topic: "routine.updated",
          entityId: current.id,
          payload: { routineId: current.id, botId, revision },
        },
      });
      await this.files?.writeRoutine(botId, routine.id, tx);
      return { ...view(routine), action: "update", updated: true };
    });
  }

  private async lifecycle(
    botId: string,
    callId: string,
    runId: string | null,
    input: RoutineMutationInput
  ) {
    const id = required(input.id, "id");
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent-files:${botId}`}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`routine-bot:${botId}`}))`;
      if ((await tx.bot.count({ where: { id: botId, status: "active" } })) === 0) {
        throw new Error("Cannot change a routine for an inactive bot");
      }
      const current = await tx.routine.findFirst({
        where: { botId, deletedAt: null, ...routineIdentifierWhere(id) },
      });
      if (!current) throw new Error("Routine not found");
      if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
        throw new ApiError(
          409,
          "routine_revision_conflict",
          "This routine changed somewhere else. Reload it and try again."
        );
      }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`routine:${current.id}`}))`;
      const now = new Date();
      const enabled = input.action === "resume";
      const deleted = input.action === "delete";
      const schedule = {
        scheduleText: current.scheduleText,
        scheduleKind: current.scheduleKind,
        cronExpression: current.cronExpression,
        intervalSeconds: current.intervalSeconds,
        timezone: current.timezone,
      };
      const revision = current.revision + 1;
      const routine = await tx.routine.update({
        where: { id: current.id },
        data: {
          enabled: deleted ? false : enabled,
          revision,
          nextRunAt:
            enabled && schedule.scheduleKind !== "event"
              ? nextRoutineTriggerRun(
                  current.trigger as Record<string, unknown>,
                  schedule,
                  now,
                  this.installationZone
                )
              : null,
          pausedAt: enabled ? null : now,
          deletedAt: deleted ? now : null,
        },
      });
      await tx.routineRevision.create({
        data: {
          routineId: current.id,
          revision,
          name: current.name,
          prompt: current.prompt,
          scheduleText: current.scheduleText,
          scheduleKind: current.scheduleKind,
          cronExpression: current.cronExpression,
          intervalSeconds: current.intervalSeconds,
          timezoneMode: current.timezoneMode,
          timezone: current.timezone,
          enabled: routine.enabled,
          source: input.source ?? "agent",
          callId,
          runId,
        },
      });
      await tx.event.create({
        data: {
          topic: `routine.${input.action}d`,
          entityId: current.id,
          payload: { routineId: current.id, botId, revision },
        },
      });
      if (deleted) await this.files?.deleteRoutine(botId, routine.id, tx);
      else await this.files?.writeRoutine(botId, routine.id, tx);
      return {
        ...view(routine),
        action: input.action,
        paused: input.action === "pause",
        resumed: input.action === "resume",
        deleted,
      };
    });
  }

  async dispatchDue(now = new Date()): Promise<number> {
    const due = await this.prisma.routine.findMany({
      where: { enabled: true, deletedAt: null, nextRunAt: { lte: now } },
      orderBy: { nextRunAt: "asc" },
      take: 50,
      select: { id: true, botId: true },
    });
    let dispatched = 0;
    for (const candidate of due) {
      const didDispatch = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`routine:${candidate.id}`}))`;
        const routine = await tx.routine.findUnique({
          where: { id: candidate.id },
        });
        if (!routine?.enabled || routine.deletedAt || !routine.nextRunAt || routine.nextRunAt > now)
          return false;
        const scheduledFor = routine.nextRunAt;
        const active = await tx.routineExecution.count({
          where: {
            routineId: routine.id,
            status: { in: ["queued", "running", "waiting_approval"] },
          },
        });
        if (routine.scheduleKind === "event") return false;
        const statusSnapshot = await routineStatusSnapshot(tx, routine.botId, routine.timezone);
        let nextRunAt = nextRoutineTriggerRun(
          routine.trigger as Record<string, unknown>,
          routine,
          scheduledFor,
          this.installationZone
        );
        while (nextRunAt <= now) {
          nextRunAt = nextRoutineTriggerRun(
            routine.trigger as Record<string, unknown>,
            routine,
            nextRunAt,
            this.installationZone
          );
        }
        await tx.routine.update({
          where: { id: routine.id },
          data: { nextRunAt, lastRunAt: scheduledFor },
        });
        const revision = await tx.routineRevision.findUniqueOrThrow({
          where: {
            routineId_revision: {
              routineId: routine.id,
              revision: routine.revision,
            },
          },
        });
        const dedupeKey = `routine:${routine.id}:revision:${routine.revision}:at:${scheduledFor.toISOString()}`;
        if (active > 0) {
          const execution = await tx.routineExecution.create({
            data: {
              routineId: routine.id,
              routineRevisionId: revision.id,
              kind: "scheduled",
              status: "skipped",
              dedupeKey,
              scheduledFor,
              completedAt: now,
              skipReason: "overlap",
            },
          });
          await tx.routine.update({
            where: { id: routine.id },
            data: {
              runLedger: appendRoutineRunLedger(routine.runLedger, {
                id: execution.id,
                trigger: "schedule",
                startedAt: now.getTime(),
                finishedAt: now.getTime(),
                status: "error",
                detail: "overlap",
              }),
            },
          });
          return false;
        }
        const channel = await tx.channel.findUnique({
          where: { directKey: `bot:${routine.botId}` },
        });
        if (!channel || channel.archivedAt) return false;
        const execution = await tx.routineExecution.create({
          data: {
            routineId: routine.id,
            routineRevisionId: revision.id,
            kind: "scheduled",
            status: "queued",
            dedupeKey,
            scheduledFor,
            enqueuedAt: now,
          },
        });
        const wake = await this.host.enqueueWake(tx, {
          botId: routine.botId,
          channelId: channel.id,
          origin: "routine",
          type: "routine.scheduled",
          content: scheduledRoutineWakeContent({
            name: routine.name,
            folder: routine.slug,
            schedule: routine.scheduleText,
            scheduledFor,
            prompt: routine.prompt,
            provenance: routine.provenance,
            routineStatuses: statusSnapshot,
          }),
          automationTrigger: scheduledRoutineTriggerContext({
            name: routine.name,
            scheduledFor,
          }),
          clientId: dedupeKey,
          priority: 100,
          occurredAt: scheduledFor,
          timeZone: routine.timezone,
        });
        await tx.routineExecution.update({
          where: { id: execution.id },
          data: { runId: wake.run.id },
        });
        await tx.routine.update({
          where: { id: routine.id },
          data: {
            runLedger: appendRoutineRunLedger(routine.runLedger, {
              id: execution.id,
              trigger: "schedule",
              startedAt: now.getTime(),
              finishedAt: null,
              status: "running",
            }),
          },
        });
        await tx.event.create({
          data: {
            topic: "routine.execution.queued",
            entityId: execution.id,
            payload: {
              executionId: execution.id,
              routineId: routine.id,
              runId: wake.run.id,
            },
          },
        });
        return true;
      });
      if (this.files) await this.files.writeRoutine(candidate.botId, candidate.id);
      if (didDispatch) dispatched += 1;
    }
    return dispatched;
  }
}
