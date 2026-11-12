import { expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "pg";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;
const deploy = async (databaseUrl: string) => {
  const child = Bun.spawn(["bun", "scripts/deploy-schema.ts"], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code) throw Error(`Schema deploy failed: ${stdout}\n${stderr}`);
};

test("retiring bot instructions clears storage, search and frozen prompts while preserving supported data", async () => {
  if (!url) return;
  const name = `retire_instructions_${crypto.randomUUID().slice(0, 8)}`;
  const admin = new Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  const target = new URL(url);
  target.pathname = `/${name}`;
  const db = new Client({ connectionString: target.toString() });
  try {
    await deploy(target.toString());
    await db.connect();
    // Recreate the retired column and its search trigger, including nonempty data.
    await db.query('ALTER TABLE "Bot" ADD COLUMN "instructions" TEXT NOT NULL DEFAULT \'\'');
    await db.query(`CREATE OR REPLACE FUNCTION public.openteam_refresh_bot_search() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO "SearchDocument" ("id", "kind", "sourceType", "sourceId", "entityId", "botId", "title", "content")
        VALUES ('bot:' || NEW."id", 'bot', 'bot', NEW."id", NEW."id"::text, NEW."id", NEW."name", concat_ws(' ', NEW."description", NEW."instructions"))
        ON CONFLICT ("id") DO UPDATE SET "content" = EXCLUDED."content";
        RETURN NEW;
      END $$`);
    const botId = crypto.randomUUID(),
      contextId = crypto.randomUUID();
    await db.query(
      `INSERT INTO "Bot" ("id", "name", "title", "description", "instructions", "defaultDirectory", "updatedAt")
      VALUES ($1, 'Retirement QA', 'Researcher', 'Find sources', 'retiredguidancecanary', '/tmp', now())`,
      [botId]
    );
    await db.query(
      `INSERT INTO "ContextSession" ("id", "botId", "scope", "scopeId", "updatedAt") VALUES ($1, $2, 'home', $2, now())`,
      [contextId, botId]
    );
    await db.query(
      `INSERT INTO "ContextPromptSnapshot" ("contextSessionId", "promptSections", "updatedAt") VALUES ($1, $2, now())`,
      [
        contextId,
        JSON.stringify({
          agent_instructions: { render: "retiredguidancecanary", compactionEpoch: 0 },
          mcp_instructions: { render: "Keep connector rules", compactionEpoch: 0 },
          memory: { render: "Keep remembered facts", compactionEpoch: 0 },
        }),
      ]
    );
    expect(
      (await db.query('SELECT "content" FROM "SearchDocument" WHERE "botId" = $1', [botId])).rows[0]
        .content
    ).toContain("retiredguidancecanary");

    await deploy(target.toString());
    expect(
      (
        await db.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'Bot' AND column_name = 'instructions'`
        )
      ).rows
    ).toEqual([]);
    expect(
      (await db.query('SELECT "title", "description" FROM "Bot" WHERE "id" = $1', [botId])).rows[0]
    ).toEqual({ title: "Researcher", description: "Find sources" });
    const sections = (
      await db.query(
        'SELECT "promptSections" FROM "ContextPromptSnapshot" WHERE "contextSessionId" = $1',
        [contextId]
      )
    ).rows[0].promptSections;
    expect(sections).not.toHaveProperty("agent_instructions");
    expect(sections.mcp_instructions.render).toBe("Keep connector rules");
    expect(sections.memory.render).toBe("Keep remembered facts");
    expect(
      (await db.query('SELECT "content" FROM "SearchDocument" WHERE "botId" = $1', [botId])).rows[0]
        .content
    ).toBe("Find sources");
    expect(
      (
        await db.query(
          `SELECT count(*)::int AS n FROM "SearchDocument" WHERE "searchVector" @@ plainto_tsquery('simple', 'retiredguidancecanary')`
        )
      ).rows[0].n
    ).toBe(0);
    expect(
      (
        await db.query(
          `SELECT column_name FROM information_schema.columns WHERE table_name = 'PluginConnection' AND column_name = 'instructions'`
        )
      ).rows
    ).toHaveLength(1);
    // The replacement trigger must work after the old column is gone.
    await db.query('UPDATE "Bot" SET "description" = \'Updated intro\' WHERE "id" = $1', [botId]);
    expect(
      (await db.query('SELECT "content" FROM "SearchDocument" WHERE "botId" = $1', [botId])).rows[0]
        .content
    ).toBe("Updated intro");
    await deploy(target.toString());
    expect(
      (await db.query('SELECT "description" FROM "Bot" WHERE "id" = $1', [botId])).rows[0]
        .description
    ).toBe("Updated intro");
  } finally {
    await db.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
}, 120_000);
