// Isolated real-database fixture for routine regression tests.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "../../../../packages/db/src/index";
import {
  AgentDataStore,
  AgentMessaging,
  RoutineService,
} from "../../../../packages/messaging/src/index";
import { WakeWorker } from "../../src/worker";

export async function createRoutineHarness() {
  assert(process.env.OPENTEAM_TEST_DATABASE_URL);
  const db = createPrismaClient(process.env.OPENTEAM_TEST_DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "openteam-275-final-sweep-"));
  await db.userTimeZoneSettings.upsert({
    where: { id: "global" },
    create: { id: "global", detected: "UTC" },
    update: { detected: "UTC", override: null },
  });
  async function fixture(
    input: { schedule?: string; trigger?: unknown; presentation?: unknown; enabled?: boolean } = {
      schedule: "@every 5m",
    }
  ) {
    const botId = randomUUID(),
      channelId = randomUUID(),
      conversationId = randomUUID();
    const groups: string[] = [];
    const store = new AgentDataStore(db, { root, workspaceRoot: root });
    const messaging = new AgentMessaging(
      db,
      { send: async () => "job", sendDebounced: async () => "job" } as never,
      store
    );
    messaging.isTimelineSessionActive = async () => false;
    const service = new RoutineService(db, messaging, store);
    messaging.onGroupRoutineSettled = (settled) => service.afterGroupExecution(settled);
    const worker: any = Object.assign(Object.create(WakeWorker.prototype), {
      prisma: db,
      messaging,
      routines: service,
      agentData: store,
      workspaceRoot: root,
    });
    await db.bot.create({
      data: {
        id: botId,
        name: "Final audit",
        status: "active",
        defaultDirectory: root,
        conversation: { create: { id: conversationId } },
      },
    });
    await db.channel.create({
      data: {
        id: channelId,
        name: "Final audit",
        kind: "bot_dm",
        directKey: `bot:${botId}`,
        members: { create: { botId, ordinal: 0 } },
      },
    });
    const created = await service.mutate(botId, randomUUID(), null, {
      action: "create",
      name: "Final audit",
      prompt: "Run saved instructions",
      enabled: false,
      ...input,
    });
    const routineId = String(created.id);
    const read = () => db.routine.findUniqueOrThrow({ where: { id: routineId } });
    const sync = () => store.reconcileAutomationFilesBatch(null, 100);
    const group = async (trigger: Record<string, unknown>) => {
      const id = randomUUID();
      groups.push(id);
      await db.channel.create({
        data: {
          id,
          kind: "group",
          name: "Final audit room",
          members: { create: { botId, ordinal: 0 } },
        },
      });
      const result = await service.mutateOwner({ kind: "group", id }, randomUUID(), null, {
        action: "create",
        name: "Final audit group",
        prompt: "Run saved instructions",
        trigger,
      });
      return { channelId: id, routineId: String(result.id) };
    };
    const cleanup = async () => {
      await store.stopWatching();
      const rows = await db.routine.findMany({
        where: { OR: [{ botId }, { channelId: { in: groups } }] },
        select: { id: true },
      });
      const ids = rows.map((r) => r.id);
      const executions = await db.routineExecution.findMany({
        where: { routineId: { in: ids } },
        select: { id: true },
      });
      await db.routineExecution.deleteMany({ where: { routineId: { in: ids } } });
      await db.routineRevision.deleteMany({ where: { routineId: { in: ids } } });
      await db.routine.deleteMany({ where: { id: { in: ids } } });
      await db.event.deleteMany({
        where: { entityId: { in: [...ids, ...executions.map((e) => e.id)] } },
      });
      await db.channel.deleteMany({ where: { id: { in: [channelId, ...groups] } } });
      await db.bot.delete({ where: { id: botId } });
      await rm(store.botDirectory(botId), { recursive: true, force: true });
    };
    return {
      botId,
      channelId,
      conversationId,
      store,
      messaging,
      service,
      worker,
      routineId,
      read,
      sync,
      group,
      cleanup,
    };
  }
  return {
    db,
    root,
    fixture,
    close: async () => {
      await db.$disconnect();
      await rm(root, { recursive: true, force: true });
    },
  };
}
