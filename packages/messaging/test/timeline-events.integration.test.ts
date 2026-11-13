import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "../src/agent-data";
import { AgentMessaging } from "../src/index";
import { appendAgentTimelineEvent } from "../src/timeline-events";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

test.skipIf(!databaseUrl)("timeline mutations persist events and only tap an active idle Bot", async () => {
  const prisma = createPrismaClient(databaseUrl!);
  const root = await mkdtemp(join(tmpdir(), "openteam-timeline-events-"));
  const botId = randomUUID(), conversationId = randomUUID(), channelId = randomUUID();
  const wakeJobs: Array<{ name: string; data: unknown }> = [];
  const boss = { send: async (name: string, data: unknown) => (wakeJobs.push({ name, data }), randomUUID()) };
  const store = new AgentDataStore(prisma, { root: join(root, "agent-data"), workspaceRoot: root });
  const messaging = new AgentMessaging(prisma, boss as never, store);
  const append = (event: Record<string, unknown>) =>
    prisma.$transaction((tx) => appendAgentTimelineEvent(tx, messaging, { botId, clientId: randomUUID(), event: event as never }));
  const automation = (action: string) => ({ type: "automation-changed", action, automationId: randomUUID(), automationName: "Probe routine" });
  const counts = async () => [await prisma.channelMessage.count({ where: { channelId, sender: "system" } }), await prisma.run.count({ where: { botId, origin: "event" } })];
  try {
    await prisma.bot.create({ data: { id: botId, name: "Timeline probe", defaultDirectory: root, status: "active", onboardingStatus: "completed", conversation: { create: { id: conversationId } } } });
    await prisma.channel.create({ data: { id: channelId, kind: "bot_dm", name: "Timeline probe", directKey: `bot:${botId}`, members: { create: { botId, ordinal: 0 } } } });
    await store.writeActiveAgentId(botId);
    await store.initializeBot(botId);

    // A profile write racing reconciliation lands in both the database and the file.
    const profile = { name: "Atomic rename", description: "Official writer wins" };
    await Promise.all([
      store.mutateBotFiles(botId, ["profile"], async (tx) => {
        await tx.bot.update({ where: { id: botId }, data: profile });
        await tx.channel.update({ where: { id: channelId }, data: { name: profile.name } });
      }),
      store.reconcileBot(botId),
    ]);
    expect(await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).toMatchObject(profile);
    expect(JSON.parse(await readFile(join(store.botDirectory(botId), "profile.json"), "utf8"))).toMatchObject(profile);

    // An idle active Bot gets a visible event and one event wake.
    const renamed = { type: "name-changed", from: "Timeline probe", to: "Renamed probe" };
    expect(await append(renamed)).toEqual({ appended: true, woke: true });
    expect(await prisma.channelMessage.findFirstOrThrow({ where: { channelId, sender: "system" }, orderBy: { sequence: "desc" } }))
      .toMatchObject({ content: "", metadata: { type: "event", event: renamed } });
    const eventRun = await prisma.run.findFirstOrThrow({ where: { botId, origin: "event" }, include: { inboxEvents: true, messages: true } });
    expect(eventRun).toMatchObject({
      channelId,
      inboxEvents: [{ type: "timeline.event", priority: 100, payload: { origin: "event" } }],
      messages: [{ role: "user", status: "completed" }],
    });
    expect(eventRun.messages[0]!.content).toContain("[event]");
    expect(wakeJobs).toEqual([{ name: "bot-wake", data: { botId } }]);

    // A busy Bot records the event without another wake.
    const input = await prisma.message.create({ data: { botId, conversationId, role: "user", content: "Running turn", status: "completed" } });
    const running = await prisma.run.create({ data: { botId, conversationId, userMessageId: input.id, status: "running", origin: "user", channelId } });
    await prisma.botRunLease.create({ data: { botId, runId: running.id, ownerId: "timeline-test", expiresAt: new Date(Date.now() + 60_000) } });
    expect(await append(automation("disabled"))).toEqual({ appended: true, woke: false });
    expect(await counts()).toEqual([2, 1]);
    expect(wakeJobs).toHaveLength(1);

    // A Bot that is not the active agent records nothing.
    await prisma.botRunLease.deleteMany({ where: { botId } });
    await prisma.run.update({ where: { id: running.id }, data: { status: "completed" } });
    await store.writeActiveAgentId(randomUUID());
    expect(await append(automation("enabled"))).toEqual({ appended: false, woke: false });
    expect(await counts()).toEqual([2, 1]);
  } finally {
    await store.stopWatching();
    await prisma.channel.deleteMany({ where: { id: channelId } });
    await prisma.bot.deleteMany({ where: { id: botId } });
    await prisma.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
});
