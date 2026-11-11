import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { Effect } from "effect";
import { BotAgentStore } from "../../computer/src/bot-agent-store";
import { WakeWorker } from "../../worker/src/worker";
import { BotService } from "../src/services/bot-service";
import { GroupAdministration } from "../src/services/channel/group-administration";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

test.skipIf(!databaseUrl)("deleting an executing agent cancels its parent and child runs before removing contexts", async () => {
  const prisma = createPrismaClient(databaseUrl!);
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  const calls: string[] = [];
  const observations: Array<{ archived: number; cancelled: number }> = [];
  try {
    const runs: string[] = [];
    for (const id of ids) {
      const bot = await prisma.bot.create({
        data: { id, name: "Delete running chat", defaultDirectory: "/workspace", status: "active", conversation: { create: {} } },
        include: { conversation: true },
      });
      const run = await prisma.run.create({ data: {
        botId: id, conversationId: bot.conversation!.id, userMessageId: crypto.randomUUID(), status: "running",
      } });
      runs.push(run.id);
      await prisma.contextSession.create({ data: { botId: id, scope: "home", scopeId: bot.conversation!.id } });
    }
    await prisma.subagent.create({ data: {
      parentBotId: ids[0]!, childBotId: ids[1]!, parentRunId: runs[0]!,
      parentChannelId: crypto.randomUUID(), launchCallId: crypto.randomUUID(),
      description: "Child", prompt: "Work", subagentType: "executor", status: "running", currentRunId: runs[1]!,
      outputPath: "/unused/child-output.jsonl",
    } });
    const service = new BotService(prisma, {} as never, "/workspace", async (path) => {
      calls.push(path);
      observations.push({
        archived: await prisma.bot.count({ where: { id: { in: ids }, status: "archived" } }),
        cancelled: await prisma.run.count({ where: { id: { in: runs }, status: "cancelled" } }),
      });
      return Response.json({ ok: true });
    }, { deleteAgentFiles: async () => {}, repairActiveAgentAfterDeletion: async () => {} } as never);
    expect(await Effect.runPromise(service.archive(ids[0]!))).toEqual({ ok: true });
    expect(observations.every(({ archived, cancelled }) => archived === 2 && cancelled === 2)).toBe(true);
    for (const run of runs) expect(calls).toContain(`/v1/turns/${run}/cancel`);
    for (const id of ids) expect(calls).toContain(`/v1/bots/${id}/background-shells/stop`);
    const lastCancel = Math.max(...calls.map((path, index) => path.endsWith("/cancel") ? index : -1));
    const firstContextDelete = calls.findIndex((path) => path.includes("context-sessions"));
    expect(lastCancel).toBeLessThan(firstContextDelete);
    expect(await prisma.contextSession.count({ where: { botId: { in: ids } } })).toBe(0);
    expect(await prisma.retiredAgent.count({ where: { id: { in: ids } } })).toBe(2);
    expect(await prisma.subagent.findFirst({ where: { parentBotId: ids[0] } })).toMatchObject({ status: "stopped" });
  } finally {
    await prisma.bot.deleteMany({ where: { id: { in: ids } } });
    await prisma.retiredAgent.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  }
});

test.skipIf(!databaseUrl)("a deleted group cannot return after event pruning or a failed directory cleanup", async () => {
  const prisma = createPrismaClient(databaseUrl!);
  const root = await mkdtemp(join(tmpdir(), "openteam-chat-delete-"));
  const stores = new BotAgentStore(root, join(root, "retired"));
  const botId = crypto.randomUUID();
  const groupId = crypto.randomUUID();
  try {
    await prisma.bot.create({ data: { id: botId, name: "Member", defaultDirectory: root, status: "active" } });
    await prisma.channel.create({ data: { id: groupId, kind: "group", name: "Delete room", members: { create: { botId, ordinal: 0 } } } });
    await stores.openForWake(groupId);
    await writeFile(join(stores.agentDirectory(groupId), "group.json"), JSON.stringify({ memberIds: [botId] }));
    const groups = new GroupAdministration(prisma, {} as never, root, async () => { throw new Error("offline"); });
    expect(await Effect.runPromise(groups.deleteGroup(groupId))).toEqual({ deleted: true, channelId: groupId });
    await prisma.event.deleteMany({ where: { entityId: groupId } });
    const records = await stores.listAgentDirectories();
    expect(records).toHaveLength(1);
    let deletes = 0;
    let snapshots = 0;
    const worker = Object.create(WakeWorker.prototype) as any;
    Object.assign(worker, {
      prisma, workspaceRoot: root, agentStoreEtag: null, pendingAgentStoreRecords: new Map(),
      computerFetch: async (_path: string, init: RequestInit) => {
        if (init.method === "DELETE") {
          if (++deletes === 1) return new Response("offline", { status: 503 });
          return Response.json({ ok: true, removed: await stores.deleteAgent(groupId) });
        }
        return ++snapshots === 1
          ? Response.json({ agents: records }, { headers: { etag: '"unchanged"' } })
          : new Response(null, { status: 304 });
      },
    });
    expect(await worker.reconcileAgentStores(false)).toBe(0);
    expect(await worker.reconcileAgentStores(false)).toBe(0);
    expect(deletes).toBe(2);
    expect(await prisma.channel.findUnique({ where: { id: groupId } })).toBeNull();
    expect(await stores.listAgentDirectories()).toEqual([]);
    expect(stores.hasLiveHandle(groupId)).toBe(false);
  } finally {
    await stores.closeAll();
    await prisma.channel.deleteMany({ where: { id: groupId } });
    await prisma.bot.deleteMany({ where: { id: botId } });
    await prisma.retiredAgent.deleteMany({ where: { id: groupId } });
    await prisma.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
});
