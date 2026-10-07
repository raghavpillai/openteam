import { test, expect } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { storeProcessSecret, processEnvironment } from "../src/services/process-secrets";
import { SavedLoginTokenCipher } from "../src/services/saved-login-token";
const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
test.skipIf(!databaseUrl)(
  "named process secrets require owner DM, inherit personal values, and bot overrides stay isolated",
  async () => {
    const db = createPrismaClient(databaseUrl!);
    const a = crypto.randomUUID(),
      b = crypto.randomUUID();
    const channels: string[] = [];
    const key = `QA_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      for (const id of [a, b]) {
        await db.bot.create({
          data: {
            id,
            name: "Secret fixture",
            defaultDirectory: "/workspace",
            conversation: { create: {} },
          },
        });
        const c = await db.channel.create({
          data: { kind: "bot_dm", name: "Owner DM", directKey: `bot:${id}` },
        });
        channels.push(c.id);
      }
      await expect(storeProcessSecret(db, a, channels[1]!, key, "synthetic")).rejects.toThrow(
        "owner"
      );
      await expect(
        storeProcessSecret(db, a, channels[0]!, "NODE_OPTIONS", "--inspect")
      ).rejects.toThrow("runtime");
      await storeProcessSecret(db, a, channels[0]!, key, "personal-fixture", "personal");
      await storeProcessSecret(db, a, channels[0]!, key, "bot-fixture");
      expect((await processEnvironment(db, a))[key]).toBe("bot-fixture");
      expect((await processEnvironment(db, b))[key]).toBe("personal-fixture");
      await storeProcessSecret(db, a, channels[0]!, key, "rotated");
      expect((await processEnvironment(db, a))[key]).toBe("rotated");
    } finally {
      await db.processSecret.deleteMany({ where: { name: key } });
      await db.channel.deleteMany({ where: { id: { in: channels } } });
      await db.bot.deleteMany({ where: { id: { in: [a, b] } } });
      await db.$disconnect();
    }
  }
);
test.skipIf(!databaseUrl)(
  "a connected 1Password service account authenticates op unless a named secret overrides it",
  async () => {
    const db = createPrismaClient(databaseUrl!);
    const bot = crypto.randomUUID();
    const vault = `fixture${crypto.randomUUID().replaceAll("-", "")}`;
    const id = `1password:service-account:${vault}`;
    const cipher = new SavedLoginTokenCipher(() => "synthetic-deployment-secret-0123456789");
    let channel: string | undefined;
    try {
      await db.bot.create({
        data: { id: bot, name: "1Password fixture", defaultDirectory: "/workspace", conversation: { create: {} } },
      });
      channel = (await db.channel.create({ data: { kind: "bot_dm", name: "Owner DM", directKey: `bot:${bot}` } })).id;
      await db.savedLoginConnection.create({
        data: { id, accountId: "service-account", vaultId: vault, vaultName: "Fixture", token: cipher.encrypt("ops_synthetic", id) },
      });
      expect((await processEnvironment(db, bot, cipher)).OP_SERVICE_ACCOUNT_TOKEN).toBe("ops_synthetic");
      await storeProcessSecret(db, bot, channel, "OP_SERVICE_ACCOUNT_TOKEN", "ops_named");
      expect((await processEnvironment(db, bot, cipher)).OP_SERVICE_ACCOUNT_TOKEN).toBe("ops_named");
      await db.processSecret.deleteMany({ where: { ownerKey: `bot:${bot}` } });
      await db.savedLoginConnection.update({ where: { id }, data: { enabled: false, token: null } });
      expect((await processEnvironment(db, bot, cipher)).OP_SERVICE_ACCOUNT_TOKEN).not.toBe("ops_synthetic");
    } finally {
      await db.processSecret.deleteMany({ where: { ownerKey: `bot:${bot}` } });
      await db.savedLoginConnection.deleteMany({ where: { id } });
      if (channel) await db.channel.deleteMany({ where: { id: channel } });
      await db.bot.deleteMany({ where: { id: bot } });
      await db.$disconnect();
    }
  }
);
