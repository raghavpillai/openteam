import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openbot/db";
import { AgentDataStore } from "../src/agent-data";
import { AgentMessaging } from "../src/index";

const databaseUrl = process.env.OPENBOT_TEST_DATABASE_URL;

test("administrator broadcasts tap every requested active top-level Bot exactly once", async () => {
  if (!databaseUrl) return;

  const prisma = createPrismaClient(databaseUrl);
  const temporary = await mkdtemp(join(tmpdir(), "openbot-background-wakes-"));
  const workspace = join(temporary, "workspace");
  const root = join(temporary, "agent-data");
  const firstId = randomUUID();
  const secondId = randomUUID();
  const archivedId = randomUUID();
  const missingId = randomUUID();
  const channelIds: string[] = [];
  const wakeJobs: Array<{ name: string; data: unknown }> = [];
  const boss = {
    send: async (name: string, data: unknown) => {
      wakeJobs.push({ name, data });
      return randomUUID();
    },
  };
  const messaging = new AgentMessaging(
    prisma,
    boss as never,
    new AgentDataStore(prisma, { root, workspaceRoot: workspace })
  );

  const createBot = async (id: string, status: "active" | "archived") => {
    const conversationId = randomUUID();
    await prisma.bot.create({
      data: {
        id,
        name: `Broadcast ${id.slice(0, 6)}`,
        defaultDirectory: workspace,
        status,
        onboardingStatus: "completed",
        conversation: { create: { id: conversationId } },
      },
    });
    if (status === "active") {
      const channelId = randomUUID();
      channelIds.push(channelId);
      await prisma.channel.create({
        data: {
          id: channelId,
          kind: "bot_dm",
          name: `Broadcast ${id.slice(0, 6)}`,
          directKey: `bot:${id}`,
          members: { create: { botId: id, ordinal: 0 } },
        },
      });
    }
  };

  try {
    await mkdir(workspace, { recursive: true });
    await createBot(firstId, "active");
    await createBot(secondId, "active");
    await createBot(archivedId, "archived");

    const input = {
      clientId: `broadcast-${randomUUID()}`,
      message: "The local runtime will restart tonight.",
      botIds: [secondId, firstId, archivedId, missingId, firstId],
    };
    const first = await messaging.broadcast(input);
    expect(first.delivered).toBe(2);
    expect(first.duplicate).toBe(0);
    expect(new Set(first.skippedBotIds)).toEqual(new Set([archivedId, missingId]));
    expect(first.runs.map(({ botId }) => botId).sort()).toEqual([firstId, secondId].sort());

    const runs = await prisma.run.findMany({
      where: { id: { in: first.runs.map(({ runId }) => runId) } },
      include: { messages: true, inboxEvents: true },
    });
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run.origin).toBe("broadcast");
      expect(run.messages).toHaveLength(1);
      expect(run.messages[0]).toMatchObject({ role: "user", status: "completed" });
      expect(run.messages[0]?.content).toContain("[broadcast]");
      expect(run.inboxEvents).toHaveLength(1);
      expect(run.inboxEvents[0]).toMatchObject({
        type: "admin.broadcast",
        priority: 275,
        deliveryMode: "turn",
      });
      expect(run.inboxEvents[0]?.payload).toMatchObject({ origin: "broadcast" });
    }
    expect(
      await prisma.channelMessage.count({
        where: { channelId: { in: channelIds }, sender: "system" },
      })
    ).toBe(0);
    expect(wakeJobs).toHaveLength(2);

    const replay = await messaging.broadcast(input);
    expect(replay.delivered).toBe(0);
    expect(replay.duplicate).toBe(2);
    expect(replay.runs.map(({ runId }) => runId).sort()).toEqual(
      first.runs.map(({ runId }) => runId).sort()
    );
    expect(
      await prisma.run.count({ where: { origin: "broadcast", botId: { in: [firstId, secondId] } } })
    ).toBe(2);
    expect(wakeJobs).toHaveLength(2);
  } finally {
    await prisma.bot.deleteMany({ where: { id: { in: [firstId, secondId, archivedId] } } });
    await prisma.$disconnect();
    await rm(temporary, { recursive: true, force: true });
  }
});
