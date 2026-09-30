import { expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore, AgentMessaging } from "@openteam/messaging";
import { ChannelService } from "../src/services/channel-service";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

for (const mode of ["queued", "active"] as const) {
test.skipIf(!databaseUrl)(`${mode} attachment acceptance permits concurrent profile reconciliation and remains idempotent`, async () => {
  const db = createPrismaClient(databaseUrl!);
  const root = await mkdtemp(join(tmpdir(), "attachment-acceptance-"));
  const botId = crypto.randomUUID(), channelId = crypto.randomUUID();
  const store = new AgentDataStore(db, { root, workspaceRoot: root, assetRoot: join(root, "assets") });
  const messaging = new AgentMessaging(db, { send: async () => null, sendDebounced: async () => null } as never, store);
  const service = new ChannelService(db, messaging, root, async () => new Response(null));
  const locked = Promise.withResolvers<void>(), preparing = Promise.withResolvers<void>();
  let reconciliation: Promise<unknown> | undefined;
  let sending: Promise<unknown> | undefined;
  const materialize = store.materializeAttachments.bind(store);
  let materializations = 0;
  store.materializeAttachments = async (...args) => {
    materializations++;
    preparing.resolve();
    return materialize(...args);
  };
  try {
    const bot = await db.bot.create({ data: { id: botId, name: "Race fixture", status: "active",
      defaultDirectory: root, onboardingStatus: "pending", conversation: { create: {} } }, include: { conversation: true } });
    await db.channel.create({ data: { id: channelId, kind: "bot_dm", name: "Race", directKey: `bot:${botId}`,
      members: { create: { botId, ordinal: 0 } } } });
    if (mode === "active") {
      const run = await db.run.create({ data: { botId, conversationId: bot.conversation!.id,
        userMessageId: crypto.randomUUID(), origin: "user", channelId, status: "running" } });
      await db.botRunLease.create({ data: { botId, scope: "foreground", runId: run.id,
        ownerId: "fixture", expiresAt: new Date(Date.now() + 60000) } });
    }
    const attachment = await messaging.assets.ingestBytes({ fileName: "résumé.txt", bytes: Buffer.from("same bytes") });
    const input = { clientId: crypto.randomUUID(), content: "Inspect the two files", attachments: [attachment, { ...attachment, fileName: "東京.txt" }] };
    reconciliation = db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent-files:${botId}`}))`;
      locked.resolve();
      await preparing.promise;
      await tx.bot.update({ where: { id: botId }, data: { description: "Concurrent profile edit" } });
    });
    await locked.promise;
    sending = Effect.runPromise(service.sendDirectMessage(bot.conversation!.id, input));
    await Promise.all([reconciliation, sending]);
    const messages = await db.message.findMany({ where: { botId, role: "user" } });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toContain('"original_filenames":["résumé.txt","東京.txt"]');
    expect(materializations).toBe(1);
    await Effect.runPromise(service.sendDirectMessage(bot.conversation!.id, input));
    expect(materializations).toBe(1);
    expect(await db.message.count({ where: { botId, role: "user" } })).toBe(1);
    expect((await db.bot.findUniqueOrThrow({ where: { id: botId } })).description).toBe("Concurrent profile edit");
  } finally {
    preparing.resolve(); locked.resolve();
    await Promise.allSettled([reconciliation, sending]);
    await db.bot.deleteMany({ where: { id: botId } });
    await db.channel.deleteMany({ where: { id: channelId } });
    await db.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

}
