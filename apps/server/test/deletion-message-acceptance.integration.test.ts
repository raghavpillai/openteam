import { expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore, AgentMessaging } from "@openteam/messaging";
import { BotService } from "../src/services/bot-service";
import { ChannelService } from "../src/services/channel-service";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;

test.skipIf(!url)("deletion includes a direct message accepted while it waits for the bot row", async () => {
  const db = createPrismaClient(url!);
  const root = await mkdtemp(join(tmpdir(), "retirement-acceptance-"));
  const boss = { send: async () => null, sendDebounced: async () => null };
  const store = new AgentDataStore(db, { root, workspaceRoot: root, assetRoot: join(root, "assets") });
  const messaging = new AgentMessaging(db, boss as never, store);
  const bot = await db.bot.create({ data: { name: "Typed during deletion", defaultDirectory: root, status: "active", onboardingStatus: "skipped_by_user", conversation: { create: {} } }, include: { conversation: true } });
  const channel = await db.channel.create({ data: { kind: "bot_dm", name: "Home", directKey: `bot:${bot.id}`, members: { create: { botId: bot.id, ordinal: 0 } } } });
  const accepting = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let send: Promise<any> | undefined, archive: Promise<unknown> | undefined;
  const accept = messaging.acceptDirectUserMessage.bind(messaging);
  messaging.acceptDirectUserMessage = async (...args) => {
    accepting.resolve(); await release.promise; return accept(...args);
  };
  try {
    const service = new ChannelService(db, messaging, root, async () => Response.json({ ok: true }));
    send = Effect.runPromise(service.sendDirectMessage(bot.conversation!.id, { content: "One last message", clientId: crypto.randomUUID() }));
    await accepting.promise;
    const deletion = new BotService(db, boss as never, root, async () => Response.json({ ok: true }), store);
    archive = Effect.runPromise(deletion.archive(bot.id));
    // The sender owns the Bot row. Before the fix deletion reaches its status update only
    // after it has scanned/cancelled runs; afterwards it waits at the lifecycle gate instead.
    const deadline = Date.now() + 3000;
    let waiting = false;
    while (!waiting && Date.now() < deadline) {
      const rows = await db.$queryRaw<any[]>`SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND (query LIKE '%Bot%' OR query LIKE '%pg_advisory_xact_lock%') AND query NOT LIKE '%pg_stat_activity%'`;
      waiting = rows.length > 0;
      if (!waiting) await Bun.sleep(2);
    }
    release.resolve();
    const accepted = await send; await archive;
    expect(waiting).toBe(true);
    expect(await db.run.findUniqueOrThrow({ where: { id: accepted.run.id } })).toMatchObject({ status: "cancelled", error: { code: "bot_archived" } });
    expect(await db.inboxEvent.count({ where: { botId: bot.id, status: { in: ["pending", "processing"] } } })).toBe(0);
    expect(await db.channel.findUniqueOrThrow({ where: { id: channel.id } })).toMatchObject({ archivedAt: expect.any(Date) });
  } finally {
    release.resolve(); await Promise.allSettled([send, archive]);
    await db.bot.delete({ where: { id: bot.id } });
    await db.channel.deleteMany({ where: { id: channel.id } });
    await db.retiredAgent.deleteMany({ where: { id: bot.id } });
    await db.$disconnect(); await rm(root, { recursive: true, force: true });
  }
}, 15_000);
