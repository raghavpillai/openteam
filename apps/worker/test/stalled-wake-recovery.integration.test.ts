import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WakeWorker } from "../src/worker";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

type Internals = {
  boss: { send: (...args: unknown[]) => Promise<unknown> };
  claim(botId: string): Promise<{ runId: string } | null>;
};

for (const scenario of ["crashed", "alive", "recent"] as const) {
  test.skipIf(!databaseUrl)(`chaos: a routine wake left processing by a ${scenario} worker ${scenario === "crashed" ? "is queued for reclaim" : "is left alone"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "stalled-wake-"));
    const keys = ["DATABASE_URL", "OPENTEAM_WORKSPACE_ROOT", "OPENTEAM_AGENT_DATA_ROOT"] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    Object.assign(process.env, { DATABASE_URL: databaseUrl, OPENTEAM_WORKSPACE_ROOT: root, OPENTEAM_AGENT_DATA_ROOT: join(root, "data") });
    const worker = new WakeWorker();
    const internals = worker as unknown as Internals;
    const sent: unknown[][] = [];
    internals.boss.send = async (...args: unknown[]) => { sent.push(args); return null; };
    const db = worker.prisma;
    const botId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    try {
      await db.bot.create({ data: { id: botId, name: "Stalled routine", defaultDirectory: root, status: "active", onboardingStatus: "completed", conversation: { create: { id: conversationId } } } });
      await db.channel.create({ data: { id: channelId, kind: "bot_dm", name: "Stalled routine", directKey: `bot:${botId}`, members: { create: { botId, ordinal: 0 } } } });
      // The run a worker was executing when it died: still running, its wake still claimed.
      const run = await db.run.create({ data: { botId, conversationId, channelId, userMessageId: crypto.randomUUID(), status: "running", origin: "routine" } });
      const claimedAt = new Date(Date.now() - (scenario === "recent" ? 30_000 : 3 * 60_000));
      await db.inboxEvent.create({ data: {
        botId, conversationId, runId: run.id, idempotencyKey: crypto.randomUUID(), type: "routine.scheduled",
        status: "processing", claimedAt, attempts: 1, priority: 100,
        payload: { content: "Routine due", clientId: crypto.randomUUID(), channelId, automationContextRunId: run.id },
      } });
      // A dead worker's heartbeat stopped; a live one keeps the lease in the future.
      await db.botRunLease.create({ data: {
        botId, runId: run.id, scope: `automation:${run.id}`, ownerId: "prior-worker",
        expiresAt: new Date(Date.now() + (scenario === "alive" ? 60_000 : -60_000)),
      } });

      await worker.kickStalledWakes();

      if (scenario === "crashed") {
        expect(sent).toEqual([["bot-wake", { botId }, expect.anything()]]);
        // The queued claim takes the stalled wake back, so its routine can settle and fire again.
        expect((await internals.claim(botId))?.runId).toBe(run.id);
      } else {
        expect(sent).toEqual([]);
      }
    } finally {
      await db.bot.deleteMany({ where: { id: botId } });
      await db.channel.deleteMany({ where: { id: channelId } });
      await worker.stop();
      for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
      await rm(root, { recursive: true, force: true });
    }
  });
}
