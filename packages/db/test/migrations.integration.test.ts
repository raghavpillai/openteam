import { expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "pg";

// Each case seeds the shape an older release left behind, then reruns deploy-schema.ts twice.
const url = process.env.OPENTEAM_TEST_DATABASE_URL;
const migration = (name: string, run: (db: Client, deploy: () => Promise<void>) => Promise<void>) =>
  test.skipIf(!url)(name, async () => {
    const database = `migration_${crypto.randomUUID().slice(0, 8)}`;
    const admin = new Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    const target = new URL(url!);
    target.pathname = `/${database}`;
    const deploy = async () => {
      const child = Bun.spawn(["bun", "scripts/deploy-schema.ts"], {
        cwd: join(import.meta.dirname, ".."), env: { ...process.env, DATABASE_URL: target.toString() }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (status !== 0) throw new Error(`deploy-schema exited ${status}\n${stdout}\n${stderr}`);
    };
    const db = new Client({ connectionString: target.toString() });
    try {
      await deploy();
      await db.connect();
      await run(db, deploy);
    } finally {
      await db.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await admin.end();
    }
  }, 120_000);
const rows = async (db: Client, sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows;

migration("a 0.0.8 database with Auto-review settings and approval cards upgrades cleanly, and reruns are no-ops", async (db, deploy) => {
  await db.query(`CREATE TABLE "AutoReviewSettings" ("id" TEXT NOT NULL DEFAULT 'global', "enabled" BOOLEAN NOT NULL DEFAULT true,
    "allowRules" TEXT[] DEFAULT ARRAY[]::TEXT[], "askFirstRules" TEXT[] DEFAULT ARRAY[]::TEXT[], "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AutoReviewSettings_pkey" PRIMARY KEY ("id"))`);
  await db.query(`INSERT INTO "AutoReviewSettings" ("id", "enabled", "allowRules", "askFirstRules", "updatedAt")
    VALUES ('global', false, ARRAY['Emails to a@x.com'], ARRAY['Anything that spends money'], now())`);
  const channel = crypto.randomUUID();
  await db.query(`INSERT INTO "Channel" ("id", "kind", "name", "updatedAt") VALUES ($1, 'bot_dm', 'Ada', now())`, [channel]);
  for (const [content, metadata] of [["Hello", {}], ["Allow Ada to run a command?", { type: "approval", cardState: "pending", surface: "box_shell" }],
    ["Allow Ada to save a routine?", { type: "approval", cardState: "denied", surface: "automation_write" }], ["Draft to Ann", { type: "external-draft", cardState: "pending" }]] as const)
    await db.query(`INSERT INTO "ChannelMessage" ("id", "channelId", "sender", "content", "metadata") VALUES ($1, $2, 'agent', $3, $4)`,
      [crypto.randomUUID(), channel, content, JSON.stringify(metadata)]);
  const tables = async () => (await rows(db, `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = current_schema()`))[0].n as number;
  const messages = async () => (await rows(db, `SELECT content FROM "ChannelMessage" WHERE "channelId" = $1 ORDER BY sequence`, [channel])).map((row) => row.content);
  await deploy();
  expect((await rows(db, `SELECT to_regclass('"AutoReviewSettings"') AS t`))[0].t).toBeNull();
  expect(await messages()).toEqual(["Hello", "Draft to Ann"]);
  const after = await tables();
  await deploy();
  expect(await tables()).toBe(after);
  expect(await messages()).toEqual(["Hello", "Draft to Ann"]);
});

migration("retiring bot instructions clears storage, search and frozen prompts while preserving supported data", async (db, deploy) => {
  // Recreate the retired column and its search trigger, including nonempty data.
  await db.query('ALTER TABLE "Bot" ADD COLUMN "instructions" TEXT NOT NULL DEFAULT \'\'');
  await db.query(`CREATE OR REPLACE FUNCTION public.openteam_refresh_bot_search() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO "SearchDocument" ("id", "kind", "sourceType", "sourceId", "entityId", "botId", "title", "content")
      VALUES ('bot:' || NEW."id", 'bot', 'bot', NEW."id", NEW."id"::text, NEW."id", NEW."name", concat_ws(' ', NEW."description", NEW."instructions"))
      ON CONFLICT ("id") DO UPDATE SET "content" = EXCLUDED."content";
      RETURN NEW;
    END $$`);
  const botId = crypto.randomUUID(), contextId = crypto.randomUUID();
  await db.query(`INSERT INTO "Bot" ("id", "name", "title", "description", "instructions", "defaultDirectory", "updatedAt")
    VALUES ($1, 'Retirement QA', 'Researcher', 'Find sources', 'retiredguidancecanary', '/tmp', now())`, [botId]);
  await db.query(`INSERT INTO "ContextSession" ("id", "botId", "scope", "scopeId", "updatedAt") VALUES ($1, $2, 'home', $2, now())`, [contextId, botId]);
  await db.query(`INSERT INTO "ContextPromptSnapshot" ("contextSessionId", "promptSections", "updatedAt") VALUES ($1, $2, now())`, [contextId, JSON.stringify({
    agent_instructions: { render: "retiredguidancecanary", compactionEpoch: 0 },
    mcp_instructions: { render: "Keep connector rules", compactionEpoch: 0 },
    memory: { render: "Keep remembered facts", compactionEpoch: 0 },
  })]);
  const search = async () => (await rows(db, 'SELECT "content" FROM "SearchDocument" WHERE "botId" = $1', [botId]))[0].content;
  const column = (table: string) => rows(db, `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'instructions'`, [table]);
  expect(await search()).toContain("retiredguidancecanary");
  await deploy();
  expect(await column("Bot")).toEqual([]);
  expect(await column("PluginConnection")).toHaveLength(1);
  expect((await rows(db, 'SELECT "title", "description" FROM "Bot" WHERE "id" = $1', [botId]))[0]).toEqual({ title: "Researcher", description: "Find sources" });
  const sections = (await rows(db, 'SELECT "promptSections" FROM "ContextPromptSnapshot" WHERE "contextSessionId" = $1', [contextId]))[0].promptSections;
  expect(sections).not.toHaveProperty("agent_instructions");
  expect([sections.mcp_instructions.render, sections.memory.render]).toEqual(["Keep connector rules", "Keep remembered facts"]);
  expect(await search()).toBe("Find sources");
  expect((await rows(db, `SELECT count(*)::int AS n FROM "SearchDocument" WHERE "searchVector" @@ plainto_tsquery('simple', 'retiredguidancecanary')`))[0].n).toBe(0);
  // The replacement trigger must work after the old column is gone.
  await db.query('UPDATE "Bot" SET "description" = \'Updated intro\' WHERE "id" = $1', [botId]);
  expect(await search()).toBe("Updated intro");
  await deploy();
  expect((await rows(db, 'SELECT "description" FROM "Bot" WHERE "id" = $1', [botId]))[0].description).toBe("Updated intro");
});

migration("legacy deletion markers upgrade, survive event pruning, and reruns are safe", async (db, deploy) => {
  const [legacyId, groupId, botId] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  // Simulate the tombstone table from before durable cleanup fields were added.
  await db.query(`ALTER TABLE "RetiredAgent" DROP COLUMN "cleanupPending", DROP COLUMN "cleanupRunIds", DROP COLUMN "nextCleanupAt"`);
  await db.query(`INSERT INTO "RetiredAgent" (id, "retiredAt") VALUES ($1, now())`, [legacyId]);
  await db.query(`INSERT INTO "Event" (topic, "entityId", payload) VALUES ('channel.deleted', $1, '{}'), ('channel.deleted', $1, '{}')`, [groupId]);
  // An archived bot remains identifiable even if its original event was already pruned.
  await db.query(`INSERT INTO "Bot" (id, name, "defaultDirectory", status, "updatedAt") VALUES ($1, 'Archived', '/workspace', 'archived', now())`, [botId]);
  await deploy();
  const ids = async () => (await rows(db, `SELECT id FROM "RetiredAgent" ORDER BY id`)).map(({ id }) => id);
  expect(await ids()).toEqual([legacyId, groupId, botId].sort());
  const migrated = (await rows(db, `SELECT "cleanupPending", "cleanupRunIds", "nextCleanupAt" FROM "RetiredAgent" WHERE id = $1`, [legacyId]))[0];
  expect([migrated.cleanupPending, migrated.cleanupRunIds]).toEqual([true, []]);
  expect(migrated.nextCleanupAt).toBeInstanceOf(Date);
  await db.query(`DELETE FROM "Event"`);
  await deploy();
  expect(await ids()).toEqual([legacyId, groupId, botId].sort());
});
