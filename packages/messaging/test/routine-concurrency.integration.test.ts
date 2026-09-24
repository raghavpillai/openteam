import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@openteam/db";
import { RoutineService } from "../src/routines";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const db = databaseUrl ? createPrismaClient(databaseUrl) : null;
afterAll(async () => {
  await db?.$disconnect();
});

describe.skipIf(!db)("routine database concurrency and dispatch isolation", () => {
  async function fixture(onWake?: (input: any) => Promise<void>) {
    const botId = randomUUID(),
      channelId = randomUUID(),
      conversationId = randomUUID();
    await db!.channel.create({
      data: { id: channelId, kind: "group", name: "Disposable routine QA" },
    });
    await db!.bot.create({
      data: {
        id: botId,
        name: "Disposable routine QA",
        status: "active",
        defaultDirectory: "/tmp/routine-qa",
        conversation: { create: { id: conversationId } },
        channelMemberships: { create: { channelId, ordinal: 0 } },
      },
    });
    const owner = { kind: "group" as const, id: channelId };
    const wakes: any[] = [];
    const service = new RoutineService(db!, {
      defaultTimeZone: "UTC",
      enqueueWake: async () => {
        throw new Error("Group routines must enter the room");
      },
      createGroupRound: async (tx, input) => {
        const seed = await tx.channelMessage.findUniqueOrThrow({
          where: { id: input.triggerMessageId },
        });
        wakes.push(seed);
        await onWake?.(seed);
        return tx.channelRound.create({
          data: { channelId, triggerMessageId: seed.id, rootMessageId: seed.id },
        });
      },
      advanceRound: async () => {},
    });
    const routine = await service.mutateOwner(owner, randomUUID(), null, {
      action: "create",
      name: "QA routine",
      prompt: "QA exact body Café 日本語 🙂",
      schedule: "@every 5m",
      enabled: false,
      source: "ui",
    });
    const due = async (at: Date) =>
      db!.routine.update({
        where: { id: String(routine.id) },
        data: { enabled: true, nextRunAt: at },
      });
    const cleanup = async () => {
      await db!.routine.deleteMany({ where: { channelId } });
      await db!.bot.delete({ where: { id: botId } });
      await db!.channel.delete({ where: { id: channelId } });
    };
    return { botId, channelId, owner, service, routine, wakes, due, cleanup };
  }

  test("manual and scheduled launches cannot overlap", async () => {
    let entered!: () => void, release!: () => void;
    const first = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const f = await fixture(async () => {
      entered();
      await gate;
    });
    try {
      const now = new Date();
      await f.due(now);
      const manual = f.service.runNowOwner(f.owner, String(f.routine.id), randomUUID());
      await first;
      const scheduled = f.service.dispatchDue(now);
      await Bun.sleep(150);
      release();
      await Promise.all([manual, scheduled]);
      const executions = await db!.routineExecution.findMany({
        where: { routineId: String(f.routine.id) },
      });
      expect(f.wakes).toHaveLength(1);
      expect(executions.filter((x) => x.status === "queued")).toHaveLength(1);
      expect(
        executions.filter((x) => x.status === "skipped" && x.skipReason === "overlap")
      ).toHaveLength(1);
    } finally {
      release();
      await f.cleanup();
    }
  });

  test("concurrent creation retries save only one routine for each request", async () => {
    const f = await fixture();
    try {
      const callId = randomUUID();
      const input = {
        action: "create" as const,
        name: "Retried routine",
        prompt: "Run once",
        schedule: "@every 5m",
        enabled: false,
      };
      const replies = await Promise.all(
        Array.from({ length: 6 }, () => f.service.mutateOwner(f.owner, callId, null, input))
      );
      expect(new Set(replies.map((reply) => reply.id)).size).toBe(1);
      expect(await db!.routine.count({ where: { channelId: f.channelId, name: input.name } })).toBe(
        1
      );
      expect(await db!.routineRevision.count({ where: { callId } })).toBe(1);
      const restarted = new RoutineService(db!, { defaultTimeZone: "UTC" } as never);
      expect((await restarted.mutateOwner(f.owner, callId, null, input)).id).toBe(replies[0]!.id);
    } finally {
      await f.cleanup();
    }
  });

  test("manual calls by slug and UUID share the same overlap gate", async () => {
    let entered!: () => void, release!: () => void;
    const first = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const f = await fixture(async () => {
      entered();
      await gate;
    });
    try {
      const a = f.service.runNowOwner(f.owner, String(f.routine.id), randomUUID());
      await first;
      const b = f.service.runNowOwner(f.owner, String(f.routine.folder), randomUUID());
      const results = Promise.allSettled([a, b]);
      await Bun.sleep(150);
      release();
      const done = await results;
      expect(f.wakes).toHaveLength(1);
      expect(done.filter((x) => x.status === "rejected")).toHaveLength(1);
    } finally {
      release();
      await f.cleanup();
    }
  });

  test("a cron routine catches up after a month offline without timing out its transaction", async () => {
    const f = await fixture();
    try {
      await f.service.mutateOwner(f.owner, randomUUID(), null, {
        action: "update",
        id: String(f.routine.id),
        schedule: "*/5 * * * *",
      });
      const now = new Date("2026-09-24T10:02:30Z");
      const missed = new Date("2026-08-24T10:00:00Z");
      await f.due(missed);
      expect(await f.service.dispatchDue(now)).toBe(1);
      expect(f.wakes).toHaveLength(1);
      expect(
        (await db!.routine.findUniqueOrThrow({ where: { id: String(f.routine.id) } })).nextRunAt
      ).toEqual(new Date("2026-09-24T10:05:00Z"));
      expect(
        await db!.routineExecution.findMany({ where: { routineId: String(f.routine.id) } })
      ).toMatchObject([{ status: "queued", scheduledFor: missed }]);
    } finally {
      await f.cleanup();
    }
  }, 45_000);

  test("one unavailable group executor cannot starve other due routines", async () => {
    const bad = await fixture(),
      good = await fixture();
    try {
      const now = new Date();
      await bad.due(new Date(now.getTime() - 1000));
      await good.due(now);
      await db!.channelMember.deleteMany({ where: { channelId: bad.channelId } });
      await expect(good.service.dispatchDue(now)).resolves.toBe(1);
      expect(good.wakes).toHaveLength(1);
      const failure = await db!.routineExecution.findFirst({
        where: { routineId: String(bad.routine.id) },
      });
      expect(failure?.status).toBe("failed");
      expect((failure?.error as any)?.code).toBe("routine_executor_unavailable");
      expect(
        (
          await db!.routine.findUniqueOrThrow({ where: { id: String(bad.routine.id) } })
        ).nextRunAt!.getTime()
      ).toBeGreaterThan(now.getTime());
    } finally {
      await bad.cleanup();
      await good.cleanup();
    }
  });

  test("manual idempotency, pause, resume, immutable revision and deletion", async () => {
    const f = await fixture();
    try {
      const request = randomUUID();
      const first = await f.service.runNowOwner(f.owner, String(f.routine.id), request);
      expect(await f.service.runNowOwner(f.owner, String(f.routine.id), request)).toEqual(first);
      expect(f.wakes).toHaveLength(1);
      expect(f.wakes[0].content).toContain("QA exact body Café 日本語 🙂");
      await db!.routineExecution.update({
        where: { id: first.id },
        data: { status: "completed", completedAt: new Date() },
      });
      const edited = await f.service.mutateOwner(f.owner, randomUUID(), null, {
        action: "update",
        id: String(f.routine.id),
        prompt: "Second exact body",
        expectedRevision: 1,
      });
      await expect(
        f.service.mutateOwner(f.owner, randomUUID(), null, {
          action: "update",
          id: String(f.routine.id),
          prompt: "Stale body",
          expectedRevision: 1,
        })
      ).rejects.toThrow("changed somewhere else");
      const old = await db!.routineExecution.findUniqueOrThrow({
        where: { id: first.id },
        include: { routineRevision: true },
      });
      expect(old.routineRevision.prompt).toBe("QA exact body Café 日本語 🙂");
      const resumed = await f.service.mutateOwner(f.owner, randomUUID(), null, {
        action: "resume",
        id: String(f.routine.id),
        expectedRevision: Number(edited.revision),
      });
      expect(resumed.next_run_at).toBeString();
      const paused = await f.service.mutateOwner(f.owner, randomUUID(), null, {
        action: "pause",
        id: String(f.routine.id),
        expectedRevision: Number(resumed.revision),
      });
      expect(paused.next_run_at).toBeNull();
      expect(await f.service.dispatchDue(new Date(Date.now() + 3600000))).toBe(0);
      await f.service.mutateOwner(f.owner, randomUUID(), null, {
        action: "delete",
        id: String(f.routine.id),
        expectedRevision: Number(paused.revision),
      });
      await expect(
        f.service.runNowOwner(f.owner, String(f.routine.id), randomUUID())
      ).rejects.toThrow("not found");
    } finally {
      await f.cleanup();
    }
  });
});
