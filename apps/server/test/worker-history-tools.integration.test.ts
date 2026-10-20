import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "@openteam/messaging";
import { InternalToolService } from "../src/services/internal-tool-service";
import { DurableStateService } from "../src/update-state";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const databaseTest = databaseUrl ? test : test.skip;

databaseTest("workers never recall memory or read history; the parent does", async () => {
  const prisma = createPrismaClient(databaseUrl!);
  const root = await mkdtemp(join(tmpdir(), "worker-history-tools-"));
  const store = new AgentDataStore(prisma, { root: join(root, "data"), workspaceRoot: root });
  const botIds: string[] = [];
  const channelIds: string[] = [];
  try {
    const parent = await prisma.bot.create({ data: { name: "History parent", status: "active", onboardingStatus: "completed", defaultDirectory: root, conversation: { create: {} } }, include: { conversation: true } });
    botIds.push(parent.id);
    const channel = await prisma.channel.create({ data: { kind: "bot_dm", name: "main", directKey: `bot:${parent.id}`, members: { create: { botId: parent.id, ordinal: 0 } } } });
    channelIds.push(channel.id);
    await store.initializeBot(parent.id);
    const memory = await store.resolveMemoryConversation(parent.id, channel.id);
    const parentRun = await prisma.run.create({ data: { botId: parent.id, conversationId: parent.conversation!.id, channelId: channel.id, userMessageId: crypto.randomUUID(), status: "running", memoryConversationId: memory.id } });
    const state = new DurableStateService(prisma, root, async () => {}, {} as never, store, {} as never);
    const service = new InternalToolService(prisma, { agentData: store } as never, state, async () => {}, {} as never, {} as never, {} as never, {} as never);
    const call = (run: { id: string; botId: string; conversationId: string; channelId: string | null }, tool: string, args: unknown) =>
      Effect.runPromise(service.execute({ runId: run.id, botId: run.botId, conversationId: run.conversationId, channelId: run.channelId!, deliveryId: null, tool, arguments: args, callId: crypto.randomUUID() }));
    await call(parentRun, "UpdateMemory", { action: "write", tier: "profile", fact: "VERMILION invoices go to Dana." });

    const worker = async (subagentType: string) => {
      const child = await prisma.bot.create({ data: { name: `${subagentType} worker`, status: "active", defaultDirectory: root, conversation: { create: {} } }, include: { conversation: true } });
      botIds.push(child.id);
      await prisma.subagent.create({ data: { parentBotId: parent.id, childBotId: child.id, parentRunId: parentRun.id, parentChannelId: channel.id, launchCallId: crypto.randomUUID(), description: "fixture", prompt: "WORKER_TASK", subagentType, outputPath: "/tmp/unused", status: "running" } });
      const task = await prisma.message.create({ data: { botId: child.id, conversationId: child.conversation!.id, role: "user", content: `${subagentType}_TASK` } });
      // Worker runs carry the channel the parent was working in.
      return prisma.run.create({ data: { botId: child.id, conversationId: child.conversation!.id, channelId: channel.id, userMessageId: task.id, status: "running" } });
    };
    // The parent passes the facts a task needs; workers don't search memory or history.
    expect(await call(parentRun, "RecallMemory", { query: "VERMILION" })).toContain("VERMILION invoices go to Dana.");
    for (const subagentType of ["knowledgeWork", "executor", "computerUse"]) {
      const run = await worker(subagentType);
      for (const tool of ["RecallMemory", "ReadTranscript", "ReadAgentActivity"]) {
        await expect(call(run, tool, tool === "RecallMemory" ? { query: "VERMILION" } : {})).rejects.toThrow("parent-agent only");
      }
    }
  } finally {
    await prisma.bot.deleteMany({ where: { id: { in: botIds } } });
    await prisma.channel.deleteMany({ where: { id: { in: channelIds } } });
    await prisma.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
