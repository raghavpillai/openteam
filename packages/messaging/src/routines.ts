import { CronExpressionParser } from "cron-parser";
import type { Prisma, PrismaClient } from "@openbot/db";

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

interface NormalizedSchedule {
  scheduleText: string;
  scheduleKind: "cron" | "interval";
  cronExpression: string | null;
  intervalSeconds: number | null;
  timezoneMode: "installation" | "pinned";
  timezone: string;
}

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

const cronFromTrigger = (trigger: unknown): string | undefined => {
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) return undefined;
  const record = trigger as Record<string, unknown>;
  if (record.type !== "cron") {
    throw new Error("OpenBot currently supports only cron routine triggers");
  }
  return typeof record.schedule === "string" ? record.schedule : undefined;
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
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};

export const normalizeRoutineSchedule = (
  original: string,
  installationZone: string
): NormalizedSchedule => {
  const scheduleText = original.trim();
  const interval = scheduleText.match(/^@every\s+(\d+)\s*([mhd])$/i);
  if (interval?.[1] && interval[2]) {
    const multiplier =
      interval[2].toLowerCase() === "m" ? 60 : interval[2].toLowerCase() === "h" ? 3600 : 86400;
    const intervalSeconds = Number(interval[1]) * multiplier;
    if (intervalSeconds < MIN_INTERVAL_SECONDS || intervalSeconds > MAX_INTERVAL_SECONDS) {
      throw new Error("Routine intervals must be between 5 minutes and 30 days");
    }
    return {
      scheduleText,
      scheduleKind: "interval",
      cronExpression: null,
      intervalSeconds,
      timezoneMode: "installation",
      timezone: validZone(installationZone),
    };
  }

  const zoneMatch = scheduleText.match(/^CRON_TZ=([^\s]+)\s+(.+)$/);
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

export const nextRoutineRun = (
  schedule: Pick<
    NormalizedSchedule,
    "scheduleKind" | "cronExpression" | "intervalSeconds" | "timezone"
  >,
  after: Date
): Date => {
  if (schedule.scheduleKind === "interval") {
    return new Date(after.getTime() + (schedule.intervalSeconds ?? 0) * 1_000);
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
});

export class RoutineService {
  readonly installationZone: string;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly host: RoutineWakeHost,
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

  private async create(
    botId: string,
    callId: string,
    runId: string | null,
    input: RoutineMutationInput
  ) {
    const name = required(input.name, "name");
    const prompt = required(input.prompt, "prompt");
    const schedule = normalizeRoutineSchedule(
      required(input.schedule ?? cronFromTrigger(input.trigger), "schedule"),
      this.installationZone
    );
    const enabled = input.enabled ?? true;
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`routine-bot:${botId}`}))`;
      const count = await tx.routine.count({ where: { botId, deletedAt: null } });
      if (count >= MAX_ROUTINES_PER_BOT) throw new Error("A bot may have at most 50 routines");
      const now = new Date();
      const routine = await tx.routine.create({
        data: {
          botId,
          name,
          prompt,
          ...schedule,
          enabled,
          nextRunAt: enabled ? nextRoutineRun(schedule, now) : null,
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
      const current = await tx.routine.findFirst({ where: { id, botId, deletedAt: null } });
      if (!current) throw new Error("Routine not found");
      const schedule =
        input.schedule !== undefined || input.trigger !== undefined
          ? normalizeRoutineSchedule(
              required(input.schedule ?? cronFromTrigger(input.trigger), "schedule"),
              this.installationZone
            )
          : {
              scheduleText: current.scheduleText,
              scheduleKind: current.scheduleKind,
              cronExpression: current.cronExpression,
              intervalSeconds: current.intervalSeconds,
              timezoneMode: current.timezoneMode as "installation" | "pinned",
              timezone: current.timezone,
            };
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
          ...schedule,
          enabled,
          revision,
          nextRunAt: enabled ? nextRoutineRun(schedule, now) : null,
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
      const current = await tx.routine.findFirst({ where: { id, botId, deletedAt: null } });
      if (!current) throw new Error("Routine not found");
      const now = new Date();
      const enabled = input.action === "resume";
      const deleted = input.action === "delete";
      const schedule = {
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
          nextRunAt: enabled ? nextRoutineRun(schedule, now) : null,
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
      select: { id: true },
    });
    let dispatched = 0;
    for (const candidate of due) {
      const didDispatch = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`routine:${candidate.id}`}))`;
        const routine = await tx.routine.findUnique({ where: { id: candidate.id } });
        if (!routine?.enabled || routine.deletedAt || !routine.nextRunAt || routine.nextRunAt > now)
          return false;
        const scheduledFor = routine.nextRunAt;
        const active = await tx.routineExecution.count({
          where: {
            routineId: routine.id,
            status: { in: ["queued", "running", "waiting_approval"] },
          },
        });
        let nextRunAt = nextRoutineRun(routine, scheduledFor);
        while (nextRunAt <= now) nextRunAt = nextRoutineRun(routine, nextRunAt);
        await tx.routine.update({ where: { id: routine.id }, data: { nextRunAt } });
        const revision = await tx.routineRevision.findUniqueOrThrow({
          where: { routineId_revision: { routineId: routine.id, revision: routine.revision } },
        });
        const dedupeKey = `routine:${routine.id}:revision:${routine.revision}:at:${scheduledFor.toISOString()}`;
        if (active > 0) {
          await tx.routineExecution.create({
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
        await tx.event.create({
          data: {
            topic: "routine.execution.queued",
            entityId: execution.id,
            payload: { executionId: execution.id, routineId: routine.id, runId: wake.run.id },
          },
        });
        return true;
      });
      if (didDispatch) dispatched += 1;
    }
    return dispatched;
  }
}
