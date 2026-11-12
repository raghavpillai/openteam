import { afterEach, expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "../src/agent-data";
import { parseAutomationFile } from "../src/automation-files";
import { RoutineService } from "../src/routines";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;
const at = new Date("2026-11-12T17:00:00Z");
afterEach(() => setSystemTime());

async function fixture(sharedRoot?: string) {
  const db = createPrismaClient(databaseUrl!);
  const root = sharedRoot ?? (await mkdtemp(join(tmpdir(), "openteam-routine-sync-fix-")));
  const botId = randomUUID(),
    channelId = randomUUID(),
    conversationId = randomUUID();
  const store = new AgentDataStore(db, { root, workspaceRoot: root });
  await db.userTimeZoneSettings.upsert({
    where: { id: "global" },
    create: { id: "global", detected: "UTC" },
    update: { detected: "UTC", override: null },
  });
  await db.bot.create({
    data: {
      id: botId,
      name: "Sync regression",
      status: "active",
      defaultDirectory: root,
      conversation: { create: { id: conversationId } },
    },
  });
  await db.channel.create({
    data: { id: channelId, kind: "bot_dm", name: "Sync regression", directKey: `bot:${botId}` },
  });
  const host = {
    isTimelineSessionActive: async () => false,
    enqueueWake: async (tx: any) => ({
      run: await tx.run.create({
        data: { botId, conversationId, channelId, userMessageId: randomUUID(), origin: "routine" },
      }),
    }),
  };
  const service = new RoutineService(db, host, store);
  const create = async (input: Record<string, unknown> = {}, callId = randomUUID()) =>
    service.mutate(botId, callId, null, {
      action: "create",
      name: "Schedule",
      prompt: "Saved instructions",
      schedule: "@every 5m",
      ...input,
    } as never);
  const read = (id: string) => db.routine.findUniqueOrThrow({ where: { id } });
  const path = (slug: string) =>
    join(store.botDirectory(botId), "automations", slug, "automation.json");
  const sync = () => store.reconcileAutomationFilesBatch(null, 100);
  const close = async () => {
    await store.stopWatching();
    const ids = (await db.routine.findMany({ where: { botId }, select: { id: true } })).map(
      (r) => r.id
    );
    const executionIds = (
      await db.routineExecution.findMany({
        where: { routineId: { in: ids } },
        select: { id: true },
      })
    ).map((r) => r.id);
    await db.routineExecution.deleteMany({ where: { routineId: { in: ids } } });
    await db.routineRevision.deleteMany({ where: { routineId: { in: ids } } });
    await db.routine.deleteMany({ where: { id: { in: ids } } });
    await db.event.deleteMany({ where: { entityId: { in: [...ids, ...executionIds] } } });
    await db.bot.delete({ where: { id: botId } });
    await db.channel.delete({ where: { id: channelId } });
    await db.$disconnect();
    if (!sharedRoot) await rm(root, { recursive: true, force: true });
  };
  return { db, root, botId, store, service, create, read, path, sync, close };
}

test("file parser schedules every listener, validates later listeners and keeps long accepted cron text", async () => {
  setSystemTime(at);
  const root = await mkdtemp(join(tmpdir(), "openteam-routine-parser-fix-"));
  const path = join(root, "automation.json");
  const parse = async (fields: Record<string, unknown>) => {
    const text = JSON.stringify({
      name: "Parser",
      prompt: "Instructions",
      createdAt: at.getTime(),
      ...fields,
    });
    await writeFile(path, text);
    return parseAutomationFile(path, text, "America/New_York");
  };
  try {
    const parsed = await parse({
      trigger: {
        type: "group",
        listeners: [
          { type: "cron", schedule: "CRON_TZ=America/New_York 0 3 * * *" },
          { type: "cron", schedule: "CRON_TZ=America/New_York 9 18 * * *" },
        ],
      },
    });
    expect(parsed.nextRunAt?.toISOString()).toBe("2026-11-12T23:09:00.000Z");
    await expect(
      parse({
        trigger: {
          type: "group",
          listeners: [
            { type: "cron", schedule: "0 3 * * *" },
            { type: "cron", schedule: "* * * * *" },
          ],
        },
      })
    ).rejects.toThrow();
    await expect(
      parse({
        schedule: "0 3 * * *",
        trigger: {
          type: "group",
          listeners: [{ type: "cron", schedule: "0 3 * * *" }, { type: "invalid" }],
        },
      })
    ).rejects.toThrow();
    const longCron = [
      Array.from({ length: 12 }, (_, i) => i * 5).join(","),
      Array.from({ length: 24 }, (_, i) => i).join(","),
      Array.from({ length: 31 }, (_, i) => i + 1).join(","),
      "*",
      "*",
    ].join(" ");
    expect((await parse({ trigger: { type: "cron", schedule: longCron } })).trigger.schedule).toBe(
      longCron
    );
    await mkdir(join(root, "runs.json"));
    const brokenHistory = await parse({ schedule: "0 8 * * *" });
    expect(brokenHistory.historyError).toBeString();
    expect(brokenHistory.enabled).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

integration(
  "unchanged file sync preserves a second-listener dispatch and committed run history",
  async () => {
    setSystemTime(at);
    const f = await fixture();
    try {
      const created = await f.create({
        schedule: undefined,
        trigger: {
          type: "group",
          listeners: [
            { type: "cron", schedule: "CRON_TZ=America/New_York 0 3 * * *" },
            { type: "cron", schedule: "CRON_TZ=America/New_York 9 18 * * *" },
          ],
        },
      });
      const id = String(created.id),
        before = await f.read(id);
      const staleDefinition = await readFile(f.path(before.slug), "utf8");
      await f.sync();
      expect((await f.read(id)).nextRunAt?.toISOString()).toBe("2026-11-12T23:09:00.000Z");
      setSystemTime(new Date("2026-11-12T23:09:00Z"));
      expect(await f.service.dispatchDue(new Date())).toBe(1);
      const dispatched = await f.read(id);
      await writeFile(f.path(before.slug), staleDefinition);
      await writeFile(join(f.path(before.slug), "..", "runs.json"), "[]");
      await f.sync();
      const synced = await f.read(id);
      expect(synced.nextRunAt).toEqual(dispatched.nextRunAt);
      expect(synced.lastRunAt).toEqual(dispatched.lastRunAt);
      expect(synced.runLedger).toEqual(dispatched.runLedger);
      expect(await f.service.dispatchDue(new Date())).toBe(0);
      expect(await f.db.routineExecution.count({ where: { routineId: id } })).toBe(1);
    } finally {
      await f.close();
    }
  }
);

integration(
  "stale projections cannot undo edits or pauses and authored prompt edits retain interval cadence",
  async () => {
    setSystemTime(at);
    const f = await fixture();
    try {
      const created = await f.create(),
        id = String(created.id),
        before = await f.read(id);
      const stale = await readFile(f.path(before.slug), "utf8");
      setSystemTime(new Date(at.getTime() + 60_000));
      await f.service.mutate(f.botId, randomUUID(), null, {
        action: "update",
        id,
        prompt: "Updated instructions",
      });
      await writeFile(f.path(before.slug), stale);
      await f.sync();
      expect((await f.read(id)).prompt).toBe("Updated instructions");
      expect((await f.read(id)).nextRunAt).toEqual(before.nextRunAt);
      await f.service.mutate(f.botId, randomUUID(), null, { action: "pause", id });
      await writeFile(f.path(before.slug), stale);
      await f.sync();
      expect((await f.read(id)).enabled).toBe(false);
      expect((await f.read(id)).nextRunAt).toBeNull();
      // Editing the authored instructions remains supported even with a stale marker.
      const edited = JSON.parse(stale);
      edited.prompt = "Deliberate file edit";
      edited.enabled = false;
      await writeFile(f.path(before.slug), JSON.stringify(edited));
      await f.sync();
      expect((await f.read(id)).prompt).toBe("Deliberate file edit");
    } finally {
      await f.close();
    }
  }
);

integration(
  "invalid definitions stay visible and disabled, while broken history leaves valid routines enabled",
  async () => {
    setSystemTime(at);
    const f = await fixture();
    try {
      const first = await f.create(),
        second = await f.create({ name: "Healthy" });
      const invalid = await f.read(String(first.id)),
        healthy = await f.read(String(second.id));
      const definition = await readFile(f.path(invalid.slug), "utf8");
      await writeFile(f.path(invalid.slug), "{ invalid");
      const historyPath = join(f.path(healthy.slug), "..", "runs.json");
      await rm(historyPath);
      await mkdir(historyPath);
      const result = await f.sync();
      expect(result.warnings).toHaveLength(2);
      expect(await f.read(invalid.id)).toMatchObject({
        enabled: false,
        deletedAt: null,
        nextRunAt: null,
      });
      expect((await f.read(healthy.id)).enabled).toBe(true);
      setSystemTime(new Date(at.getTime() + 5 * 60_000));
      expect(await f.service.dispatchDue(new Date())).toBe(1);
      await writeFile(f.path(invalid.slug), definition);
      await f.sync();
      expect((await f.read(invalid.id)).enabled).toBe(true);
    } finally {
      await f.close();
    }
  }
);
