import { expect } from "bun:test";
import { Effect } from "effect";
import { pluginCatalog } from "@openteam/plugins";
import { PluginInstallations } from "../src/services/plugin/installations";
import { processEnvironment, retainPluginEnvironment, storeProcessSecret } from "../src/services/process-secrets";
import { dbIt } from "./harness";

dbIt("named process secrets require owner DM, inherit personal values, and bot overrides stay isolated", async ({ db, bot, onClose }) => {
  const key = `QA_${crypto.randomUUID().replaceAll("-", "")}`;
  onClose(() => db.processSecret.deleteMany({ where: { name: key } }));
  const a = await bot("Secret fixture"), b = await bot("Secret fixture");
  await expect(storeProcessSecret(db, a.id, b.channelId!, key, "synthetic")).rejects.toThrow("owner");
  await expect(storeProcessSecret(db, a.id, a.channelId!, "NODE_OPTIONS", "--inspect")).rejects.toThrow("runtime");
  await storeProcessSecret(db, a.id, a.channelId!, key, "personal-fixture", "personal");
  await storeProcessSecret(db, a.id, a.channelId!, key, "bot-fixture");
  expect((await processEnvironment(db, a.id))[key]).toBe("bot-fixture");
  expect((await processEnvironment(db, b.id))[key]).toBe("personal-fixture");
  await storeProcessSecret(db, a.id, a.channelId!, key, "rotated");
  expect((await processEnvironment(db, a.id))[key]).toBe("rotated");
});

dbIt("plugin setup secrets reach every Bot's processes, rotate, and leave with the plugin", async ({ db, bot: seed, onClose }) => {
  const plugin = pluginCatalog.find(candidate => candidate.key === "1password")!;
  const duplicate = { ...plugin, key: "1password-duplicate-fixture", name: "Duplicate fixture" };
  const keys = [plugin.key, duplicate.key], name = "OP_SERVICE_ACCOUNT_TOKEN";
  const installations = new PluginInstallations(db, async key => [plugin, duplicate].find(candidate => candidate.key === key), async () => {}, async () => {});
  const clean = async () => {
    await db.pluginInstallation.deleteMany({ where: { pluginKey: { in: keys } } });
    await db.processSecret.deleteMany({ where: { OR: [{ ownerKey: { in: keys.map(key => `plugin:${key}`) } }, { name }] } });
  };
  await clean();
  onClose(clean);
  const bot = await seed("Plugin secret fixture");
  const token = async () => (await processEnvironment(db, bot.id))[name];
  const update = (value: string) => Effect.runPromise(installations.updateEnvironment(plugin.key, { serviceAccountToken: value }));
  // Installing without the value succeeds; the plugin page then shows it as not set.
  await Effect.runPromise(installations.install(plugin.key, {}));
  expect(await token()).toBeUndefined();
  await update("  ops_first\n");
  expect(await token()).toBe("ops_first");
  await expect(update("   ")).rejects.toThrow("Enter a new value");
  // Another plugin cannot claim the same environment variable.
  await expect(Effect.runPromise(installations.install(duplicate.key, {}))).rejects.toThrow("already provides");
  // The plugin's value overrides an older personal secret; a Bot's own secret still wins.
  await storeProcessSecret(db, bot.id, bot.channelId!, name, "ops_personal", "personal");
  expect(await token()).toBe("ops_first");
  await storeProcessSecret(db, bot.id, bot.channelId!, name, "ops_bot");
  expect(await token()).toBe("ops_bot");
  await db.processSecret.deleteMany({ where: { ownerKey: { in: ["personal", `bot:${bot.id}`] }, name } });
  // An update that no longer declares the variable drops its value.
  await retainPluginEnvironment(db, plugin.key, ["SOME_OTHER_NAME"]);
  expect(await token()).toBeUndefined();
  await update("ops_rotated");
  expect(await token()).toBe("ops_rotated");
  await Effect.runPromise(installations.uninstall(plugin.key));
  expect(await token()).toBeUndefined();
  await expect(update("ops_late")).rejects.toThrow("not installed");
  expect(await token()).toBeUndefined();
});
