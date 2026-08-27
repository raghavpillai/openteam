import { CronExpressionParser } from "cron-parser";
import type { Prisma, PrismaClient } from "@openbot/db";
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
  enabled?: boolean;
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
  writeRoutine(botId: string, id: string): Promise<void>;
  deleteRoutine(botId: string, id: string): Promise<void>;
}

const EVENT_TRIGGER_TYPES = new Set([
  "slack",
  "github",
  "origin",
  "microsoftTeams",
  "linear",
  "sentry",
  "pagerduty",
  "webhook",
]);
const ORIGIN_TRIGGER_EXCLUSIONS = new Set([
  "microsoftTeams",
  "linear",
  "sentry",
  "pagerduty",
  "webhook",
]);

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

export interface RoutineRunLedgerEntry {
  id: string;
  trigger: "schedule" | "manual" | "event";
  startedAt: number;
  finishedAt?: number | null;
  status: "ok" | "error" | "running";
  [key: string]: unknown;
}

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
      .sort((left, right) => Number(left.startedAt ?? 0) - Number(right.startedAt ?? 0))
      .slice(-20)
  );
};

const triggerRecord = (value: unknown): Record<string, unknown> => {
  if (Array.isArray(value)) {
    if (value.length < 1 || value.length > 8)
      throw new Error("group trigger must contain 1-8 listeners");
    const listeners = value.map(triggerRecord);
    if (listeners.some((listener) => listener.type === "group"))
      throw new Error("group triggers cannot be nested");
    return listeners.length === 1 ? listeners[0]! : validateTriggerGroup(listeners);
  }
  if (!value || typeof value !== "object") {
    throw new Error("trigger must be an object");
  }
  const trigger = value as Record<string, unknown>;
  if (typeof trigger.type !== "string") throw new Error("trigger.type is required");
  if (trigger.type === "cron") {
    return {
      ...trigger,
      schedule: required(trigger.schedule as string | undefined, "trigger.schedule"),
    };
  }
  if (trigger.type === "group") {
    const rawListeners = trigger.listeners ?? trigger.triggers;
    if (!Array.isArray(rawListeners) || rawListeners.length < 1 || rawListeners.length > 8) {
      throw new Error("group trigger must contain 1-8 listeners");
    }
    const listeners = rawListeners.map(triggerRecord);
    if (listeners.some((listener) => listener.type === "group"))
      throw new Error("group triggers cannot be nested");
    return listeners.length === 1 ? listeners[0]! : validateTriggerGroup(listeners);
  }
  if (!EVENT_TRIGGER_TYPES.has(trigger.type)) {
    throw new Error(`Unsupported routine trigger type: ${trigger.type}`);
  }
  return trigger;
};

const validateTriggerGroup = (
  listeners: Array<Record<string, unknown>>
): Record<string, unknown> => {
  const types = new Set(listeners.map((entry) => String(entry.type)));
  if (types.has("origin") && [...types].some((type) => ORIGIN_TRIGGER_EXCLUSIONS.has(type))) {
    throw new Error("origin cannot be grouped with Teams, Linear, Sentry, PagerDuty, or webhook");
  }
  return { type: "group", listeners };
};

const firstCronSchedule = (trigger: Record<string, unknown>): string | null => {
  if (trigger.type === "cron" && typeof trigger.schedule === "string") return trigger.schedule;
  if (trigger.type !== "group" || !Array.isArray(trigger.listeners)) return null;
  const cron = trigger.listeners.find(
    (listener) =>
      Boolean(listener) &&
      typeof listener === "object" &&
      !Array.isArray(listener) &&
      (listener as { type?: unknown }).type === "cron"
  ) as { schedule?: unknown } | undefined;
  return typeof cron?.schedule === "string" ? cron.schedule : null;
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
    occurrences.some(
      (time, index) => index > 0 && time - occurrences[index - 1]! < MIN_INTERVAL_SECONDS * 1_000
    )
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
    ? triggerRecord(input.trigger)
    : { type: "cron", schedule: required(input.schedule, "schedule") };
  if (input.schedule !== undefined) {
    trigger.type = "cron";
    trigger.schedule = required(input.schedule, "schedule");
  }
  const cronSchedule = firstCronSchedule(trigger);
  if (cronSchedule !== null) {
    const schedule = normalizeRoutineSchedule(
      required(cronSchedule, "trigger.schedule"),
      installationZone,
      {
        enforceMinimum: process.env.OPENBOT_ENFORCE_AUTOMATION_MINIMUM === "true",
      }
    );
    return {
      trigger: trigger.type === "cron" ? { ...trigger, schedule: schedule.scheduleText } : trigger,
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

const view = (routine: {
  id: string;
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
    let result: Record<string, unknown>;
    switch (input.action) {
      case "create":
        result = await this.create(botId, callId, runId, input);
        break;
      case "update":
        result = await this.update(botId, callId, runId, input);
        break;
      case "pause":
      case "resume":
      case "delete":
        result = await this.lifecycle(botId, callId, runId, input);
        break;
    }
    if (typeof result.id === "string" && this.files) {
      if (input.action === "delete") await this.files.deleteRoutine(botId, result.id);
      else await this.files.writeRoutine(botId, result.id);
    }
    return result;
  }

  private async create(
    botId: string,
    callId: string,
    runId: string | null,
    input: RoutineMutationInput
  ) {
    const name = required(input.name, "name");
    const prompt = required(input.prompt, "prompt");
    const { schedule, trigger } = normalizeMutationTrigger(input, this.installationZone);
    const enabled = input.enabled ?? true;
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`routine-bot:${botId}`}))`;
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
      const slug = uniqueSlug(name, "automation", occupied);
      const now = new Date();
      const routine = await tx.routine.create({
        data: {
          botId,
          slug,
          name,
          prompt,
          trigger: jsonInput(trigger),
          triggerPresentation: jsonInput({ version: 1, trigger }),
          provenance: "untrusted",
          ...schedule,
          enabled,
          nextRunAt:
            enabled && schedule.scheduleKind !== "event" ? nextRoutineRun(schedule, now) : null,
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
          source: "agent",
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
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`routine:${id}`}))`;
      const current = await tx.routine.findFirst({
        where: { id, botId, deletedAt: null },
      });
      if (!current) throw new Error("Routine not found");
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
      const name = input.name === undefined ? current.name : required(input.name, "name");
      const prompt = input.prompt === undefined ? current.prompt : required(input.prompt, "prompt");
      const enabled = input.enabled ?? current.enabled;
      const revision = current.revision + 1;
      const now = new Date();
      const routine = await tx.routine.update({
        where: { id },
        data: {
          name,
          prompt,
          trigger: jsonInput(trigger),
          triggerPresentation: jsonInput({ version: 1, trigger }),
          ...schedule,
          enabled,
          revision,
          nextRunAt:
            enabled && schedule.scheduleKind !== "event" ? nextRoutineRun(schedule, now) : null,
          pausedAt: enabled ? null : (current.pausedAt ?? now),
        },
      });
      await tx.routineRevision.create({
        data: {
          routineId: id,
          revision,
          name,
          prompt,
          ...schedule,
          enabled,
          source: "agent",
          callId,
          runId,
        },
      });
      await tx.event.create({
        data: {
          topic: "routine.updated",
          entityId: id,
          payload: { routineId: id, botId, revision },
        },
      });
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
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`routine:${id}`}))`;
      const current = await tx.routine.findFirst({
        where: { id, botId, deletedAt: null },
      });
      if (!current) throw new Error("Routine not found");
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
        where: { id },
        data: {
          enabled: deleted ? false : enabled,
          revision,
          nextRunAt:
            enabled && schedule.scheduleKind !== "event" ? nextRoutineRun(schedule, now) : null,
          pausedAt: enabled ? null : now,
          deletedAt: deleted ? now : null,
        },
      });
      await tx.routineRevision.create({
        data: {
          routineId: id,
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
          source: "agent",
          callId,
          runId,
        },
      });
      await tx.event.create({
        data: {
          topic: `routine.${input.action}d`,
          entityId: id,
          payload: { routineId: id, botId, revision },
        },
      });
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
        let nextRunAt = nextRoutineRun(routine, scheduledFor);
        while (nextRunAt <= now) nextRunAt = nextRoutineRun(routine, nextRunAt);
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
          content: [
            `[OpenBot routine: ${routine.name}]`,
            `Scheduled occurrence: ${scheduledFor.toISOString()}`,
            "This is background work, not a user-authored message.",
            "Use SendMessage to deliver a meaningful result; finish silently when the routine explicitly says there is nothing to report.",
            "",
            routine.prompt,
          ].join("\n"),
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
              coalescedRunIds: [wake.run.id],
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
