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
import { SubagentService } from "../src/services/subagent/service";
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

test.skipIf(!databaseUrl)("Task that passed its first parent check cannot launch after deletion commits", async () => {
  const prisma = createPrismaClient(databaseUrl!);
  const checked = deferred();
  const releaseCheck = deferred();
  const parent = await prisma.bot.create({ data: { name: "Parent", defaultDirectory: "/unused", status: "active", conversation: { create: {} } }, include: { conversation: true } });
  let outcome: Promise<any> | undefined;
  try {
    const run = await prisma.run.create({ data: { botId: parent.id, conversationId: parent.conversation!.id, userMessageId: crypto.randomUUID(), status: "running" } });
    const taskDb = new Proxy(prisma, { get(target, key) {
      if (key !== "bot") return (target as any)[key];
      return { findUnique: async (input: any) => {
        const activeSnapshot = await target.bot.findUnique(input);
        checked.resolve();
        await releaseCheck.promise;
        return activeSnapshot;
      } };
    } });
    const tasks = new SubagentService(taskDb, {} as never, {} as never, "/unused", async () => Response.json({ ok: true }), {
      loadInferenceSettings: async () => ({ providerId: "openai", modelId: "test", reasoning: "medium" }),
      loadTaskConfiguration: async () => ({ executorProfiles: [{ name: "high", description: "test", providerId: "openai", modelId: "test", reasoning: "medium" }], defaultExecutorProfile: "high" }),
    } as never) as any;
    outcome = tasks.launch({ botId: parent.id, runId: run.id }, { description: "Late", prompt: "Work", subagent_type: "executor" }).then(() => null, (error: any) => error);
    await checked.promise;
    const bots = new BotService(prisma, {} as never, "/unused", async () => Response.json({ ok: true }), fakeFiles as never);
    await Effect.runPromise(bots.archive(parent.id));
    releaseCheck.resolve();
    expect(await outcome).toMatchObject({ code: "parent_not_active" });
    expect(await prisma.subagent.count({ where: { parentBotId: parent.id } })).toBe(0);
  } finally {
    releaseCheck.resolve();
    await outcome;
    await prisma.bot.delete({ where: { id: parent.id } });
    await prisma.retiredAgent.deleteMany({ where: { id: parent.id } });
    await prisma.$disconnect();
  }
});

test.skipIf(!databaseUrl)("a restarted worker retries failed runtime cleanup after the directory has disappeared", async () => {
  const prisma = createPrismaClient(databaseUrl!);
  const bot = await prisma.bot.create({ data: { name: "Delete me", defaultDirectory: "/unused", status: "active", conversation: { create: {} } }, include: { conversation: true } });
  try {
    const run = await prisma.run.create({ data: { botId: bot.id, conversationId: bot.conversation!.id, userMessageId: crypto.randomUUID(), status: "running" } });
    await prisma.contextSession.create({ data: { botId: bot.id, scope: "home", scopeId: bot.conversation!.id } });
    const service = new BotService(prisma, {} as never, "/unused", async (path) => path.includes("agent-stores") ? Response.json({ ok: true }) : new Response("offline", { status: 503 }), fakeFiles as never);
    expect(await Effect.runPromise(service.archive(bot.id))).toEqual({ ok: true });
    expect(await prisma.contextSession.count({ where: { botId: bot.id } })).toBe(1);
    expect(await prisma.retiredAgent.findUnique({ where: { id: bot.id } })).toMatchObject({ cleanupPending: true, cleanupRunIds: [run.id] });
    // A second API request must not erase the queued cancellation now that the run is cancelled.
    await Effect.runPromise(service.archive(bot.id));
    expect(await prisma.retiredAgent.findUnique({ where: { id: bot.id } })).toMatchObject({ cleanupPending: true, cleanupRunIds: [run.id] });
    await prisma.retiredAgent.update({ where: { id: bot.id }, data: { nextCleanupAt: new Date(0) } });
    const calls: string[] = [];
    const worker = Object.create(WakeWorker.prototype) as any;
    Object.assign(worker, { prisma, agentData: fakeFiles, computerFetch: async (path: string) => {
      calls.push(path);
      if (path.endsWith("/cancel")) return new Response("Run is not actively executing", { status: 400 });
      return Response.json({ ok: true, removed: false });
    } });
    // No roster discovery state exists on this new worker instance.
    await worker.reconcileRetiredAgents();
    expect(await prisma.contextSession.count({ where: { botId: bot.id } })).toBe(0);
    expect(await prisma.retiredAgent.findUnique({ where: { id: bot.id } })).toMatchObject({ cleanupPending: false });
    expect(calls).toContain(`/v1/turns/${run.id}/cancel`);
    expect(calls).toContain(`/v1/bots/${bot.id}/background-shells/stop`);
    expect(calls).toContain(`/v1/screens/${bot.id}`);
    const completedCalls = calls.length;
    await worker.reconcileRetiredAgents();
    expect(calls).toHaveLength(completedCalls);
  } finally {
    await prisma.bot.delete({ where: { id: bot.id } });
    await prisma.retiredAgent.deleteMany({ where: { id: bot.id } });
    await prisma.$disconnect();
  }
});
