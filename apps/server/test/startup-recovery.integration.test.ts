import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { recover } from "../src/services/startup-recovery";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

test.skipIf(!databaseUrl)(
  "a restart posts one chat notice per cut-off user turn and wakes no bot",
  async () => {
    const prisma = createPrismaClient(databaseUrl!);
    const botId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const wakes: unknown[] = [];
    const jobs: unknown[] = [];
    const boss = { send: async (...args: unknown[]) => void jobs.push(args) };
    const messaging = {
      enqueueWake: async (...args: unknown[]) => void wakes.push(args),
      enqueueBootstrap: async () => undefined,
      recoverRounds: async () => undefined,
    };
    try {
      await prisma.bot.create({
        data: {
          id: botId,
          name: "Restart notice",
          status: "active",
          onboardingStatus: "completed",
          defaultDirectory: "/tmp",
          conversation: { create: { id: conversationId } },
        },
      });
      const channel = await prisma.channel.create({
        data: {
          kind: "bot_dm",
          name: "Restart notice",
          directKey: `bot:${botId}`,
          members: { create: { botId, ordinal: 0 } },
        },
      });
      const run = (origin: "user" | "routine", status: "running" | "completed") =>
        prisma.run.create({
          data: {
            botId,
            conversationId,
            channelId: channel.id,
            origin,
            status,
            userMessageId: crypto.randomUUID(),
          },
        });
      const cutOff = await run("user", "running");
      const routine = await run("routine", "running");
      const finished = await run("user", "completed");

      const restart = () => recover(prisma, boss as never, messaging as never, async () => new Response());
      await restart();
      await restart();

      const notices = await prisma.channelMessage.findMany({ where: { channelId: channel.id } });
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        sender: "system",
        clientId: `restart-interrupted:${cutOff.id}`,
        content: "This reply was interrupted by a restart. Send your message again to continue.",
        metadata: { type: "event", event: { type: "turn-interrupted", reason: "restart", runId: cutOff.id } },
      });
      expect(wakes).toHaveLength(0);
      expect(jobs.filter((job) => (job as unknown[])[0] === "bot-wake")).toHaveLength(0);
      const statuses = await prisma.run.findMany({
        where: { id: { in: [cutOff.id, routine.id, finished.id] } },
        select: { id: true, status: true },
      });
      expect(Object.fromEntries(statuses.map((row) => [row.id, row.status]))).toEqual({
        [cutOff.id]: "interrupted",
        [routine.id]: "interrupted",
        [finished.id]: "completed",
      });
    } finally {
      await prisma.channel.deleteMany({ where: { directKey: `bot:${botId}` } });
      await prisma.bot.deleteMany({ where: { id: botId } });
      await prisma.$disconnect();
    }
  }
);

test.skipIf(!databaseUrl)(
  "a bot woken about its failed background Task gets no extra restart notice",
  async () => {
    const prisma = createPrismaClient(databaseUrl!);
    const parentId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const wakes: Array<{ botId: string; type: string }> = [];
    const messaging = {
      enqueueWake: async (_tx: unknown, input: { botId: string; type: string }) => void wakes.push(input),
      enqueueBootstrap: async () => undefined,
      recoverRounds: async () => undefined,
    };
    try {
      for (const id of [parentId, childId]) {
        await prisma.bot.create({
          data: {
            id,
            name: id === parentId ? "Task parent" : "Task child",
            status: "active",
            onboardingStatus: "completed",
            defaultDirectory: "/tmp",
            conversation: { create: {} },
          },
        });
      }
      const conversations = await prisma.conversation.findMany({ where: { botId: { in: [parentId, childId] } } });
      const conversationOf = (botId: string) => conversations.find((row) => row.botId === botId)!.id;
      const channel = await prisma.channel.create({
        data: {
          kind: "bot_dm",
          name: "Task parent",
          directKey: `bot:${parentId}`,
          members: { create: { botId: parentId, ordinal: 0 } },
        },
      });
      const parentRun = await prisma.run.create({
        data: { botId: parentId, conversationId: conversationOf(parentId), channelId: channel.id, origin: "user", status: "running", userMessageId: crypto.randomUUID() },
      });
      const childRun = await prisma.run.create({
        data: { botId: childId, conversationId: conversationOf(childId), origin: "agent", status: "running", userMessageId: crypto.randomUUID() },
      });
      const subagent = await prisma.subagent.create({
        data: {
          parentBotId: parentId,
          childBotId: childId,
          parentRunId: parentRun.id,
          parentChannelId: channel.id,
          currentRunId: childRun.id,
          launchCallId: "call-1",
          description: "Check the logs",
          prompt: "Check the logs",
          subagentType: "generalPurpose",
          status: "running",
          outputPath: "/tmp/task-output",
        },
      });
      await prisma.subagentAttempt.create({
        data: {
          subagentId: subagent.id,
          parentRunId: parentRun.id,
          parentChannelId: channel.id,
          parentToolCallId: "call-1",
          childRunId: childRun.id,
          description: "Check the logs",
          prompt: "Check the logs",
          status: "running",
        },
      });

      await recover(prisma, { send: async () => undefined } as never, messaging as never, async () => new Response());

      expect(wakes.map(({ botId, type }) => ({ botId, type }))).toEqual([{ botId: parentId, type: "subagent.failed" }]);
      expect(await prisma.channelMessage.count({ where: { channelId: channel.id } })).toBe(0);
    } finally {
      await prisma.channel.deleteMany({ where: { directKey: `bot:${parentId}` } });
      await prisma.bot.deleteMany({ where: { id: { in: [parentId, childId] } } });
      await prisma.$disconnect();
    }
  }
);
