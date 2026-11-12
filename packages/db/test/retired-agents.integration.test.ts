import { expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "pg";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;

const deploy = async (databaseUrl: string) => {
  const child = Bun.spawn(["bun", "scripts/deploy-schema.ts"], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (status !== 0) throw new Error(`deploy-schema exited ${status}\n${stdout}\n${stderr}`);
};

test.skipIf(!url)("upgrades legacy deletion markers, preserves them after event pruning, and reruns safely", async () => {
  const name = `retired_agents_${crypto.randomUUID().slice(0, 8)}`;
  const admin = new Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  const target = new URL(url!);
  target.pathname = `/${name}`;
  const db = new Client({ connectionString: target.toString() });
  const legacyId = crypto.randomUUID();
  const groupId = crypto.randomUUID();
  const botId = crypto.randomUUID();
  try {
    await deploy(target.toString());
    await db.connect();
    // Simulate the tombstone table from before durable cleanup fields were added.
    await db.query(`ALTER TABLE "RetiredAgent" DROP COLUMN "cleanupPending", DROP COLUMN "cleanupRunIds", DROP COLUMN "nextCleanupAt"`);
    await db.query(`INSERT INTO "RetiredAgent" (id, "retiredAt") VALUES ($1, now())`, [legacyId]);
    await db.query(`INSERT INTO "Event" (topic, "entityId", payload)
      VALUES ('channel.deleted', $1, '{}'), ('channel.deleted', $1, '{}')`, [groupId]);
    // An archived bot remains identifiable even if its original event was already pruned.
    await db.query(`INSERT INTO "Bot" (id, name, "defaultDirectory", status, "updatedAt")
      VALUES ($1, 'Archived', '/workspace', 'archived', now())`, [botId]);
    await deploy(target.toString());
    const ids = async () => (await db.query(`SELECT id FROM "RetiredAgent" ORDER BY id`)).rows.map(({ id }) => id);
    expect(await ids()).toEqual([legacyId, groupId, botId].sort());
    const migrated = (await db.query(`SELECT "cleanupPending", "cleanupRunIds", "nextCleanupAt" FROM "RetiredAgent" WHERE id = $1`, [legacyId])).rows[0];
    expect(migrated.cleanupPending).toBe(true);
    expect(migrated.cleanupRunIds).toEqual([]);
    expect(migrated.nextCleanupAt).toBeInstanceOf(Date);
    await db.query(`DELETE FROM "Event"`);
    await deploy(target.toString());
    expect(await ids()).toEqual([legacyId, groupId, botId].sort());
  } finally {
    await db.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
}, 120_000);
