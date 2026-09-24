import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WakeWorker } from "../src/worker";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
for (const status of ["completed", "failed", "cancelled", "interrupted", "running", "waiting_approval"] as const) {
  test.skipIf(!databaseUrl)(`a ${status} run's unexpired lease ${["running", "waiting_approval"].includes(status) ? "protects active work" : "does not block the next message after a crash"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "terminal-lease-"));
    const keys = ["DATABASE_URL", "OPENTEAM_WORKSPACE_ROOT", "OPENTEAM_AGENT_DATA_ROOT"] as const;
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    Object.assign(process.env, { DATABASE_URL: databaseUrl, OPENTEAM_WORKSPACE_ROOT: root, OPENTEAM_AGENT_DATA_ROOT: join(root, "data") });
    const worker = new WakeWorker();
    const db = worker.prisma;
    const botId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    try {
      await db.bot.create({ data: { id: botId, name: "Crash recovery", defaultDirectory: root, status: "active", onboardingStatus: "completed", conversation: { create: { id: conversationId } } } });
      await db.channel.create({ data: { id: channelId, kind: "bot_dm", name: "Crash recovery", directKey: `bot:${botId}`, members: { create: { botId, ordinal: 0 } } } });
      const old = await db.run.create({ data: { botId, conversationId, channelId, userMessageId: crypto.randomUUID(), status } });
      await db.botRunLease.create({ data: { botId, runId: old.id, ownerId: "prior-worker", expiresAt: new Date(Date.now() + 120_000) } });
      const next = await db.run.create({ data: { botId, conversationId, channelId, userMessageId: crypto.randomUUID(), status: "queued" } });
      await db.inboxEvent.create({ data: { botId, conversationId, runId: next.id, idempotencyKey: crypto.randomUUID(), type: "user.message", payload: { content: "Continue after restart", clientId: crypto.randomUUID(), channelId } } });
      const claimed = await (worker as unknown as { claim(id: string): Promise<{ runId: string } | null> }).claim(botId);
      if (["running", "waiting_approval"].includes(status)) {
        expect(claimed).toBeNull();
        expect(await db.botRunLease.findFirst({ where: { botId } })).toMatchObject({ runId: old.id, ownerId: "prior-worker" });
      } else {
        expect(claimed?.runId).toBe(next.id);
        expect(await db.botRunLease.findFirst({ where: { botId } })).toMatchObject({ runId: next.id });
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
