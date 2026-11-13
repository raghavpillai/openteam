// An isolated real-database routine fixture: a bot with its DM, real messaging and a routine service.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "../../src/agent-data";
import { AgentMessaging } from "../../src/index";
import { RoutineService } from "../../src/routines";

export async function createRoutineHarness() {
  assert(process.env.OPENTEAM_TEST_DATABASE_URL);
  const db = createPrismaClient(process.env.OPENTEAM_TEST_DATABASE_URL);
  const root = await mkdtemp(join(tmpdir(), "openteam-routines-"));
  const zone = await db.userTimeZoneSettings.findUnique({ where: { id: "global" } });
  await db.userTimeZoneSettings.upsert({
    where: { id: "global" },
    create: { id: "global", detected: "UTC" },
    update: { detected: "UTC", override: null },
  });
  /** A bot and its DM; `routine` (unless null) creates a disabled routine up front. */
  async function fixture(routine: Record<string, unknown> | null = { schedule: "@every 5m", enabled: false }) {
    const botId = randomUUID(), channelId = randomUUID(), conversationId = randomUUID();
    const groups: string[] = [];
    const store = new AgentDataStore(db, { root, workspaceRoot: root });
    const messaging = new AgentMessaging(db, { send: async () => "job", sendDebounced: async () => "job" } as never, store);
    messaging.isTimelineSessionActive = async () => false;
    const service = new RoutineService(db, messaging, store);
    messaging.onGroupRoutineSettled = (settled) => service.afterGroupExecution(settled);
    await db.bot.create({ data: { id: botId, name: "Routine fixture", status: "active", defaultDirectory: root, conversation: { create: { id: conversationId } } } });
    await db.channel.create({ data: { id: channelId, name: "Routine fixture", kind: "bot_dm", directKey: `bot:${botId}`, members: { create: { botId, ordinal: 0 } } } });
    const definition = (input: Record<string, unknown>) => ({ action: "create", name: "Routine", prompt: "Saved instructions", ...input }) as never;
    const create = async (input: Record<string, unknown> = { schedule: "@every 5m" }) =>
      String((await service.mutate(botId, randomUUID(), null, definition(input))).id);
    /** A group room with this bot as its only member, owning a routine with this trigger. */
    const group = async (trigger: unknown) => {
      const id = randomUUID();
      groups.push(id);
      await db.channel.create({ data: { id, kind: "group", name: "Routine room", members: { create: { botId, ordinal: 0 } } } });
      const created = await service.mutateOwner({ kind: "group", id }, randomUUID(), null, definition({ trigger }));
      return { channelId: id, owner: { kind: "group" as const, id }, routineId: String(created.id) };
    };
    const routineId = routine ? await create(routine) : "";
    const cleanup = async () => {
      await store.stopWatching();
      const ids = (await db.routine.findMany({ where: { OR: [{ botId }, { channelId: { in: groups } }] }, select: { id: true } })).map((r) => r.id);
      const executions = await db.routineExecution.findMany({ where: { routineId: { in: ids } }, select: { id: true } });
      await db.routineExecution.deleteMany({ where: { routineId: { in: ids } } });
      await db.routineRevision.deleteMany({ where: { routineId: { in: ids } } });
      await db.routine.deleteMany({ where: { id: { in: ids } } });
      await db.event.deleteMany({ where: { entityId: { in: [...ids, ...executions.map((e) => e.id)] } } });
      await db.channel.deleteMany({ where: { id: { in: [channelId, ...groups] } } });
      await db.bot.delete({ where: { id: botId } });
      await rm(store.botDirectory(botId), { recursive: true, force: true });
    };
    return {
      botId, channelId, conversationId, store, messaging, service, routineId, create, group, cleanup,
      read: (id = routineId) => db.routine.findUniqueOrThrow({ where: { id } }),
      path: (slug: string) => join(store.botDirectory(botId), "automations", slug, "automation.json"),
      sync: () => store.reconcileAutomationFilesBatch(null, 100),
    };
  }
  return {
    db,
    root,
    fixture,
    close: async () => {
      await db.userTimeZoneSettings.deleteMany({ where: { id: "global" } });
      if (zone) await db.userTimeZoneSettings.create({ data: zone });
      await db.$disconnect();
      await rm(root, { recursive: true, force: true });
    },
  };
}
export type RoutineFixture = Awaited<ReturnType<Awaited<ReturnType<typeof createRoutineHarness>>["fixture"]>>;
