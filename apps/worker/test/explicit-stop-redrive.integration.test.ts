import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnStoppedError, WakeWorker } from "../src/worker";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

for (const origin of ["agent", "connector", "background_revival"] as const)
  for (const stopRecorded of [true, false]) test.skipIf(!databaseUrl)(`an explicit Stop wins over an earlier typed interruption of a ${origin} wake${stopRecorded ? " after its durable cancellation" : " before cancellation is recorded"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "stop-redrive-"));
    const keys = ["DATABASE_URL", "OPENTEAM_WORKSPACE_ROOT", "OPENTEAM_AGENT_DATA_ROOT"] as const;
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    Object.assign(process.env, { DATABASE_URL: databaseUrl, OPENTEAM_WORKSPACE_ROOT: root, OPENTEAM_AGENT_DATA_ROOT: join(root, "data") });
    const worker = new WakeWorker() as any;
    const db = worker.prisma;
    const botId = crypto.randomUUID(), conversationId = crypto.randomUUID(), channelId = crypto.randomUUID();
    await worker.boss.start();
    for (const queue of ["bot-wake", "transcript-project"]) await worker.boss.createQueue(queue);
    try {
      await db.bot.create({ data: { id: botId, name: "Stop race", defaultDirectory: root, status: "active", onboardingStatus: "completed", conversation: { create: { id: conversationId } } } });
      await db.channel.create({ data: { id: channelId, kind: "bot_dm", name: "Stop race", members: { create: { botId, ordinal: 0 } } } });
      const clientId = `stop-redrive:${botId}`;
      const wake = await db.$transaction((tx: any) => worker.messaging.enqueueWake(tx, {
        botId, channelId, origin, type: origin === "agent" ? "agent.message" : origin === "connector" ? "channel.inbound" : "subagent.completed",
        content: "[SAND_HIDDEN_PROMPT]Check the previously authorized result.", clientId, priority: 200, wrapUserContent: false,
      }));
      await db.run.update({ where: { id: wake.run.id }, data: { status: "running", inputDeliveredAt: new Date() } });
      const ownerId = crypto.randomUUID();
      await db.botRunLease.create({ data: { botId, runId: wake.run.id, ownerId, expiresAt: new Date(Date.now() + 120_000) } });
      const typed = await db.$transaction((tx: any) => worker.messaging.acceptDirectUserMessage(tx, {
        botId, channelId, content: "Look at this instead.", clientId: crypto.randomUUID(),
      }));
      expect(typed.interruptRunId).toBe(wake.run.id);
      // Stop arrives after that typed message but before the old runtime settles.
      if (stopRecorded) await db.run.update({ where: { id: wake.run.id }, data: {
        status: "cancelled", error: { code: "cancelled_by_user", message: "The user stopped this turn" },
      } });
      await worker.fail({
        inboxId: wake.inbox.id, inboxType: wake.inbox.type, runId: wake.run.id, botId,
        contextSessionId: conversationId, runChannelId: channelId, screenBotId: botId, pluginBotId: botId,
        conversationId, ownerId, content: "", images: [], clientId, cwd: root, instructions: "", sessionPath: null,
        channelId, deliveryId: null, origin, runtimeProfile: "agent", subagentType: null, readOnly: false,
        inferenceParentRunId: null, taskConfiguration: null, fileAttachments: [], attachmentOwnerBotId: botId, interruptedRunId: null,
      }, stopRecorded ? new Error("Computer turn ended with status interrupted") : new TurnStoppedError("Computer turn ended with status cancelled"), true);
      expect(await db.inboxEvent.findUnique({ where: { idempotencyKey: `${clientId}:redrive:1` } })).toBeNull();
      expect((await db.run.findUniqueOrThrow({ where: { id: wake.run.id } })).error).toMatchObject({ code: "cancelled_by_user" });
      expect(await worker.supersededUnfinishedRun({ botId, interruptedRunId: wake.run.id })).toBe(false);
    } finally {
      await db.bot.deleteMany({ where: { id: botId } });
      await db.channel.deleteMany({ where: { id: channelId } });
      await worker.boss.stop({ graceful: false }).catch(() => undefined);
      await db.$disconnect();
      for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
      await rm(root, { recursive: true, force: true });
    }
  });
