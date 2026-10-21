import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WakeWorker } from "../src/worker";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

test.skipIf(!databaseUrl)("a wake cut off by a typed message runs again after it, up to its limit, and the message gets the unfinished-tasks reminder", async () => {
  const root = await mkdtemp(join(tmpdir(), "superseded-wake-"));
  const keys = ["DATABASE_URL", "OPENTEAM_WORKSPACE_ROOT", "OPENTEAM_AGENT_DATA_ROOT"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { DATABASE_URL: databaseUrl, OPENTEAM_WORKSPACE_ROOT: root, OPENTEAM_AGENT_DATA_ROOT: join(root, "data") });
  const worker = new WakeWorker() as any;
  const db = worker.prisma;
  const botId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const channelId = crypto.randomUUID();
  await worker.boss.start();
  for (const queue of ["bot-wake", "transcript-project"]) await worker.boss.createQueue(queue);
  try {
    await db.bot.create({ data: { id: botId, name: "Redrive fixture", defaultDirectory: root, status: "active", onboardingStatus: "completed", conversation: { create: { id: conversationId } } } });
    await db.channel.create({ data: { id: channelId, kind: "bot_dm", name: "Redrive fixture", directKey: `bot:${botId}`, members: { create: { botId, ordinal: 0 } } } });
    const claimedFor = async (inboxId: string, ownerId: string) => {
      const inbox = await db.inboxEvent.findUniqueOrThrow({ where: { id: inboxId }, include: { run: true } });
      const payload = inbox.payload as { content: string; clientId: string; interruptedRunId?: string };
      await db.run.update({ where: { id: inbox.runId }, data: { status: "running" } });
      await db.botRunLease.deleteMany({ where: { botId } });
      await db.botRunLease.create({ data: { botId, runId: inbox.runId, ownerId, expiresAt: new Date(Date.now() + 120_000) } });
      return {
        inboxId, inboxType: inbox.type, runId: inbox.runId, botId, contextSessionId: "context", runChannelId: channelId,
        screenBotId: botId, pluginBotId: botId, conversationId, ownerId, content: payload.content, images: [],
        clientId: payload.clientId, cwd: root, instructions: "", sessionPath: null, channelId, deliveryId: null,
        origin: inbox.run.origin, runtimeProfile: "agent", subagentType: null, readOnly: false, inferenceParentRunId: null,
        taskConfiguration: null, fileAttachments: [], attachmentOwnerBotId: botId,
        interruptedRunId: payload.interruptedRunId ?? null,
      };
    };
    const { inbox: first } = await db.$transaction((tx: any) => worker.messaging.enqueueWake(tx, {
      botId, channelId, origin: "agent", type: "agent.message", content: "[agent] Please check the deploy.",
      clientId: `agent:call-1:${botId}`, priority: 200, wrapUserContent: false,
    }));
    let agent = await claimedFor(first.id, "agent-worker");
    const typed = await db.$transaction((tx: any) => worker.messaging.acceptDirectUserMessage(tx, {
      botId, channelId, content: "Stop, look at this instead.", clientId: "typed-1",
    }));
    expect(typed.interruptRunId).toBe(agent.runId);
    // The cancel has not been recorded yet: the typed message's wake alone marks the run superseded.
    await worker.fail(agent, new Error("Computer turn ended with status interrupted"));
    const typedClaim = await claimedFor(typed.inbox.id, "user-worker");
    expect(typedClaim.interruptedRunId).toBe(agent.runId);
    // As in the reference, only a run that had dispatched leaves unfinished tasks behind.
    expect(await worker.supersededUnfinishedRun(typedClaim)).toBe(false);
    await db.run.update({ where: { id: agent.runId }, data: { inputDeliveredAt: new Date() } });
    expect(await worker.supersededUnfinishedRun(typedClaim)).toBe(true);
    await db.run.update({ where: { id: typedClaim.runId }, data: { status: "completed" } });
    await db.botRunLease.deleteMany({ where: { botId } });

    for (let attempt = 1; attempt <= 3; attempt++) {
      const redrive = await db.inboxEvent.findUniqueOrThrow({ where: { idempotencyKey: `agent:call-1:${botId}:redrive:${attempt}` }, include: { run: true } });
      expect(redrive).toMatchObject({ type: "agent.message", priority: 200, status: "pending", run: { origin: "agent", status: "queued" } });
      expect((redrive.payload as { content: string }).content).toBe("[agent] Please check the deploy.");
      agent = await claimedFor(redrive.id, `agent-worker-${attempt}`);
      await db.run.update({ where: { id: agent.runId }, data: { status: "cancelled", error: { code: "priority_peer_interrupt", message: "superseded by a priority agent message" } } });
      await worker.fail(agent, new Error("cancelled"));
    }
    expect(await db.inboxEvent.findUnique({ where: { idempotencyKey: `agent:call-1:${botId}:redrive:4` } })).toBeNull();

    // A connector event runs again once; a run that failed on its own does not.
    const { inbox: connector } = await db.$transaction((tx: any) => worker.messaging.enqueueWake(tx, {
      botId, channelId, origin: "connector", type: "channel.inbound", content: "[connector] New Slack message",
      clientId: `connector:${botId}`, priority: 200, wrapUserContent: false,
    }));
    const connectorClaim = await claimedFor(connector.id, "connector-worker");
    await db.run.update({ where: { id: connectorClaim.runId }, data: { status: "cancelled", error: { code: "priority_peer_interrupt", message: "superseded" } } });
    await worker.fail(connectorClaim, new Error("cancelled"));
    const again = await db.inboxEvent.findUniqueOrThrow({ where: { idempotencyKey: `connector:${botId}:redrive:1` } });
    const againClaim = await claimedFor(again.id, "connector-worker-2");
    await db.run.update({ where: { id: againClaim.runId }, data: { status: "cancelled", error: { code: "priority_peer_interrupt", message: "superseded" } } });
    await worker.fail(againClaim, new Error("cancelled"));
    expect(await db.inboxEvent.findUnique({ where: { idempotencyKey: `connector:${botId}:redrive:2` } })).toBeNull();
    const { inbox: failing } = await db.$transaction((tx: any) => worker.messaging.enqueueWake(tx, {
      botId, channelId, origin: "agent", type: "agent.message", content: "[agent] Another",
      clientId: `agent:call-2:${botId}`, priority: 200, wrapUserContent: false,
    }));
    await worker.fail(await claimedFor(failing.id, "plain-failure"), new Error("model error"));
    expect(await db.inboxEvent.findUnique({ where: { idempotencyKey: `agent:call-2:${botId}:redrive:1` } })).toBeNull();
  } finally {
    await db.bot.deleteMany({ where: { id: botId } });
    await db.channel.deleteMany({ where: { id: channelId } });
    await worker.boss.stop({ graceful: false }).catch(() => undefined);
    await db.$disconnect();
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
