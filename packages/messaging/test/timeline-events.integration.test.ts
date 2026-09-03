import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "../src/agent-data";
import { AgentMessaging } from "../src/index";
import { appendAgentTimelineEvent } from "../src/timeline-events";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

test("timeline mutations persist events and only tap an active idle Bot", async () => {
  if (!databaseUrl) return;

  const prisma = createPrismaClient(databaseUrl);
  const temporary = await mkdtemp(join(tmpdir(), "openteam-timeline-events-"));
  const root = join(temporary, "agent-data");
  const workspace = join(temporary, "workspace");
  const botId = randomUUID();
  const conversationId = randomUUID();
  const channelId = randomUUID();
  const wakeJobs: Array<{ name: string; data: unknown }> = [];
  const boss = {
    send: async (name: string, data: unknown) => {
      wakeJobs.push({ name, data });
      return randomUUID();
    },
  };
  const store = new AgentDataStore(prisma, { root, workspaceRoot: workspace });
  const messaging = new AgentMessaging(prisma, boss as never, store);

  try {
    await mkdir(workspace, { recursive: true });
    await prisma.bot.create({
      data: {
        id: botId,
        name: "Timeline probe",
        defaultDirectory: workspace,
        status: "active",
        onboardingStatus: "completed",
        conversation: { create: { id: conversationId } },
      },
    });
    await prisma.channel.create({
      data: {
        id: channelId,
        kind: "bot_dm",
        name: "Timeline probe",
        directKey: `bot:${botId}`,
        members: { create: { botId, ordinal: 0 } },
      },
    });
    await store.writeActiveAgentId(botId);
    await store.initializeBot(botId);

    await Promise.all([
      store.mutateBotFiles(botId, ["profile"], async (tx) => {
        await tx.bot.update({
          where: { id: botId },
          data: { name: "Atomic rename", description: "Official writer wins" },
        });
        await tx.channel.update({ where: { id: channelId }, data: { name: "Atomic rename" } });
      }),
      store.reconcileBot(botId),
    ]);
    expect(await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).toMatchObject({
      name: "Atomic rename",
      description: "Official writer wins",
    });
    expect(
      JSON.parse(await readFile(join(store.botDirectory(botId), "profile.json"), "utf8"))
    ).toMatchObject({ name: "Atomic rename", description: "Official writer wins" });

    const idleResult = await prisma.$transaction((tx) =>
      appendAgentTimelineEvent(tx, messaging, {
        botId,
        clientId: randomUUID(),
        event: { type: "name-changed", from: "Timeline probe", to: "Renamed probe" },
      })
    );
    expect(idleResult).toEqual({ appended: true, woke: true });

    const visibleEvent = await prisma.channelMessage.findFirstOrThrow({
      where: { channelId, sender: "system" },
      orderBy: { sequence: "desc" },
    });
    expect(visibleEvent.content).toBe("");
    expect(visibleEvent.metadata).toEqual({
      type: "event",
      event: { type: "name-changed", from: "Timeline probe", to: "Renamed probe" },
    });

    const eventRun = await prisma.run.findFirstOrThrow({
      where: { botId, origin: "event" },
      include: { inboxEvents: true, messages: true },
    });
    expect(eventRun.channelId).toBe(channelId);
    expect(eventRun.inboxEvents).toHaveLength(1);
    expect(eventRun.inboxEvents[0]).toMatchObject({
      type: "timeline.event",
      deliveryMode: "turn",
      priority: 100,
    });
    expect(eventRun.inboxEvents[0]?.payload).toMatchObject({ origin: "event" });
    expect(eventRun.messages).toHaveLength(1);
    expect(eventRun.messages[0]).toMatchObject({ role: "user", status: "completed" });
    expect(eventRun.messages[0]?.content).toContain("[event]");
    expect(wakeJobs).toEqual([{ name: "bot-wake", data: { botId } }]);

    const runningMessage = await prisma.message.create({
      data: {
        botId,
        conversationId,
        role: "user",
        content: "Running turn",
        status: "completed",
      },
    });
    const runningRun = await prisma.run.create({
      data: {
        botId,
        conversationId,
        userMessageId: runningMessage.id,
        status: "running",
        origin: "user",
        channelId,
      },
    });
    await prisma.message.update({
      where: { id: runningMessage.id },
      data: { runId: runningRun.id },
    });
    await prisma.botRunLease.create({
      data: {
        botId,
        runId: runningRun.id,
        ownerId: "timeline-test",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const runningResult = await prisma.$transaction((tx) =>
      appendAgentTimelineEvent(tx, messaging, {
        botId,
        clientId: randomUUID(),
        event: {
          type: "automation-changed",
          action: "disabled",
          automationId: randomUUID(),
          automationName: "Probe routine",
        },
      })
    );
    expect(runningResult).toEqual({ appended: true, woke: false });
    expect(await prisma.run.count({ where: { botId, origin: "event" } })).toBe(1);
    expect(await prisma.channelMessage.count({ where: { channelId, sender: "system" } })).toBe(2);
    expect(wakeJobs).toHaveLength(1);

    await prisma.botRunLease.delete({ where: { botId } });
    await prisma.run.update({ where: { id: runningRun.id }, data: { status: "completed" } });
    await store.writeActiveAgentId(randomUUID());

    const inactiveResult = await prisma.$transaction((tx) =>
      appendAgentTimelineEvent(tx, messaging, {
        botId,
        clientId: randomUUID(),
        event: {
          type: "automation-changed",
          action: "enabled",
          automationId: randomUUID(),
          automationName: "Probe routine",
        },
      })
    );
    expect(inactiveResult).toEqual({ appended: false, woke: false });
    expect(await prisma.channelMessage.count({ where: { channelId, sender: "system" } })).toBe(2);
    expect(await prisma.run.count({ where: { botId, origin: "event" } })).toBe(1);
  } finally {
    await prisma.bot.deleteMany({ where: { id: botId } });
    await prisma.$disconnect();
    await rm(temporary, { recursive: true, force: true });
  }
});
