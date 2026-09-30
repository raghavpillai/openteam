import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { WakeWorker } from "../src/worker";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

test.skipIf(!databaseUrl)("parent receives nonzero shell exits without mislabeling clean or absent exit codes", async () => {
  const db = createPrismaClient(databaseUrl!);
  const botId = crypto.randomUUID();
  try {
    const bot = await db.bot.create({ data: {
      id: botId, name: "Failure receipt fixture", status: "active",
      defaultDirectory: "/tmp/receipt-test", conversation: { create: {} },
    }, include: { conversation: true } });
    const run = await db.run.create({ data: {
      botId, conversationId: bot.conversation!.id, userMessageId: crypto.randomUUID(), status: "completed",
    } });
    const fixtures = [
      { kind: "command" as const, label: "EXIT_POSITIVE", exitCode: 2 },
      { kind: "command" as const, label: "EXIT_NEGATIVE", exitCode: -9 },
      { kind: "command" as const, label: "CLEAN_ZERO", exitCode: 0 },
      { kind: "command" as const, label: "ABSENT_CODE" },
      { kind: "command" as const, label: "NULL_CODE", exitCode: null },
      { kind: "tool" as const, label: "UNRELATED_FIELD", exitCode: 2 },
    ];
    await db.runItem.createMany({ data: fixtures.map(({ kind, label, ...details }) => ({
      runId: run.id, kind, status: "completed", content: {
        result: { isError: false, details, content: [{ type: "text", text: label }] },
      },
    })) });
    let delivered = "";
    const worker = Object.create(WakeWorker.prototype) as any;
    worker.notifySubagentParent = async (...args: any[]) => { delivered = args[3]; };
    await worker.completeSubagent({
      subagent: { findFirst: async () => ({ id: "child", status: "running" }), update: async () => ({}) },
      subagentAttempt: { findUnique: async () => ({ id: "attempt", status: "running" }), update: async () => ({ runInBackground: true }) },
      message: { findFirst: async () => ({ content: "Done. Everything succeeded." }) },
      runItem: db.runItem,
      event: { create: async () => ({}) },
    }, { botId, runId: run.id });
    expect(delivered).toContain("EXIT_POSITIVE");
    expect(delivered).toContain("EXIT_NEGATIVE");
    for (const label of ["CLEAN_ZERO", "ABSENT_CODE", "NULL_CODE", "UNRELATED_FIELD"])
      expect(delivered).not.toContain(label);
  } finally {
    await db.bot.deleteMany({ where: { id: botId } });
    await db.$disconnect();
  }
}, 20000);
