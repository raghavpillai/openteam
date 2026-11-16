import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchRequestChecks } from "@openteam/messaging";
import { AUTOMATION_RETRY_DELAYS_MS, WakeWorker } from "../src/worker";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

type Claimed = { runId: string; inboxId: string; inboxType: string };
type Internals = {
  boss: { send: (...args: unknown[]) => Promise<unknown> };
  claim(botId: string): Promise<Claimed | null>;
  fail(claimed: Claimed, error: unknown, interrupted?: boolean): Promise<void>;
};

test.skipIf(!databaseUrl)("chaos: a model outage at a request's check time keeps the request open instead of blocking it", async () => {
  const root = await mkdtemp(join(tmpdir(), "request-check-outage-"));
  const keys = ["DATABASE_URL", "OPENTEAM_WORKSPACE_ROOT", "OPENTEAM_AGENT_DATA_ROOT"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { DATABASE_URL: databaseUrl, OPENTEAM_WORKSPACE_ROOT: root, OPENTEAM_AGENT_DATA_ROOT: join(root, "data") });
  const worker = new WakeWorker();
  const internals = worker as unknown as Internals;
  internals.boss.send = async () => "job";
  (worker.messaging as unknown as { boss: unknown }).boss = { send: async () => "job", sendDebounced: async () => "job" };
  const db = worker.prisma;
  const botId = crypto.randomUUID();
  const channelId = crypto.randomUUID();
  try {
    const bot = await db.bot.create({ data: { id: botId, name: "Check later", defaultDirectory: root, status: "active", onboardingStatus: "completed", conversation: { create: {} } }, include: { conversation: true } });
    await db.channel.create({ data: { id: channelId, kind: "bot_dm", name: "Check later", directKey: `bot:${botId}`, members: { create: { botId, ordinal: 0 } } } });
    // The user asked to check back later; the bot saved a waiting request whose check is now due.
    const requestId = crypto.randomUUID();
    const request = await db.run.create({ data: {
      id: requestId, botId, conversationId: bot.conversation!.id, channelId, userMessageId: crypto.randomUUID(), status: "completed", origin: "user",
      requestRevision: 1, requestNextCheckAt: new Date(Date.now() - 1000),
      requestProgress: { key: "wait", state: "waiting", summary: "Waiting for the delivery status.", evidence: ["asked"], remaining: ["check the delivery"], nextAction: "check the delivery", revision: 1, runId: requestId },
    } });
    expect(await dispatchRequestChecks(db, worker.messaging)).toBe(1);
    const outage = new Error('500: {"message":"upstream exploded","type":"server_error"}');
    for (const delay of AUTOMATION_RETRY_DELAYS_MS) {
      const check = await internals.claim(botId);
      expect(check?.inboxType).toBe("request.check");
      // Every turn starts by recording its prompt fingerprint, before the model is called.
      await db.runItem.create({ data: { runId: check!.runId, upstreamItemId: `prompt:${check!.runId}:${crypto.randomUUID()}`, kind: "tool", status: "completed", title: "promptFingerprint", content: { type: "promptFingerprint" } } });
      await db.run.update({ where: { id: check!.runId }, data: { status: "failed" } });
      await internals.fail(check!, outage);
      const saved = await db.run.findUniqueOrThrow({ where: { id: request.id } });
      // The outage spends no reconciliation and does not block the request.
      expect(saved.requestReconciliations).toBe(0);
      expect((saved.requestProgress as { state: string }).state).toBe("working");
      const wake = await db.inboxEvent.findUniqueOrThrow({ where: { id: check!.inboxId } });
      expect(wake.status).toBe("pending");
      expect(wake.availableAt.getTime()).toBeGreaterThan(Date.now() + delay - 5000);
      await db.inboxEvent.update({ where: { id: wake.id }, data: { availableAt: new Date(Date.now() - 1000) } });
    }
    // Once the provider is back, the same check runs.
    expect((await internals.claim(botId))?.inboxType).toBe("request.check");
  } finally {
    await db.bot.deleteMany({ where: { id: botId } });
    await db.channel.deleteMany({ where: { id: channelId } });
    await worker.stop();
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
