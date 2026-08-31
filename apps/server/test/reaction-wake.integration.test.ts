import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openbot/db";
import { AgentDataStore, AgentMessaging } from "@openbot/messaging";
import { Effect } from "effect";
import { ChannelService } from "../src/services/channel-service";

const databaseUrl = process.env.OPENBOT_TEST_DATABASE_URL;

test("a user reaction resumes the authoring Bot through the handoff source", async () => {
  if (!databaseUrl) return;

  const prisma = createPrismaClient(databaseUrl);
  const temporary = await mkdtemp(join(tmpdir(), "openbot-reaction-wake-"));
  const botId = randomUUID();
  const conversationId = randomUUID();
  const channelId = randomUUID();
  const messageId = randomUUID();
  const jobs: Array<{ name: string; data: unknown }> = [];
  const messaging = new AgentMessaging(
    prisma,
    {
      send: async (name: string, data: unknown) => {
        jobs.push({ name, data });
        return randomUUID();
      },
    } as never,
    new AgentDataStore(prisma, {
      root: join(temporary, "agent-data"),
      workspaceRoot: join(temporary, "workspace"),
    })
  );
  const service = new ChannelService(
    prisma,
    messaging,
    join(temporary, "workspace"),
    async () => new Response(null, { status: 204 }),
    messaging.agentData,
    messaging.assets
  );

  try {
    await prisma.bot.create({
      data: {
        id: botId,
        name: "Reaction probe",
        defaultDirectory: join(temporary, "workspace"),
        status: "active",
        onboardingStatus: "completed",
        conversation: { create: { id: conversationId } },
      },
    });
    await prisma.channel.create({
      data: {
        id: channelId,
        kind: "bot_dm",
        name: "Reaction probe",
        directKey: `bot:${botId}`,
        members: { create: { botId, ordinal: 0 } },
        messages: {
          create: {
            id: messageId,
            sender: "agent",
            senderBotId: botId,
            content: "The deployment finished.",
          },
        },
      },
    });

    const added = await Effect.runPromise(
      service.reactToMessage(messageId, {
        emoji: "👍",
        clientId: `reaction-${randomUUID()}`,
        timeZone: "Asia/Jerusalem",
      })
    );
    expect(added).toMatchObject({ reacted: true, removed: false });
    const runId = String((added as { runId?: unknown }).runId);
    const run = await prisma.run.findUniqueOrThrow({
      where: { id: runId },
      include: { messages: true, inboxEvents: true },
    });
    expect(run.origin).toBe("handoff_resume");
    expect(run.messages[0]?.content).toContain("The user reacted 👍");
    expect(run.inboxEvents[0]).toMatchObject({ type: "user.reaction", priority: 300 });
    expect(run.inboxEvents[0]?.payload).toMatchObject({ origin: "handoff_resume" });

    const removed = await Effect.runPromise(
      service.reactToMessage(messageId, {
        emoji: "👍",
        clientId: `reaction-${randomUUID()}`,
        timeZone: "Asia/Jerusalem",
      })
    );
    expect(removed).toMatchObject({ reacted: false, removed: true, runId: null });
    expect(await prisma.run.count({ where: { botId, origin: "handoff_resume" } })).toBe(1);
    expect(jobs.filter(({ name }) => name === "bot-wake")).toHaveLength(1);
  } finally {
    await prisma.bot.deleteMany({ where: { id: botId } });
    await prisma.$disconnect();
    await rm(temporary, { recursive: true, force: true });
  }
});
