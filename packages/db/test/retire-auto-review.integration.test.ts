import { expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "pg";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;

const deploy = async (databaseUrl: string) => {
  const child = Bun.spawn(["bun", "scripts/deploy-schema.ts"], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (status !== 0) throw new Error(`deploy-schema exited ${status}\n${stdout}\n${stderr}`);
};

test("a 0.0.8 database with Auto-review settings and approval cards upgrades cleanly, and reruns are no-ops", async () => {
  if (!url) return;
  const name = `retire_auto_review_${crypto.randomUUID().slice(0, 8)}`;
  const admin = new Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  const target = new URL(url);
  target.pathname = `/${name}`;
  const db = new Client({ connectionString: target.toString() });
  try {
    // 0.0.8's schema is today's plus the AutoReviewSettings table, created as its db push did.
    await deploy(target.toString());
    await db.connect();
    await db.query(`
      CREATE TABLE "AutoReviewSettings" (
        "id" TEXT NOT NULL DEFAULT 'global',
        "enabled" BOOLEAN NOT NULL DEFAULT true,
        "allowRules" TEXT[] DEFAULT ARRAY[]::TEXT[],
        "askFirstRules" TEXT[] DEFAULT ARRAY[]::TEXT[],
        "updatedAt" TIMESTAMP(3) NOT NULL,
        CONSTRAINT "AutoReviewSettings_pkey" PRIMARY KEY ("id")
      )`);
    await db.query(`INSERT INTO "AutoReviewSettings" ("id", "enabled", "allowRules", "askFirstRules", "updatedAt")
      VALUES ('global', false, ARRAY['Emails to a@x.com'], ARRAY['Anything that spends money'], now())`);
    const channel = crypto.randomUUID();
    await db.query(`INSERT INTO "Channel" ("id", "kind", "name", "updatedAt") VALUES ($1, 'bot_dm', 'Ada', now())`, [channel]);
    const message = (content: string, metadata: unknown) =>
      db.query(`INSERT INTO "ChannelMessage" ("id", "channelId", "sender", "content", "metadata") VALUES ($1, $2, 'agent', $3, $4)`, [
        crypto.randomUUID(), channel, content, JSON.stringify(metadata),
      ]);
    await message("Hello", {});
    await message("Allow Ada to run a command?", { type: "approval", cardState: "pending", surface: "box_shell" });
    await message("Allow Ada to save a routine?", { type: "approval", cardState: "denied", surface: "automation_write" });
    await message("Draft to Ann", { type: "external-draft", cardState: "pending" });

    await deploy(target.toString());
    const tables = async () =>
      (await db.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = current_schema()`)).rows[0].n as number;
    const messages = async () =>
      (await db.query(`SELECT content FROM "ChannelMessage" WHERE "channelId" = $1 ORDER BY sequence`, [channel])).rows.map((row) => row.content);
    expect((await db.query(`SELECT to_regclass('"AutoReviewSettings"') AS t`)).rows[0].t).toBeNull();
    expect(await messages()).toEqual(["Hello", "Draft to Ann"]);
    const after = await tables();

    // A rerun changes nothing.
    await deploy(target.toString());
    expect(await tables()).toBe(after);
    expect(await messages()).toEqual(["Hello", "Draft to Ann"]);
  } finally {
    await db.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
}, 120_000);
