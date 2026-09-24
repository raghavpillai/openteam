import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "../../src/agent-data";
import { atomicWrite, jsonFile } from "../../src/file-state";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;
test.skipIf(!url)("watching observes edits made immediately after startup resolves", async () => {
  const db = createPrismaClient(url!);
  const root = await mkdtemp(join(tmpdir(), "watcher-startup-"));
  const botId = crypto.randomUUID();
  const store = new AgentDataStore(db, { root: join(root, "data"), workspaceRoot: root });
  try {
    await db.bot.create({
      data: { id: botId, name: "Before watching", status: "active", defaultDirectory: root },
    });
    await store.initializeBot(botId);
    await store.startWatching();
    await atomicWrite(
      join(store.botDirectory(botId), "profile.json"),
      jsonFile({ name: "Edited immediately" })
    );
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if ((await db.bot.findUniqueOrThrow({ where: { id: botId } })).name === "Edited immediately")
        break;
      await Bun.sleep(25);
    }
    expect((await db.bot.findUniqueOrThrow({ where: { id: botId } })).name).toBe(
      "Edited immediately"
    );
  } finally {
    await store.stopWatching();
    await db.bot.deleteMany({ where: { id: botId } });
    await db.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
});


test.skipIf(!url)("watching imports new memory directories after repeated atomic profile replacements", async () => {
  const db = createPrismaClient(url!);
  const root = await mkdtemp(join(tmpdir(), "watcher-replacement-"));
  const botId = crypto.randomUUID();
  const store = new AgentDataStore(db, { root: join(root, "data"), workspaceRoot: root });
  try {
    await db.bot.create({ data: { id: botId, name: "Replacement fixture", status: "active", defaultDirectory: root } });
    await store.initializeBot(botId);
    await store.startWatching();
    const directory = store.botDirectory(botId);
    for (let round = 0; round < 8; round += 1) {
      const name = `Replacement ${round}`;
      // Atomic editor saves replace the inode and force native file reattachment.
      for (let edit = 0; edit < 4; edit += 1) {
        await atomicWrite(join(directory, "profile.json"), jsonFile({ name }));
        await Bun.sleep(8);
      }
      await atomicWrite(join(directory, "memory", "profile.md"), `- (2026-09-24) Memory replacement ${round}.\n`);
      const deadline = Date.now() + 2000;
      let observed = false;
      while (Date.now() < deadline) {
        const fact = await db.memoryFact.findFirst({ where: { namespace: `agent:${botId}`, fact: `Memory replacement ${round}.` } });
        if (fact && (await db.bot.findUniqueOrThrow({ where: { id: botId } })).name === name) {
          observed = true;
          break;
        }
        await Bun.sleep(25);
      }
      expect(observed).toBe(true);
      // The next iteration must rediscover both the directory and its file.
      await rm(join(directory, "memory"), { recursive: true, force: true });
      await Bun.sleep(300);
    }
  } finally {
    await store.stopWatching();
    await db.bot.deleteMany({ where: { id: botId } });
    await db.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test.skipIf(!url)("watching recovers lost notifications and stops reconciliation on shutdown", async () => {
  const db = createPrismaClient(url!);
  const root = await mkdtemp(join(tmpdir(), "watcher-lost-events-"));
  const botId = crypto.randomUUID();
  const store = new AgentDataStore(db, { root: join(root, "data"), workspaceRoot: root });
  const memoryPath = join(store.botDirectory(botId), "memory", "profile.md");
  const observe = async (fact: string | null) => {
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const facts = await db.memoryFact.findMany({ where: { namespace: `agent:${botId}` }, select: { fact: true } });
      if (fact === null ? facts.length === 0 : facts.some(value => value.fact === fact)) return;
      await Bun.sleep(25);
    }
    throw new Error(`Watcher failed to reconcile ${fact ?? "deleted memory"}`);
  };
  try {
    await db.bot.create({ data: { id: botId, name: "Lost events", status: "active", defaultDirectory: root } });
    await store.initializeBot(botId);
    await Promise.all(Array.from({ length: 5 }, () => store.startWatching()));
    // Simulate the observed failure: native monitoring stays open but delivers no events.
    (store as unknown as { watcher: { removeAllListeners(event: string): void } }).watcher.removeAllListeners("all");
    await atomicWrite(memoryPath, "- (2026-09-24) Created without a notification.\n");
    await observe("Created without a notification.");
    await atomicWrite(memoryPath, "- (2026-09-24) Updated without a notification.\n");
    await observe("Updated without a notification.");
    await rm(memoryPath);
    await observe(null);
    await store.stopWatching();
    await atomicWrite(memoryPath, "- (2026-09-24) Written after shutdown.\n");
    await Bun.sleep(1300);
    expect(await db.memoryFact.count({ where: { namespace: `agent:${botId}` } })).toBe(0);
  } finally {
    await store.stopWatching();
    await db.bot.deleteMany({ where: { id: botId } });
    await db.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
