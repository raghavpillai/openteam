import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentMessaging } from "../src/index";
import { followUserTimeZone, RoutineService } from "../src/routines";

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
