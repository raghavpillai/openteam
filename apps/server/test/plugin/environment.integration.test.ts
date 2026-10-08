import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createPrismaClient } from "@openteam/db";
import { pluginCatalog } from "@openteam/plugins";
import { PluginInstallations } from "../../src/services/plugin/installations";
import { processEnvironment, storeProcessSecret } from "../../src/services/process-secrets";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

test.skipIf(!databaseUrl)(
  "plugin setup secrets reach every Bot's processes, rotate, and leave with the plugin",
  async () => {
    const db = createPrismaClient(databaseUrl!);
    const plugin = pluginCatalog.find((candidate) => candidate.key === "1password")!;
    const installations = new PluginInstallations(
      db,
      async (key) => (key === plugin.key ? plugin : undefined),
      async () => {},
      async () => {}
    );
    const bot = crypto.randomUUID();
    let channel: string | undefined;
    const token = async () => (await processEnvironment(db, bot)).OP_SERVICE_ACCOUNT_TOKEN;
    try {
      await db.pluginInstallation.deleteMany({ where: { pluginKey: plugin.key } });
      await db.processSecret.deleteMany({ where: { ownerKey: `plugin:${plugin.key}` } });
      await db.bot.create({
        data: { id: bot, name: "Plugin secret fixture", defaultDirectory: "/workspace", conversation: { create: {} } },
      });
      channel = (await db.channel.create({ data: { kind: "bot_dm", name: "Owner DM", directKey: `bot:${bot}` } })).id;

      await expect(Effect.runPromise(installations.install(plugin.key, {}))).rejects.toThrow("required");
      expect(await db.pluginInstallation.count({ where: { pluginKey: plugin.key } })).toBe(0);

      await Effect.runPromise(installations.install(plugin.key, { serviceAccountToken: "ops_first" }));
      expect(await token()).toBe("ops_first");

      await Effect.runPromise(installations.updateEnvironment(plugin.key, { serviceAccountToken: "ops_rotated" }));
      expect(await token()).toBe("ops_rotated");

      await storeProcessSecret(db, bot, channel, "OP_SERVICE_ACCOUNT_TOKEN", "ops_bot");
      expect(await token()).toBe("ops_bot");
      await db.processSecret.deleteMany({ where: { ownerKey: `bot:${bot}` } });

      await Effect.runPromise(installations.uninstall(plugin.key));
      expect(await token()).toBeUndefined();
    } finally {
      await db.pluginInstallation.deleteMany({ where: { pluginKey: plugin.key } });
      await db.processSecret.deleteMany({ where: { ownerKey: { in: [`plugin:${plugin.key}`, `bot:${bot}`] } } });
      if (channel) await db.channel.deleteMany({ where: { id: channel } });
      await db.bot.deleteMany({ where: { id: bot } });
      await db.$disconnect();
    }
  }
);
