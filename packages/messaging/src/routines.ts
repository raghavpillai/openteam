import { ApiError, type RoutineExecutionView, type RoutineView } from "@openbot/contracts";
import { Prisma, type PrismaClient } from "@openbot/db";
import { CronExpressionParser } from "cron-parser";
import {
  cronSchedules,
  firstCronSchedule,
  parseStoredTrigger,
  triggerIdentity,
} from "./automation-trigger";
import { uniqueSlug } from "./file-state";
import { type AutomationChangedAction, appendAgentTimelineEvent } from "./timeline-events";

const MIN_INTERVAL_SECONDS = 5 * 60;
const MAX_INTERVAL_SECONDS = 30 * 24 * 60 * 60;
const MAX_ROUTINES_PER_OWNER = 50;

export type RoutineOwner = { kind: "bot"; id: string } | { kind: "group"; id: string };

const appendRoutineChangedEvent = async (
  tx: Prisma.TransactionClient,
  host: RoutineWakeHost,
  owner: RoutineOwner,
  callId: string,
  routine: { id: string; name: string },
  action: AutomationChangedAction,
  createdAt = new Date()
) => {
  if (owner.kind === "group") return;
  await appendAgentTimelineEvent(tx, host, {
    botId: owner.id,
    clientId: `routine-change:${callId}`,
    event: {
      type: "automation-changed",
      action,
      automationId: routine.id,
      automationName: routine.name,
    },
    occurredAt: createdAt,
  });
};

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

export type { RoutineExecutionView, RoutineView } from "@openbot/contracts";

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
      origin: "routine" | "event";
      type: string;
      content: string;
      clientId: string;
      priority: number;
      availableAt?: Date;
      occurredAt?: Date;
      timeZone?: string | null;
      automationTrigger?: string;
      wrapUserContent?: boolean;
    }
  ): Promise<{ run: { id: string } }>;
  createGroupRound?(
    tx: Prisma.TransactionClient,
    input: {
      channelId: string;
      triggerMessageId: string;
      initiatorBotId?: string | null;
    }
  ): Promise<{ id: string; status: string }>;
  advanceRound?(roundId: string): Promise<void>;
}

const required = (value: string | undefined, field: string): string => {
  const text = value?.trim();
  if (!text) throw new Error(`${field} is required for this routine action`);
  return text;
};

const jsonInput = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

// PostgreSQL's uuid type accepts every canonical 8-4-4-4-12 hexadecimal value.
// Do not require RFC version/variant bits here: imported data and deterministic
// fixture IDs can be valid database UUIDs without carrying those annotations.
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

const routineIdentifierWhere = (id: string) =>
  UUID_PATTERN.test(id) ? { OR: [{ id }, { slug: id }] } : { slug: id };

const routineOwnerWhere = (owner: RoutineOwner) =>
  owner.kind === "bot" ? { botId: owner.id } : { channelId: owner.id };

const routineOwnerData = (owner: RoutineOwner) =>
  owner.kind === "bot"
    ? { botId: owner.id, channelId: null }
    : { botId: null, channelId: owner.id };

const routineOwnerFrom = (routine: {
  botId: string | null;
  channelId: string | null;
}): RoutineOwner => {
  if (routine.botId) return { kind: "bot", id: routine.botId };
  if (routine.channelId) return { kind: "group", id: routine.channelId };
  throw new Error("Routine has no owner");
};

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
  const cron = CronExpressionParser.parse(
    required(schedule.cronExpression ?? undefined, "cronExpression"),
    { currentDate: after, tz: schedule.timezone }
  );
  const minuteMs = 60_000;
  const maxSearchMinutes = 366 * 24 * 60;
  let candidate = Math.floor(after.getTime() / minuteMs) * minuteMs + minuteMs;
  for (let searched = 0; searched < maxSearchMinutes; searched += 1) {
    const date = new Date(candidate);
    if (cron.includesDate(date)) return date;
    candidate += minuteMs;
  }
  throw new Error("Routine cron schedule has no occurrence in the next 366 days");
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
  botId: string | null;
  channelId: string | null;
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
}): RoutineView => {
  const owner = routineOwnerFrom(routine);
  return {
    id: routine.id,
    folder: routine.slug,
    ownerId: owner.id,
    ownerKind: owner.kind,
    botId: routine.botId,
    channelId: routine.channelId,
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
    trigger: routine.trigger,
    triggerPresentation: routine.triggerPresentation,
  };
};

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

  private createGroupRound(
    tx: Prisma.TransactionClient,
    input: { channelId: string; triggerMessageId: string; initiatorBotId?: string | null }
  ) {
    if (!this.host.createGroupRound) {
      throw new Error("Group routine execution is unavailable");
    }
    return this.host.createGroupRound(tx, input);
  }

  private advanceGroupRound(roundId: string) {
    if (!this.host.advanceRound) throw new Error("Group routine execution is unavailable");
    return this.host.advanceRound(roundId);
  }

  async mutate(
    botId: string,
    callId: string,
    runId: string | null,
    input: RoutineMutationInput
  ): Promise<Record<string, unknown>> {
    return this.mutateOwner({ kind: "bot", id: botId }, callId, runId, input);
  }

  async mutateOwner(
    owner: RoutineOwner,
    callId: string,
    runId: string | null,
    input: RoutineMutationInput
  ): Promise<Record<string, unknown>> {
    switch (input.action) {
      case "create":
        return this.create(owner, callId, runId, input);
      case "update":
        return this.update(owner, callId, runId, input);
      case "pause":
      case "resume":
      case "delete":
        return this.lifecycle(owner, callId, runId, input);
    }
  }

  async list(botId: string): Promise<RoutineView[]> {
    return this.listOwner({ kind: "bot", id: botId });
  }

  async listOwner(owner: RoutineOwner): Promise<RoutineView[]> {
    const routines = await this.prisma.routine.findMany({
      where: { ...routineOwnerWhere(owner), deletedAt: null },
      include: { executions: { orderBy: { createdAt: "desc" }, take: 1 } },
      orderBy: [{ nextRunAt: "asc" }, { createdAt: "asc" }],
    });
    return routines.map(uiView);
  }

  async owner(id: string): Promise<RoutineOwner> {
    const routine = await this.prisma.routine.findFirst({
      where: { deletedAt: null, ...routineIdentifierWhere(id) },
      select: { botId: true, channelId: true },
    });
    if (!routine) throw new ApiError(404, "routine_not_found", "Routine not found");
    return routineOwnerFrom(routine);
  }

  async ownerId(id: string): Promise<string> {
    return (await this.owner(id)).id;
  }

  async detail(botId: string, id: string): Promise<RoutineView> {
    return this.detailOwner({ kind: "bot", id: botId }, id);
  }

  async detailOwner(owner: RoutineOwner, id: string): Promise<RoutineView> {
    const routine = await this.prisma.routine.findFirst({
      where: { ...routineOwnerWhere(owner), deletedAt: null, ...routineIdentifierWhere(id) },
      include: { executions: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    if (!routine) throw new ApiError(404, "routine_not_found", "Routine not found");
    return uiView(routine);
  }

  async executions(botId: string, id: string, limit = 20): Promise<RoutineExecutionView[]> {
    return this.executionsOwner({ kind: "bot", id: botId }, id, limit);
  }

  async executionsOwner(
    owner: RoutineOwner,
    id: string,
    limit = 20
  ): Promise<RoutineExecutionView[]> {
    const routine = await this.prisma.routine.findFirst({
      where: { ...routineOwnerWhere(owner), deletedAt: null, ...routineIdentifierWhere(id) },
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
    return this.runNowOwner({ kind: "bot", id: botId }, id, requestId, firedAt);
  }

  async runNowOwner(
    owner: RoutineOwner,
    id: string,
    requestId: string,
    firedAt = new Date()
  ): Promise<RoutineExecutionView> {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`routine-run:${owner.kind}:${owner.id}:${id}`}))`;
      const routine = await tx.routine.findFirst({
        where: { ...routineOwnerWhere(owner), deletedAt: null, ...routineIdentifierWhere(id) },
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
      const routineOwner = routineOwnerFrom(routine);
      const channel =
        routineOwner.kind === "bot"
          ? await tx.channel.findUnique({ where: { directKey: `bot:${routineOwner.id}` } })
          : await tx.channel.findUnique({ where: { id: routineOwner.id } });
      if (!channel || channel.archivedAt) {
        throw new ApiError(
          409,
          "routine_channel_unavailable",
          routineOwner.kind === "bot"
            ? "The Bot chat is unavailable"
            : "The group chat is unavailable"
        );
      }
      if (routineOwner.kind === "group" && channel.kind !== "group") {
        throw new ApiError(409, "routine_channel_unavailable", "The group chat is unavailable");
      }
      const revision = await tx.routineRevision.findUnique({
        where: {
          routineId_revision: { routineId: routine.id, revision: routine.revision },
        },
      });
      if (!revision) {
        throw new ApiError(
          409,
          "routine_revision_unavailable",
          "This routine needs to be saved again before it can run"
        );
      }
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
      let queued = execution;
      let runId: string | null = null;
      let roundId: string | null = null;
      let completedImmediately = false;
      if (routineOwner.kind === "bot") {
        const wake = await this.host.enqueueWake(tx, {
          botId: routineOwner.id,
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
            routineStatuses: await routineStatusSnapshot(tx, routineOwner.id, routine.timezone),
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
        runId = wake.run.id;
        queued = await tx.routineExecution.update({
          where: { id: execution.id },
          data: { runId },
        });
      } else {
        const message = await tx.channelMessage.create({
          data: {
            channelId: channel.id,
            sender: "user",
            clientId: dedupeKey,
            content: routine.prompt,
            metadata: {
              type: "routine",
              routineId: routine.id,
              routineName: routine.name,
              routineFolder: routine.slug,
              routineKind: "manual",
              scheduledFor: firedAt.toISOString(),
              timeZone: routine.timezone,
            },
          },
        });
        const round = await this.createGroupRound(tx, {
          channelId: channel.id,
          triggerMessageId: message.id,
          initiatorBotId: null,
        });
        roundId = round.id;
        completedImmediately = round.status === "completed";
        queued = await tx.routineExecution.update({
          where: { id: execution.id },
          data: {
            channelMessageId: message.id,
            status: round.status === "completed" ? "completed" : "running",
            startedAt: firedAt,
            ...(round.status === "completed" ? { completedAt: firedAt } : {}),
          },
        });
      }
      await tx.routine.update({
        where: { id: routine.id },
        data: {
          lastRunAt: firedAt,
          runLedger: appendRoutineRunLedger(routine.runLedger, {
            id: execution.id,
            trigger: "manual",
            startedAt: firedAt.getTime(),
            finishedAt: completedImmediately ? firedAt.getTime() : null,
            status: completedImmediately ? "ok" : "running",
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
            runId,
            roundId,
            kind: "test",
          },
        },
      });
      return queued;
    });
    if (owner.kind === "bot") await this.files?.writeRoutine(owner.id, result.routineId);
    if (result.channelMessageId) {
      const round = await this.prisma.channelRound.findUnique({
        where: { triggerMessageId: result.channelMessageId },
        select: { id: true, status: true },
      });
      if (round && round.status !== "completed") await this.advanceGroupRound(round.id);
    }
    return executionView(result);
  }

  private async create(
    owner: RoutineOwner,
    callId: string,
    runId: string | null,
    input: RoutineMutationInput
  ) {
    const name = required(input.name, "name").replace(/\s+/g, " ").slice(0, 80);
    const prompt = required(input.prompt, "prompt");
    const { schedule, trigger } = normalizeMutationTrigger(input, this.installationZone);
    const enabled = input.enabled ?? true;
    return this.prisma.$transaction(async (tx) => {
      if (owner.kind === "bot") {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent-files:${owner.id}`}))`;
      }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`routine-owner:${owner.kind}:${owner.id}`}))`;
      const ownerAvailable =
        owner.kind === "bot"
          ? (await tx.bot.count({ where: { id: owner.id, status: "active" } })) > 0
          : (await tx.channel.count({
              where: { id: owner.id, kind: "group", archivedAt: null },
            })) > 0;
      if (!ownerAvailable) {
        throw new Error(
          owner.kind === "bot"
            ? "Cannot create a routine for an inactive bot"
            : "Cannot create a routine for an inactive group"
        );
      }
      const count = await tx.routine.count({
        where: { ...routineOwnerWhere(owner), deletedAt: null },
      });
      if (count >= MAX_ROUTINES_PER_OWNER) {
        throw new Error("A Bot or group may have at most 50 routines");
      }
      const occupied = new Set(
        (
          await tx.routine.findMany({
            where: routineOwnerWhere(owner),
            select: { slug: true },
          })
        ).map((routine) => routine.slug)
      );
      const fileSlugs = new Set(
        owner.kind === "bot" ? ((await this.files?.listRoutineFolderIds?.(owner.id)) ?? []) : []
      );
      for (const slug of fileSlugs) occupied.add(slug);
      const slug = uniqueSlug(name, "automation", occupied);
      const now = new Date();
      const routine = await tx.routine.create({
        data: {
          ...routineOwnerData(owner),
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
          payload: {
            routineId: routine.id,
            ownerId: owner.id,
            ownerKind: owner.kind,
            ...(owner.kind === "bot" ? { botId: owner.id } : { channelId: owner.id }),
            revision: 1,
          },
        },
      });
      await appendRoutineChangedEvent(tx, this.host, owner, callId, routine, "created", now);
      if (owner.kind === "bot") await this.files?.writeRoutine(owner.id, routine.id, tx);
      return { ...view(routine), action: "create", created: true };
    });
  }

  private async update(
    owner: RoutineOwner,
    callId: string,
    runId: string | null,
    input: RoutineMutationInput
  ) {
    const id = required(input.id, "id");
    return this.prisma.$transaction(async (tx) => {
      if (owner.kind === "bot") {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent-files:${owner.id}`}))`;
      }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`routine-owner:${owner.kind}:${owner.id}`}))`;
      const current = await tx.routine.findFirst({
        where: { ...routineOwnerWhere(owner), deletedAt: null, ...routineIdentifierWhere(id) },
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
      const authoredChanged =
        name !== current.name ||
        prompt !== current.prompt ||
        triggerIdentity(trigger) !== triggerIdentity(current.trigger as Record<string, unknown>);
      const enabledChanged = enabled !== current.enabled;
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
          payload: {
            routineId: current.id,
            ownerId: owner.id,
            ownerKind: owner.kind,
            ...(owner.kind === "bot" ? { botId: owner.id } : { channelId: owner.id }),
            revision,
          },
        },
      });
      const timelineAction = authoredChanged
        ? "updated"
        : enabledChanged
          ? enabled
            ? "enabled"
            : "disabled"
          : null;
      if (timelineAction) {
        await appendRoutineChangedEvent(tx, this.host, owner, callId, routine, timelineAction, now);
      }
      if (owner.kind === "bot") await this.files?.writeRoutine(owner.id, routine.id, tx);
      return { ...view(routine), action: "update", updated: true };
    });
  }

  private async lifecycle(
    owner: RoutineOwner,
    callId: string,
    runId: string | null,
    input: RoutineMutationInput
  ) {
    const id = required(input.id, "id");
    return this.prisma.$transaction(async (tx) => {
      if (owner.kind === "bot") {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent-files:${owner.id}`}))`;
      }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`routine-owner:${owner.kind}:${owner.id}`}))`;
      const current = await tx.routine.findFirst({
        where: { ...routineOwnerWhere(owner), deletedAt: null, ...routineIdentifierWhere(id) },
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
      if (!deleted && current.enabled === enabled) {
        return {
          ...view(current),
          action: input.action,
          paused: false,
          resumed: false,
          deleted: false,
          unchanged: true,
        };
      }
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
          payload: {
            routineId: current.id,
            ownerId: owner.id,
            ownerKind: owner.kind,
            ...(owner.kind === "bot" ? { botId: owner.id } : { channelId: owner.id }),
            revision,
          },
        },
      });
      await appendRoutineChangedEvent(
        tx,
        this.host,
        owner,
        callId,
        routine,
        deleted ? "deleted" : enabled ? "enabled" : "disabled",
        now
      );
      if (owner.kind === "bot") {
        if (deleted) await this.files?.deleteRoutine(owner.id, routine.id, tx);
        else await this.files?.writeRoutine(owner.id, routine.id, tx);
      }
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
      select: { id: true, botId: true, channelId: true },
    });
    let dispatched = 0;
    for (const candidate of due) {
      const outcome = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`routine:${candidate.id}`}))`;
        const routine = await tx.routine.findUnique({
          where: { id: candidate.id },
        });
        if (!routine?.enabled || routine.deletedAt || !routine.nextRunAt || routine.nextRunAt > now)
          return { didDispatch: false, roundId: null as string | null };
        const scheduledFor = routine.nextRunAt;
        const active = await tx.routineExecution.count({
          where: {
            routineId: routine.id,
            status: { in: ["queued", "running", "waiting_approval"] },
          },
        });
        if (routine.scheduleKind === "event") {
          return { didDispatch: false, roundId: null as string | null };
        }
        const owner = routineOwnerFrom(routine);
        const statusSnapshot =
          owner.kind === "bot" ? await routineStatusSnapshot(tx, owner.id, routine.timezone) : [];
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
          return { didDispatch: false, roundId: null as string | null };
        }
        const channel =
          owner.kind === "bot"
            ? await tx.channel.findUnique({ where: { directKey: `bot:${owner.id}` } })
            : await tx.channel.findUnique({ where: { id: owner.id } });
        if (
          !channel ||
          channel.archivedAt ||
          (owner.kind === "group" && channel.kind !== "group")
        ) {
          return { didDispatch: false, roundId: null as string | null };
        }
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
        let runId: string | null = null;
        let roundId: string | null = null;
        let completedImmediately = false;
        if (owner.kind === "bot") {
          const wake = await this.host.enqueueWake(tx, {
            botId: owner.id,
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
          runId = wake.run.id;
          await tx.routineExecution.update({
            where: { id: execution.id },
            data: { runId },
          });
        } else {
          const message = await tx.channelMessage.create({
            data: {
              channelId: channel.id,
              sender: "user",
              clientId: dedupeKey,
              content: routine.prompt,
              metadata: {
                type: "routine",
                routineId: routine.id,
                routineName: routine.name,
                routineFolder: routine.slug,
                routineKind: "scheduled",
                scheduledFor: scheduledFor.toISOString(),
                timeZone: routine.timezone,
              },
            },
          });
          const round = await this.createGroupRound(tx, {
            channelId: channel.id,
            triggerMessageId: message.id,
            initiatorBotId: null,
          });
          roundId = round.id;
          completedImmediately = round.status === "completed";
          await tx.routineExecution.update({
            where: { id: execution.id },
            data: {
              channelMessageId: message.id,
              status: round.status === "completed" ? "completed" : "running",
              startedAt: now,
              ...(round.status === "completed" ? { completedAt: now } : {}),
            },
          });
        }
        await tx.routine.update({
          where: { id: routine.id },
          data: {
            runLedger: appendRoutineRunLedger(routine.runLedger, {
              id: execution.id,
              trigger: "schedule",
              startedAt: now.getTime(),
              finishedAt: completedImmediately ? now.getTime() : null,
              status: completedImmediately ? "ok" : "running",
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
              runId,
              roundId,
            },
          },
        });
        return { didDispatch: true, roundId };
      });
      if (candidate.botId) await this.files?.writeRoutine(candidate.botId, candidate.id);
      if (outcome.roundId) await this.advanceGroupRound(outcome.roundId);
      if (outcome.didDispatch) dispatched += 1;
    }
    return dispatched;
  }
}
