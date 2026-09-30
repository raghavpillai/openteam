import { expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "../src/agent-data";
import { AgentMessaging } from "../src/index";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

test.skipIf(!databaseUrl)("first-message attachments do not deadlock concurrent file initialization", async () => {
  const db = createPrismaClient(databaseUrl!);
  const root = await mkdtemp(join(tmpdir(), "bootstrap-attachment-race-"));
  const botId = crypto.randomUUID();
  const assetRoot = join(root, "assets");
  const store = new AgentDataStore(db, { root, assetRoot, workspaceRoot: root });
  const messaging = new AgentMessaging(db, {} as never, store);
  const fileLocked = Promise.withResolvers<void>();
  const botLocked = Promise.withResolvers<void>();
  let initialization: Promise<unknown> | undefined;
  let acceptance: Promise<unknown> | undefined;
  try {
    await db.bot.create({ data: { id: botId, name: "Attachment race", defaultDirectory: root,
      status: "active", onboardingStatus: "pending", conversation: { create: {} } } });
    const bytes = Buffer.from("attachment race fixture");
    const assetId = createHash("sha256").update(bytes).digest("hex");
    await mkdir(assetRoot);
    await writeFile(join(assetRoot, `${assetId}.blob`), bytes);
    initialization = db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent-files:${botId}`}))`;
      fileLocked.resolve();
      await botLocked.promise;
      // This FK takes KEY SHARE on Bot, just like live file initialization.
      await tx.agentFileState.create({ data: { path: join(root, "profile.json"), botId, kind: "profile" } });
    });
    acceptance = db.$transaction(async tx => {
      await fileLocked.promise;
      await messaging.skipBootstrapForUser(tx, botId);
      botLocked.resolve();
      const paths = await store.materializeAttachments(botId, "first-user-message", [{
        assetId, fileName: "fixture.txt", mimeType: "text/plain", kind: "file", byteSize: bytes.length,
      }]);
      expect(paths).toHaveLength(1);
      expect(await readFile(paths[0]!)).toEqual(bytes);
      await tx.message.create({ data: { botId, conversationId: (await tx.conversation.findUniqueOrThrow({ where: { botId } })).id,
        role: "user", content: "Attachment accepted", status: "completed" } });
    });
    await Promise.all([initialization, acceptance]);
    expect(await db.message.count({ where: { botId, role: "user" } })).toBe(1);
  } finally {
    fileLocked.resolve(); botLocked.resolve();
    await Promise.allSettled([initialization, acceptance]);
    await db.bot.deleteMany({ where: { id: botId } });
    await db.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test.skipIf(!databaseUrl)("speaking during provisioning cancels the greeting committed by provisioning", async () => {
  const db = createPrismaClient(databaseUrl!);
  const root = await mkdtemp(join(tmpdir(), "bootstrap-race-"));
  const botId = crypto.randomUUID();
  const channelId = crypto.randomUUID();
  const messaging = new AgentMessaging(db, { send: async () => crypto.randomUUID() } as never,
    new AgentDataStore(db, { root, workspaceRoot: root }));
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const skipping = Promise.withResolvers<number>();
  let provision: Promise<unknown> | undefined;
  let skip: Promise<unknown> | undefined;
  try {
    await db.bot.create({ data: {
      id: botId, name: "First user message", defaultDirectory: root,
      status: "provisioning", onboardingStatus: "pending", conversation: { create: {} },
    } });
    await db.channel.create({ data: {
      id: channelId, kind: "bot_dm", name: "First user message", directKey: `bot:${botId}`,
      members: { create: { botId, ordinal: 0 } },
    } });
    provision = db.$transaction(async (tx) => {
      await tx.bot.update({ where: { id: botId }, data: { status: "active" } });
      locked.resolve();
      await release.promise;
      await messaging.enqueueBootstrap(tx, botId, channelId);
    });
    await locked.promise;
    skip = db.$transaction(async (tx) => {
      const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      skipping.resolve(backend!.pid);
      return messaging.skipBootstrapForUser(tx, botId);
    });
    const pid = await skipping.promise;
    let blocked = false;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const [backend] = await db.$queryRaw<Array<{ wait_event_type: string | null }>>`
        SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`;
      if (backend?.wait_event_type === "Lock") { blocked = true; break; }
      await Bun.sleep(10);
    }
    expect(blocked).toBe(true);
    release.resolve();
    await Promise.all([provision, skip]);
    expect((await db.bot.findUniqueOrThrow({ where: { id: botId } })).onboardingStatus).toBe("skipped_by_user");
    expect(await db.inboxEvent.findMany({ where: { botId, type: "bot.bootstrap" }, select: { status: true } })).toEqual([{ status: "completed" }]);
    expect(await db.run.findMany({ where: { botId, origin: "bootstrap" }, select: { status: true } })).toEqual([{ status: "cancelled" }]);
  } finally {
    release.resolve();
    await Promise.allSettled([provision, skip]);
    await db.bot.deleteMany({ where: { id: botId } });
    await db.channel.deleteMany({ where: { id: channelId } });
    await db.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
});
