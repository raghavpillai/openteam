import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { Effect } from "effect";
import { BotAgentStore } from "../../computer/src/bot-agent-store";
import { WakeWorker } from "../../worker/src/worker";
import { BotService } from "../src/services/bot-service";
import { lockAgentLifecycle } from "@openteam/messaging";
import { GroupAdministration } from "../src/services/channel/group-administration";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

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


const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
};
const fakeFiles = { deleteAgentFiles: async () => {}, repairActiveAgentAfterDeletion: async () => {} };

test.skipIf(!databaseUrl)("archive includes a child whose launch commits while deletion waits for the lifecycle lock", async () => {
  const prisma = createPrismaClient(databaseUrl!);
  const parentId = crypto.randomUUID();
  const childId = crypto.randomUUID();
  const locked = deferred();
  const releaseLaunch = deferred();
  const archiveWaiting = deferred();
  let launch: Promise<unknown> | undefined;
  let archive: Promise<unknown> | undefined;
  try {
    await prisma.bot.create({ data: { id: parentId, name: "Parent", defaultDirectory: "/unused", status: "active" } });
    launch = prisma.$transaction(async (tx) => {
      await lockAgentLifecycle(tx, parentId);
      locked.resolve();
      await releaseLaunch.promise;
      const child = await tx.bot.create({ data: { id: childId, name: "Late child", defaultDirectory: "/unused", status: "active", conversation: { create: {} } }, include: { conversation: true } });
      const run = await tx.run.create({ data: { botId: childId, conversationId: child.conversation!.id, userMessageId: crypto.randomUUID(), status: "running" } });
      await tx.subagent.create({ data: { parentBotId: parentId, childBotId: childId, parentRunId: crypto.randomUUID(), parentChannelId: crypto.randomUUID(), launchCallId: crypto.randomUUID(), description: "Late child", prompt: "Work", subagentType: "executor", status: "running", currentRunId: run.id, outputPath: "/unused/child.jsonl" } });
    });
    await locked.promise;
    const archiveDb = new Proxy(prisma, { get(target, key) {
      if (key !== "$transaction") return (target as any)[key];
      return (work: any) => target.$transaction((tx) => work(new Proxy(tx, { get(inner, property) {
        if (property !== "$executeRaw") return (inner as any)[property];
        return async (strings: TemplateStringsArray, ...values: any[]) => {
          if (values[0] === `agent-lifecycle:${parentId}`) archiveWaiting.resolve();
          return inner.$executeRaw(strings, ...values);
        };
      } })));
    } });
    const service = new BotService(archiveDb, {} as never, "/unused", async () => Response.json({ ok: true }), fakeFiles as never);
    archive = Effect.runPromise(service.archive(parentId));
    await archiveWaiting.promise;
    releaseLaunch.resolve();
    await launch;
    await archive;
    expect((await prisma.bot.findUniqueOrThrow({ where: { id: childId } })).status).toBe("archived");
    expect(await prisma.run.count({ where: { botId: childId, status: "running" } })).toBe(0);
    expect(await prisma.retiredAgent.findUnique({ where: { id: childId } })).not.toBeNull();
  } finally {
    releaseLaunch.resolve();
    await Promise.allSettled([launch, archive]);
    await prisma.bot.deleteMany({ where: { id: { in: [parentId, childId] } } });
    await prisma.retiredAgent.deleteMany({ where: { id: { in: [parentId, childId] } } });
    await prisma.$disconnect();
  }
});
