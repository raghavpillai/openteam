import { expect } from "bun:test";
import { Effect } from "effect";
import { ChannelService } from "../src/services/channel-service";
import { dbIt } from "./harness";

for (const mode of ["queued", "active"] as const) dbIt(`${mode} attachment acceptance permits concurrent profile reconciliation and remains idempotent`, async h => {
  const { db, store, messaging } = h;
  const service = new ChannelService(db, messaging, h.dir, async () => new Response(null));
  const locked = Promise.withResolvers<void>(), preparing = Promise.withResolvers<void>();
  const materialize = store.materializeAttachments.bind(store);
  let materializations = 0;
  store.materializeAttachments = async (...args) => { materializations++; preparing.resolve(); return materialize(...args); };
  const bot = await h.bot("Race fixture", { onboardingStatus: "pending" });
  if (mode === "active") {
    const run = await h.run(bot);
    await db.botRunLease.create({ data: { botId: bot.id, scope: "foreground", runId: run.id, ownerId: "fixture", expiresAt: new Date(Date.now() + 60000) } });
  }
  const attachment = await messaging.assets.ingestBytes({ fileName: "résumé.txt", bytes: Buffer.from("same bytes") });
  const input = { clientId: crypto.randomUUID(), content: "Inspect the two files", attachments: [attachment, { ...attachment, fileName: "東京.txt" }] };
  const reconciliation = db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent-files:${bot.id}`}))`;
    locked.resolve();
    await preparing.promise;
    await tx.bot.update({ where: { id: bot.id }, data: { description: "Concurrent profile edit" } });
  });
  await locked.promise;
  const sending = Effect.runPromise(service.sendDirectMessage(bot.conversationId, input));
  try { await Promise.all([reconciliation, sending]); } finally { preparing.resolve(); await Promise.allSettled([reconciliation, sending]); }
  const messages = await db.message.findMany({ where: { botId: bot.id, role: "user" } });
  expect(messages).toHaveLength(1);
  expect(messages[0]!.content).toContain('("résumé.txt", "東京.txt", 10 B)');
  await Effect.runPromise(service.sendDirectMessage(bot.conversationId, input));
  expect(materializations).toBe(1);
  expect(await db.message.count({ where: { botId: bot.id, role: "user" } })).toBe(1);
  expect((await db.bot.findUniqueOrThrow({ where: { id: bot.id } })).description).toBe("Concurrent profile edit");
}, 15000);
