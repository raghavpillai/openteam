import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@openteam/db";
import { RoutineService } from "../src/routines";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

test("interval and weekday routines can be created, test-run, and dispatched when due", async () => {
  if (!databaseUrl) return;

  const prisma = createPrismaClient(databaseUrl);
  const channelId = randomUUID();
  const owner = { kind: "group" as const, id: channelId };
  const service = new RoutineService(
    prisma,
    {
      defaultTimeZone: "America/New_York",
      enqueueWake: async () => {
        throw new Error("group routine test unexpectedly queued a bot wake");
      },
      createGroupRound: async () => ({ id: randomUUID(), status: "completed" }),
      advanceRound: async () => {},
    },
    undefined,
    "America/New_York"
  );
  const routineIds: string[] = [];
  const executionIds: string[] = [];

  try {
    await prisma.channel.create({
      data: { id: channelId, kind: "group", name: "Routine time lifecycle test" },
    });

    const interval = await service.mutateOwner(owner, randomUUID(), null, {
      action: "create",
      name: "Every minute",
      prompt: "Confirm the interval routine ran.",
      schedule: "@every 1m",
      source: "ui",
    });
    const weekdays = await service.mutateOwner(owner, randomUUID(), null, {
      action: "create",
      name: "Weekdays at eleven",
      prompt: "Confirm the weekday routine ran.",
      trigger: { type: "cron", schedule: "0 11 * * 1-5" },
      source: "ui",
    });
    routineIds.push(String(interval.id), String(weekdays.id));

    const stored = await prisma.routine.findMany({
      where: { id: { in: routineIds } },
      orderBy: { name: "asc" },
    });
    expect(stored).toHaveLength(2);
    expect(stored.find(({ id }) => id === interval.id)).toMatchObject({
      scheduleKind: "interval",
      intervalSeconds: 60,
      enabled: true,
    });
    expect(stored.find(({ id }) => id === weekdays.id)).toMatchObject({
      scheduleKind: "cron",
      cronExpression: "0 11 * * 1-5",
      timezone: "America/New_York",
      enabled: true,
    });

    for (const routineId of routineIds) {
      const execution = await service.runNowOwner(
        owner,
        routineId,
        randomUUID(),
        new Date("2026-09-02T12:00:00.000Z")
      );
      executionIds.push(execution.id);
      expect(execution).toMatchObject({ kind: "test", status: "completed" });
    }

    const dispatchAt = new Date("2026-09-02T12:01:00.000Z");
    await prisma.routine.updateMany({
      where: { id: { in: routineIds } },
      data: { nextRunAt: new Date(dispatchAt.getTime() - 1) },
    });
    expect(await service.dispatchDue(dispatchAt)).toBe(2);

    const executions = await prisma.routineExecution.findMany({
      where: { routineId: { in: routineIds } },
      orderBy: { createdAt: "asc" },
    });
    executionIds.push(...executions.map(({ id }) => id));
    for (const routineId of routineIds) {
      expect(
        executions
          .filter((execution) => execution.routineId === routineId)
          .map(({ kind, status }) => ({ kind, status }))
      ).toEqual([
        { kind: "test", status: "completed" },
        { kind: "scheduled", status: "completed" },
      ]);
    }
    expect(
      await prisma.routine.count({
        where: { id: { in: routineIds }, nextRunAt: { gt: dispatchAt } },
      })
    ).toBe(2);
  } finally {
    await prisma.event.deleteMany({
      where: { entityId: { in: [...routineIds, ...executionIds] } },
    });
    await prisma.channel.deleteMany({ where: { id: channelId } });
    await prisma.$disconnect();
  }
});
