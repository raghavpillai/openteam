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


test.skipIf(!url)("watching imports new skill directories after repeated atomic profile replacements", async () => {
  const db = createPrismaClient(url!);
  const root = await mkdtemp(join(tmpdir(), "watcher-replacement-"));
  const botId = crypto.randomUUID();
  const store = new AgentDataStore(db, { root: join(root, "data"), workspaceRoot: root });
  const slug = `watcher-probe-${botId.slice(0, 8)}`;
  const skill = join(store.workflowsDirectory(), slug);
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
      await atomicWrite(join(skill, "SKILL.md"), renderSkillFile({ name: `Replacement skill ${round}`, description: "Watcher probe", body: "Probe." }));
      const deadline = Date.now() + 2000;
      let observed = false;
      while (Date.now() < deadline) {
        const saved = await db.savedSkill.findFirst({ where: { slug, name: `Replacement skill ${round}` } });
        if (saved && (await db.bot.findUniqueOrThrow({ where: { id: botId } })).name === name) {
          observed = true;
          break;
        }
        await Bun.sleep(25);
      }
      expect(observed).toBe(true);
      // The next iteration must rediscover both the directory and its file.
      await rm(skill, { recursive: true, force: true });
      await Bun.sleep(300);
    }
  } finally {
    await store.stopWatching();
    await db.savedSkill.deleteMany({ where: { slug } });
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
  const settingsPath = join(store.botDirectory(botId), "settings.json");
  const observe = async (hiddenFromSidebar: boolean) => {
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      if ((await db.bot.findUniqueOrThrow({ where: { id: botId } })).hiddenFromSidebar === hiddenFromSidebar) return;
      await Bun.sleep(25);
    }
    throw new Error(`Watcher failed to reconcile hiddenFromSidebar=${hiddenFromSidebar}`);
  };
  try {
    await db.bot.create({ data: { id: botId, name: "Lost events", status: "active", defaultDirectory: root } });
    await store.initializeBot(botId);
    await Promise.all(Array.from({ length: 5 }, () => store.startWatching()));
    // Simulate the observed failure: native monitoring stays open but delivers no events.
    (store as unknown as { watcher: { removeAllListeners(event: string): void } }).watcher.removeAllListeners("all");
    await atomicWrite(settingsPath, jsonFile({ hiddenFromSidebar: true }));
    await observe(true);
    await atomicWrite(settingsPath, jsonFile({ hiddenFromSidebar: false }));
    await observe(false);
    await atomicWrite(settingsPath, jsonFile({ hiddenFromSidebar: true }));
    await observe(true);
    await rm(settingsPath);
    await observe(false);
    await store.stopWatching();
    await atomicWrite(settingsPath, jsonFile({ hiddenFromSidebar: true }));
    await Bun.sleep(1300);
    expect((await db.bot.findUniqueOrThrow({ where: { id: botId } })).hiddenFromSidebar).toBe(false);
  } finally {
    await store.stopWatching();
    await db.bot.deleteMany({ where: { id: botId } });
    await db.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
