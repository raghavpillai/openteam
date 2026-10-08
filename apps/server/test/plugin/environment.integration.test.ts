import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createPrismaClient } from "@openteam/db";
import { pluginCatalog } from "@openteam/plugins";
import { PluginInstallations } from "../../src/services/plugin/installations";
import {
  processEnvironment,
  retainPluginEnvironment,
  storeProcessSecret,
} from "../../src/services/process-secrets";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

test.skipIf(!databaseUrl)(
  "plugin setup secrets reach every Bot's processes, rotate, and leave with the plugin",
  async () => {
    const db = createPrismaClient(databaseUrl!);
    const plugin = pluginCatalog.find((candidate) => candidate.key === "1password")!;
    const duplicate = { ...plugin, key: "1password-duplicate-fixture", name: "Duplicate fixture" };
    const installations = new PluginInstallations(
      db,
      async (key) => [plugin, duplicate].find((candidate) => candidate.key === key),
      async () => {},
      async () => {}
    );
    const bot = crypto.randomUUID();
    let channel: string | undefined;
    const token = async () => (await processEnvironment(db, bot)).OP_SERVICE_ACCOUNT_TOKEN;
    const keys = [plugin.key, duplicate.key];
    try {
      await db.pluginInstallation.deleteMany({ where: { pluginKey: { in: keys } } });
      await db.processSecret.deleteMany({
        where: { OR: [{ ownerKey: { in: keys.map((key) => `plugin:${key}`) } }, { name: "OP_SERVICE_ACCOUNT_TOKEN" }] },
      });
      await db.bot.create({
        data: { id: bot, name: "Plugin secret fixture", defaultDirectory: "/workspace", conversation: { create: {} } },
      });
      channel = (await db.channel.create({ data: { kind: "bot_dm", name: "Owner DM", directKey: `bot:${bot}` } })).id;

      // Installing without the value succeeds; the plugin page then shows it as not set.
      await Effect.runPromise(installations.install(plugin.key, {}));
      expect(await token()).toBeUndefined();

      await Effect.runPromise(installations.updateEnvironment(plugin.key, { serviceAccountToken: "  ops_first\n" }));
      expect(await token()).toBe("ops_first");
      await expect(Effect.runPromise(installations.updateEnvironment(plugin.key, { serviceAccountToken: "   " }))).rejects.toThrow(
        "Enter a new value"
      );

      // Another plugin cannot claim the same environment variable.
      await expect(Effect.runPromise(installations.install(duplicate.key, {}))).rejects.toThrow("already provides");

      // The plugin's value overrides an older personal secret; a Bot's own secret still wins.
      await storeProcessSecret(db, bot, channel, "OP_SERVICE_ACCOUNT_TOKEN", "ops_personal", "personal");
      expect(await token()).toBe("ops_first");
      await storeProcessSecret(db, bot, channel, "OP_SERVICE_ACCOUNT_TOKEN", "ops_bot");
      expect(await token()).toBe("ops_bot");
      await db.processSecret.deleteMany({ where: { ownerKey: { in: ["personal", `bot:${bot}`] }, name: "OP_SERVICE_ACCOUNT_TOKEN" } });

      // An update that no longer declares the variable drops its value.
      await retainPluginEnvironment(db, plugin.key, ["SOME_OTHER_NAME"]);
      expect(await token()).toBeUndefined();

      await Effect.runPromise(installations.updateEnvironment(plugin.key, { serviceAccountToken: "ops_rotated" }));
      expect(await token()).toBe("ops_rotated");
      await Effect.runPromise(installations.uninstall(plugin.key));
      expect(await token()).toBeUndefined();
      await expect(Effect.runPromise(installations.updateEnvironment(plugin.key, { serviceAccountToken: "ops_late" }))).rejects.toThrow(
        "not installed"
      );
      expect(await token()).toBeUndefined();
    } finally {
      await db.pluginInstallation.deleteMany({ where: { pluginKey: { in: keys } } });
      await db.processSecret.deleteMany({
        where: { OR: [{ ownerKey: { in: [...keys.map((key) => `plugin:${key}`), `bot:${bot}`] } }, { ownerKey: "personal", name: "OP_SERVICE_ACCOUNT_TOKEN" }] },
      });
      if (channel) await db.channel.deleteMany({ where: { id: channel } });
      await db.bot.deleteMany({ where: { id: bot } });
      await db.$disconnect();
    }
  }
);
