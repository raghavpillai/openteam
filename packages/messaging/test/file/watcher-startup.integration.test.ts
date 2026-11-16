import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "../../src/agent-data";
import { atomicWrite, jsonFile } from "../../src/file-state";
import { renderSkillFile } from "../../src/skill-files";

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


test.skipIf(!url)("watching recovers lost notifications and stops reconciliation on shutdown", async () => {
  const db = createPrismaClient(url!);
  const root = await mkdtemp(join(tmpdir(), "watcher-lost-events-"));
  const botId = crypto.randomUUID();
  const store = new AgentDataStore(db, { root: join(root, "data"), workspaceRoot: root });
  const settingsPath = join(store.botDirectory(botId), "settings.json");
  const observe = async (notificationsEnabled: boolean) => {
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      if ((await db.bot.findUniqueOrThrow({ where: { id: botId } })).notificationsEnabled === notificationsEnabled) return;
      await Bun.sleep(25);
    }
    throw new Error(`Watcher failed to reconcile notificationsEnabled=${notificationsEnabled}`);
  };
  try {
    await db.bot.create({ data: { id: botId, name: "Lost events", status: "active", defaultDirectory: root } });
    await store.initializeBot(botId);
    await Promise.all(Array.from({ length: 5 }, () => store.startWatching()));
    // Simulate the observed failure: native monitoring stays open but delivers no events.
    (store as unknown as { watcher: { removeAllListeners(event: string): void } }).watcher.removeAllListeners("all");
    await atomicWrite(settingsPath, jsonFile({ notifyOnAgentUpdates: false }));
    await observe(false);
    await atomicWrite(settingsPath, jsonFile({ notifyOnAgentUpdates: true }));
    await observe(true);
    await atomicWrite(settingsPath, jsonFile({ notifyOnAgentUpdates: false }));
    await observe(false);
    await rm(settingsPath);
    await observe(true);
    await store.stopWatching();
    await atomicWrite(settingsPath, jsonFile({ notifyOnAgentUpdates: false }));
    await Bun.sleep(1300);
    expect((await db.bot.findUniqueOrThrow({ where: { id: botId } })).notificationsEnabled).toBe(true);
  } finally {
    await store.stopWatching();
    await db.bot.deleteMany({ where: { id: botId } });
    await db.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
