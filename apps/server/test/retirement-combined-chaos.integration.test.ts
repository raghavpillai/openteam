import { expect, test } from "bun:test";
import { Effect } from "effect";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient, type Bot, type Conversation } from "@openteam/db";
import { AgentDataStore, AgentMessaging, type ToolContext } from "@openteam/messaging";
import { BotService } from "../src/services/bot-service";
import { WakeWorker } from "../../worker/src/worker";
import { BotAgentStore } from "../../computer/src/bot-agent-store";
import { NativeToolExecutor } from "../../computer/src/native-tool-executor";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;

for (const seed of [1, 7, 29, 101, 284]) {
  test.skipIf(!url || process.platform === "win32")(`retirement survives concurrent late work and a cleanup outage, seed ${seed}`, async () => {
    const db = createPrismaClient(url!);
    const root = await mkdtemp(join(tmpdir(), "retirement-combined-chaos-"));
    await chmod(root, 0o755);
    const stores = new BotAgentStore(root, join(root, "retired"));
    const tools = new NativeToolExecutor({ agentDir: root, controlToken: "fixture" });
    const data = new AgentDataStore(db, { root, workspaceRoot: root });
    const boss = { send: async () => null, sendDebounced: async () => null };
    const messaging = new AgentMessaging(db, boss as never, data);
    const bots: Array<Bot & { conversation: Conversation | null }> = [];
    const channels: string[] = [];
    const jobs: Array<{ id: string; botId: string }> = [];
    const replicas: ReturnType<typeof createPrismaClient>[] = [];
    const activeRuns = new Set<string>();
    const initialRuns: string[] = [];
    let offline = true;
    let randomState = seed;
    const jitter = async () => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      await Bun.sleep(randomState % 5);
    };
    const status = async (job: typeof jobs[number], wait = 0) =>
      (await tools.awaitShell({ shell_id: job.id, block_until_ms: wait }, undefined, job.botId)).details.status;
    const computer = async (path: string, init: RequestInit) => {
      await jitter();
      if (offline) return new Response("injected cleanup outage", { status: 503 });
      const run = path.match(/^\/v1\/turns\/([^/]+)\/cancel$/)?.[1];
      if (run) return activeRuns.delete(run) ? Response.json({ ok: true }) : new Response("Run is not actively executing", { status: 400 });
      const context = path.match(/^\/v1\/context-sessions\/([^/]+)$/)?.[1];
      if (context) {
        const owner = await db.contextSession.findUnique({ where: { id: context }, select: { botId: true } });
        const index = bots.findIndex(bot => bot.id === owner?.botId);
        if (index >= 0 && activeRuns.has(initialRuns[index]!)) return new Response("context still active", { status: 409 });
      }
      const scope = path.match(/^\/v1\/bots\/([^/]+)\/background-shells\/stop$/)?.[1];
      if (scope) tools.stopBackgroundShells(scope);
      const store = path.match(/^\/v1\/agent-stores\/([^/]+)$/)?.[1];
      if (store && init.method === "DELETE") await stores.deleteAgent(store);
      return Response.json({ ok: true });
    };
    try {
      for (let index = 0; index < 3; index++) {
        const bot = await db.bot.create({ data: { name: `Chaos ${index}`, status: "active", defaultDirectory: root, conversation: { create: {} } }, include: { conversation: true } });
        bots.push(bot);
        const channel = await db.channel.create({ data: { kind: "bot_dm", name: bot.name, directKey: `bot:${bot.id}`, members: { create: { botId: bot.id, ordinal: 0 } } } });
        channels.push(channel.id);
        await db.contextSession.create({ data: { botId: bot.id, scope: "home", scopeId: bot.conversation!.id } });
        const run = await db.run.create({ data: { botId: bot.id, conversationId: bot.conversation!.id, channelId: channel.id, userMessageId: crypto.randomUUID(), status: "running" } });
        initialRuns.push(run.id); activeRuns.add(run.id);
        await db.inboxEvent.create({ data: { botId: bot.id, conversationId: run.conversationId, runId: run.id, idempotencyKey: crypto.randomUUID(), type: "user.message", status: "processing", payload: { content: "Work", clientId: crypto.randomUUID() } } });
        await stores.openForWake(bot.id);
        await writeFile(join(stores.agentDirectory(bot.id), "keep.txt"), "healthy sentinel");
        const shell = await tools.shell({ command: "sleep 30", block_until_ms: 0 }, root, undefined, undefined, bot.id);
        jobs.push({ id: String(shell.details?.shellId), botId: bot.id });
      }
      const targets = bots.slice(0, 2).map(bot => bot.id);
      const survivor = bots[2]!;
      const source: ToolContext = { botId: survivor.id, runId: initialRuns[2]!, conversationId: survivor.conversation!.id, channelId: channels[2]!, deliveryId: null, origin: "user", callId: "", isFork: false, replyToMessageId: null };
      const service = new BotService(db, boss as never, root, computer, data);
      const operations: Array<Promise<unknown>> = [];
      for (const id of targets) {
        for (let index = 0; index < 6; index++) operations.push((async () => { await jitter(); return Effect.runPromise(service.archive(id)); })());
        for (let index = 0; index < 8; index++) {
          operations.push((async () => { await jitter(); return messaging.sendToAgent({ ...source, callId: crypto.randomUUID() }, { target_id: id, message: "Late peer work" }); })());
          operations.push((async () => { await jitter(); return messaging.completeShell({ id: `callback-${index % 2}`, scope: id, exitCode: 0, outputPath: "/unused/finished.log" }); })());
        }
      }
      const settled = await Promise.allSettled(operations);
      expect(settled.filter(result => result.status === "rejected")).toEqual([]);
      expect(await db.bot.count({ where: { id: { in: targets }, status: "archived" } })).toBe(2);
      expect(await db.run.count({ where: { botId: { in: targets }, status: { in: ["queued", "running"] } } })).toBe(0);
      expect(await db.inboxEvent.count({ where: { botId: { in: targets }, status: { in: ["pending", "processing"] } } })).toBe(0);
      expect(await db.retiredAgent.count({ where: { id: { in: targets }, cleanupPending: true } })).toBe(2);
      expect(await db.contextSession.count({ where: { botId: { in: targets } } })).toBe(2);
      for (const job of jobs) expect(await status(job)).toBe("running");

      // Fresh clients/worker instances recover solely from persisted cleanup records.
      offline = false;
      await db.retiredAgent.updateMany({ where: { id: { in: targets } }, data: { nextCleanupAt: new Date(0) } });
      const workers = Array.from({ length: 3 }, () => {
        const prisma = createPrismaClient(url!); replicas.push(prisma);
        return Object.assign(Object.create(WakeWorker.prototype), { prisma, computerFetch: computer, agentData: data });
      });
      await Promise.all(workers.map(worker => worker.reconcileRetiredAgents()));
      expect(await db.retiredAgent.count({ where: { id: { in: targets }, cleanupPending: true } })).toBe(0);
      expect(await db.contextSession.count({ where: { botId: { in: targets } } })).toBe(0);
      for (const [index, job] of jobs.entries()) {
        expect(await status(job, index < 2 ? 5000 : 0)).toBe(index < 2 ? "completed" : "running");
        if (index < 2) {
          expect(stores.hasLiveHandle(job.botId)).toBe(false);
          expect(await stat(stores.agentDirectory(job.botId)).catch(() => null)).toBeNull();
          expect(activeRuns.has(initialRuns[index]!)).toBe(false);
        }
      }
      expect(await db.bot.findUniqueOrThrow({ where: { id: survivor.id } })).toMatchObject({ status: "active" });
      expect(await db.run.findUniqueOrThrow({ where: { id: initialRuns[2]! } })).toMatchObject({ status: "running" });
      expect(await db.contextSession.count({ where: { botId: survivor.id } })).toBe(1);
      expect(await readFile(join(stores.agentDirectory(survivor.id), "keep.txt"), "utf8")).toBe("healthy sentinel");
      expect(activeRuns.has(initialRuns[2]!)).toBe(true);
    } finally {
      for (const bot of bots) tools.stopBackgroundShells(bot.id);
      await Promise.all(jobs.map(job => status(job, 5000).catch(() => {})));
      await stores.closeAll();
      await Promise.all(replicas.map(prisma => prisma.$disconnect()));
      await db.bot.deleteMany({ where: { id: { in: bots.map(bot => bot.id) } } });
      await db.channel.deleteMany({ where: { id: { in: channels } } });
      await db.retiredAgent.deleteMany({ where: { id: { in: bots.map(bot => bot.id) } } });
      await db.$disconnect(); await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
}
