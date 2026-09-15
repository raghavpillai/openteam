import { test, expect } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { storeProcessSecret, processEnvironment } from "../src/services/process-secrets";
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
