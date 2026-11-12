import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentMessaging } from "../src/index";
import { followUserTimeZone, pinRoutinesToScheduledZone, RoutineService } from "../src/routines";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;

async function fixture() {
  const db = createPrismaClient(url!);
  const botId = randomUUID(),
    channelId = randomUUID(),
    conversationId = randomUUID(),
    roomId = randomUUID();
  const root = await mkdtemp(join(tmpdir(), "routine-scheduler-fix-"));
  const previousZone = await db.userTimeZoneSettings.findUnique({ where: { id: "global" } });
  await db.userTimeZoneSettings.upsert({
    where: { id: "global" },
    create: { id: "global", detected: "UTC" },
    update: { detected: "UTC", override: null },
  });
  await db.bot.create({
    data: {
      id: botId,
      name: "Scheduler regressions",
      defaultDirectory: root,
      status: "active",
      conversation: { create: { id: conversationId } },
    },
  });
  await db.channel.create({
    data: {
      id: channelId,
      name: "Scheduler direct",
      kind: "bot_dm",
      directKey: `bot:${botId}`,
      members: { create: { botId, ordinal: 0 } },
    },
  });
  await db.channel.create({
    data: {
      id: roomId,
      kind: "group",
      name: "Scheduler regressions",
      members: { create: { botId, ordinal: 0 } },
    },
  });
  const messaging = new AgentMessaging(db, {
    send: async () => "job",
    sendDebounced: async () => "job",
  } as never);
  messaging.isTimelineSessionActive = async () => false;
  const service = new RoutineService(db, messaging);
  const owner = { kind: "group" as const, id: roomId };
  const create = async (trigger: unknown, useBot = false) =>
    String(
      (
        await service.mutateOwner(useBot ? { kind: "bot", id: botId } : owner, randomUUID(), null, {
          action: "create",
          name: "Test cadence",
          prompt: "Saved instructions",
          trigger,
        })
      ).id
    );
  return {
    db,
    botId,
    channelId,
    roomId,
    messaging,
    service,
    owner,
    create,
    close: async () => {
      await db.bot.delete({ where: { id: botId } });
      await db.channel.deleteMany({ where: { id: { in: [channelId, roomId] } } });
      if (previousZone)
        await db.userTimeZoneSettings.update({ where: { id: "global" }, data: previousZone });
      else await db.userTimeZoneSettings.deleteMany({ where: { id: "global" } });
      await db.$disconnect();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test.skipIf(!url)(
  "metadata edits and manual runs preserve interval due time and anchor",
  async () => {
    const f = await fixture();
    try {
      const id = await f.create({ type: "cron", schedule: "@every 15m" });
      const presentation = {
        version: 2,
        kind: "bot-time-routines",
        schedules: [{ preset: "interval", intervalAmount: 15, intervalUnit: "m" }],
      };
      await f.db.routine.update({ where: { id }, data: { triggerPresentation: presentation } });
      const before = await f.db.routine.findUniqueOrThrow({ where: { id } });
      await f.service.mutateOwner(f.owner, randomUUID(), null, {
        action: "update",
        id,
        name: "Renamed",
        prompt: "New instructions",
      });
      const after = await f.db.routine.findUniqueOrThrow({ where: { id } });
      expect(after.nextRunAt).toEqual(before.nextRunAt);
      expect(after.scheduleAnchorAt).toEqual(before.scheduleAnchorAt);
      expect(after.triggerPresentation).toEqual(presentation);
      await f.service.runNowOwner(f.owner, id, randomUUID());
      const manual = await f.db.routine.findUniqueOrThrow({ where: { id } });
      expect(manual.nextRunAt).toEqual(before.nextRunAt);
      expect(manual.scheduleAnchorAt).toEqual(before.scheduleAnchorAt);
    } finally {
      await f.close();
    }
  }
);

test.skipIf(!url)(
  "dispatch catches up a year-old interval and recovers a stale committed occurrence once",
  async () => {
    const f = await fixture();
    try {
      const id = await f.create({ type: "cron", schedule: "@every 5m" }, true);
      const anchor = new Date("2025-01-01T00:00:00Z"),
        scheduledFor = new Date("2025-01-01T00:05:00Z"),
        now = new Date("2026-01-01T00:02:00Z");
      await f.db.routine.update({
        where: { id },
        data: { nextRunAt: scheduledFor, scheduleAnchorAt: anchor },
      });
      expect(await f.service.dispatchDue(now)).toBe(1);
      expect(
        (await f.db.routine.findUniqueOrThrow({ where: { id } })).nextRunAt?.toISOString()
      ).toBe("2026-01-01T00:05:00.000Z");
      await f.db.routine.update({ where: { id }, data: { nextRunAt: scheduledFor } });
      expect(await f.service.dispatchDue(now)).toBe(0);
      expect(await f.db.routineExecution.count({ where: { routineId: id } })).toBe(1);
      expect(
        (await f.db.routine.findUniqueOrThrow({ where: { id } })).nextRunAt?.toISOString()
      ).toBe("2026-01-01T00:05:00.000Z");
    } finally {
      await f.close();
    }
  }
);

test.skipIf(!url)(
  "timezone change recalculates floating listeners behind intervals without shifting interval phase",
  async () => {
    const f = await fixture();
    try {
      const id = await f.create({
        type: "group",
        listeners: [
          { type: "cron", schedule: "@every 24h" },
          { type: "cron", schedule: "0 9 * * *" },
        ],
      });
      const now = new Date("2026-01-01T08:00:00Z"),
        anchor = new Date("2026-01-01T08:00:00Z");
      await f.db.routine.update({
        where: { id },
        data: { scheduleAnchorAt: anchor, nextRunAt: new Date("2026-01-01T09:00:00Z") },
      });
      await f.db.$transaction((tx) => followUserTimeZone(tx, "America/New_York", now));
      expect(
        (await f.db.routine.findUniqueOrThrow({ where: { id } })).nextRunAt?.toISOString()
      ).toBe("2026-01-01T14:00:00.000Z");
    } finally {
      await f.close();
    }
  }
);

test.skipIf(!url)(
  "initial zone migration pins floating listeners to installation zone rather than a pinned first listener",
  async () => {
    const f = await fixture();
    try {
      const first = await f.create({
        type: "group",
        listeners: [
          { type: "cron", schedule: "CRON_TZ=Asia/Tokyo 0 3 * * *" },
          { type: "cron", schedule: "0 9 * * *" },
        ],
      });
      const second = await f.create({
        type: "group",
        listeners: [
          { type: "cron", schedule: "@every 24h" },
          { type: "cron", schedule: "0 9 * * *" },
        ],
      });
      await f.db.$transaction((tx) => pinRoutinesToScheduledZone(tx, async () => {}));
      for (const id of [first, second]) {
        const saved = await f.db.routine.findUniqueOrThrow({ where: { id } });
        expect(saved.trigger).toMatchObject({
          listeners: [expect.anything(), { type: "cron", schedule: "CRON_TZ=UTC 0 9 * * *" }],
        });
      }
      expect((await f.db.routine.findUniqueOrThrow({ where: { id: second } })).scheduleKind).toBe(
        "interval"
      );
    } finally {
      await f.close();
    }
  }
);

test.skipIf(!url)(
  "queued bot event coalescing retains the execution's saved prompt revision",
  async () => {
    const f = await fixture();
    try {
      const id = await f.create({ type: "webhook" }, true);
      const event = (suffix: string) => ({
        id: `regression-${suffix}`,
        source: "webhook",
        kind: "webhook",
        text: "payload",
      });
      const first = await f.service.dispatchEvent({ kind: "bot", id: f.botId }, event("first"));
      await f.service.mutate(f.botId, randomUUID(), null, {
        action: "update",
        id,
        prompt: "Different later instructions",
      });
      await f.service.dispatchEvent({ kind: "bot", id: f.botId }, event("second"));
      const execution = await f.db.routineExecution.findUniqueOrThrow({
        where: { id: first[0]!.id },
        include: { routineRevision: true, run: true },
      });
      const message = await f.db.message.findUniqueOrThrow({
        where: { id: execution.run!.userMessageId },
      });
      expect(execution.routineRevision.prompt).toBe("Saved instructions");
      expect(message.content).toContain("Saved instructions");
      expect(message.content).not.toContain("Different later instructions");
    } finally {
      await f.close();
    }
  }
);

test.skipIf(!url)("a UUID-shaped alias cannot hijack an existing routine UUID", async () => {
  const f = await fixture();
  try {
    const id = await f.create({ type: "cron", schedule: "@every 5m" });
    const alias = await f.create({ type: "cron", schedule: "@every 10m" });
    await f.db.routine.update({ where: { id: alias }, data: { slug: id } });
    expect((await f.service.detailOwner(f.owner, id)).id).toBe(id);
    await f.service.mutateOwner(f.owner, randomUUID(), null, {
      action: "update",
      id,
      prompt: "Intended update",
    });
    expect((await f.db.routine.findUniqueOrThrow({ where: { id } })).prompt).toBe(
      "Intended update"
    );
    expect((await f.db.routine.findUniqueOrThrow({ where: { id: alias } })).prompt).toBe(
      "Saved instructions"
    );
  } finally {
    await f.close();
  }
});

test.skipIf(!url)(
  "a broken event destination does not block healthy listeners and retries stay idempotent",
  async () => {
    const f = await fixture();
    try {
      await f.create({ type: "webhook" }, true);
      const healthy = await f.create({ type: "webhook" });
      await f.db.channel.update({ where: { id: f.channelId }, data: { archivedAt: new Date() } });
      const event = { id: randomUUID(), source: "webhook", kind: "webhook", text: "payload" };
      await expect(f.service.dispatchEventToAll(event)).rejects.toMatchObject({
        code: "routine_channel_unavailable",
      });
      expect(await f.db.routineExecution.count({ where: { routineId: healthy } })).toBe(1);
      await expect(f.service.dispatchEventToAll(event)).rejects.toMatchObject({
        code: "routine_channel_unavailable",
      });
      expect(await f.db.routineExecution.count({ where: { routineId: healthy } })).toBe(1);
    } finally {
      await f.close();
    }
  }
);

test.skipIf(!url)(
  "post-commit projection errors do not mark successful dispatch failed or block other routines",
  async () => {
    const f = await fixture();
    try {
      let failWrites = false;
      const service = new RoutineService(f.db, f.messaging, {
        writeRoutine: async () => {
          if (failWrites) throw new Error("Projection unavailable");
        },
        deleteRoutine: async () => {},
      });
      const ids = [];
      for (let index = 0; index < 2; index += 1) {
        const created = await service.mutate(f.botId, randomUUID(), null, {
          action: "create",
          name: `Projection ${index}`,
          prompt: "Instructions",
          schedule: "@every 5m",
        });
        ids.push(String(created.id));
      }
      const now = new Date();
      await f.db.routine.updateMany({
        where: { id: { in: ids } },
        data: { nextRunAt: new Date(now.getTime() - 1) },
      });
      failWrites = true;
      expect(await service.dispatchDue(now)).toBe(2);
      expect(
        await f.db.routineExecution.count({ where: { routineId: { in: ids }, status: "queued" } })
      ).toBe(2);
      expect(
        await f.db.routineExecution.count({ where: { routineId: { in: ids }, status: "failed" } })
      ).toBe(0);
    } finally {
      await f.close();
    }
  }
);

test.skipIf(!url)(
  "legacy interval dispatch preserves a pre-upgrade edit's phase before its first run",
  async () => {
    const f = await fixture();
    try {
      const id = await f.create({ type: "cron", schedule: "@every 5m" }, true);
      await f.db.routine.update({
        where: { id },
        data: {
          createdAt: new Date("2026-01-01T00:00:00Z"),
          scheduleAnchorAt: null,
          nextRunAt: new Date("2026-01-01T00:17:00Z"),
        },
      });
      expect(await f.service.dispatchDue(new Date("2026-01-01T00:18:00Z"))).toBe(1);
      expect(
        (await f.db.routine.findUniqueOrThrow({ where: { id } })).nextRunAt?.toISOString()
      ).toBe("2026-01-01T00:22:00.000Z");
    } finally {
      await f.close();
    }
  }
);
