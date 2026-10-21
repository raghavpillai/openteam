import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderRevivalBatchPrompt } from "@openteam/messaging";
import { WakeWorker } from "../src/worker";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

test.skipIf(!databaseUrl)("background results that finish together reach the parent as one revival turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "revival-batch-"));
  const keys = ["DATABASE_URL", "OPENTEAM_WORKSPACE_ROOT", "OPENTEAM_AGENT_DATA_ROOT"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { DATABASE_URL: databaseUrl, OPENTEAM_WORKSPACE_ROOT: root, OPENTEAM_AGENT_DATA_ROOT: join(root, "data") });
  const worker = new WakeWorker();
  // Wakes are claimed directly below; nothing needs the queue.
  (worker.messaging as unknown as { boss: unknown }).boss = { send: async () => "job" };
  const db = worker.prisma;
  const botId = crypto.randomUUID();
  const channelId = crypto.randomUUID();
  type Notify = (tx: unknown, subagent: Record<string, unknown>, status: "completed" | "failed", result: string) => Promise<void>;
  const notify = (worker as unknown as { notifySubagentParent: Notify }).notifySubagentParent.bind(worker);
  try {
    const bot = await db.bot.create({ data: { id: botId, name: "Parent", defaultDirectory: root, status: "active", onboardingStatus: "completed", conversation: { create: {} } }, include: { conversation: true } });
    await db.channel.create({ data: { id: channelId, kind: "bot_dm", name: "Parent", directKey: `bot:${botId}`, members: { create: { botId, ordinal: 0 } } } });
    const source = await db.run.create({ data: { botId, conversationId: bot.conversation!.id, channelId, userMessageId: crypto.randomUUID(), status: "completed", origin: "user" } });
    const subagent = (id: string, description: string) => ({ id, parentBotId: botId, parentRunId: source.id, parentChannelId: channelId, description, subagentType: "executor", currentRunId: crypto.randomUUID(), outputPath: "/tmp/x" });
    await db.$transaction((tx) => notify(tx, subagent("s1", "Find flights"), "completed", "Two nonstops."));
    await worker.messaging.completeShell({ id: "42", scope: botId, channelId, outputPath: "/t/42.log", exitCode: 0, title: "npm test" });
    await db.$transaction((tx) => notify(tx, subagent("s2", "Find hotels"), "failed", "Site blocked."));
    // The flight search finished ten minutes ago, while the parent was busy.
    await db.inboxEvent.updateMany({ where: { botId, idempotencyKey: { startsWith: "subagent:s1:" } }, data: { createdAt: new Date(Date.now() - 10 * 60_000) } });
    const pending = await db.inboxEvent.findMany({ where: { botId }, orderBy: { createdAt: "asc" } });
    expect(pending.map((wake) => wake.type)).toEqual(["subagent.completed", "shell.completed", "subagent.failed"]);

    const claimed = await (worker as unknown as { claim(id: string): Promise<{ runId: string; content: string } | null> }).claim(botId);
    const expected = renderRevivalBatchPrompt([
      { block: 'Background task "Find flights" (executor) finished:\nTwo nonstops.', subagentType: "executor", heldForMs: 10 * 60_000 },
      { block: 'Background task "npm test" (shell) finished:\nFull output: /t/42.log', subagentType: "shell" },
      { block: 'Background task "Find hotels" (executor) failed:\nSite blocked.', subagentType: "executor" },
    ]).replace(/about \d+ minutes ago/, "about 10 minutes ago");
    expect(claimed?.content).toBe(expected);
    expect(claimed?.content).toStartWith("[SAND_HIDDEN_PROMPT][A background task just completed] 3 background tasks you started have finished.");

    const after = await db.inboxEvent.findMany({ where: { botId }, include: { run: true } });
    const own = after.find((wake) => wake.runId === claimed!.runId)!;
    expect(own.status).toBe("processing");
    expect((own.payload as { content: string }).content).toBe(expected);
    expect((await db.message.findFirst({ where: { runId: claimed!.runId } }))?.content).toBe(expected);
    const folded = after.filter((wake) => wake.runId !== claimed!.runId);
    expect(folded).toHaveLength(2);
    for (const wake of folded) {
      expect(wake.status).toBe("completed");
      expect(wake.run.status).toBe("completed");
    }
    const events = await db.event.findMany({ where: { topic: "inbox.completed", entityId: { in: folded.map((wake) => wake.id) } } });
    expect(events.map((event) => (event.payload as { batchedIntoRunId?: string }).batchedIntoRunId)).toEqual([claimed!.runId, claimed!.runId]);
  } finally {
    await db.bot.deleteMany({ where: { id: botId } });
    await db.channel.deleteMany({ where: { id: channelId } });
    await worker.stop();
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(root, { recursive: true, force: true });
  }
});
