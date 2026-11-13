import { expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "pg";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const databaseTest = databaseUrl ? test : test.skip;

async function deploy(url: string) {
  const child = Bun.spawn([process.execPath, "scripts/deploy-schema.ts"], {
    cwd: join(import.meta.dir, ".."), env: { ...process.env, DATABASE_URL: url }, stdout: "pipe", stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (status) throw new Error(`Memory lease schema deployment failed: ${stdout}\n${stderr}`);
}

databaseTest("upgrading a legacy memory lease timestamp preserves its expiry instant across session time zones and repeat deploys", async () => {
  const name = `memory_lease_upgrade_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new Client({ connectionString: databaseUrl! });
  const target = new URL(databaseUrl!);
  target.pathname = `/${name}`;
  const connections: Client[] = [];
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    // A non-UTC database default makes an accidental UTC reinterpretation
    // during deployment observable. This setting affects only this disposable DB.
    await admin.query(`ALTER DATABASE "${name}" SET timezone TO 'Pacific/Kiritimati'`);
    await deploy(target.toString());
    const db = new Client({ connectionString: target.toString() });
    connections.push(db);
    await db.connect();
    expect((await db.query("SHOW TimeZone")).rows[0].TimeZone).toBe("Pacific/Kiritimati");
    // Reproduce the previous schema without changing any other column or table.
    await db.query(`ALTER TABLE "MemoryReviewLease" ALTER COLUMN "expiresAt"
      TYPE timestamp(3) without time zone USING "expiresAt" AT TIME ZONE current_setting('TimeZone')`);
    const botId = crypto.randomUUID(), ownerId = crypto.randomUUID();
    await db.query(`INSERT INTO "Bot" ("id", "name", "defaultDirectory", "memoryRevision", "updatedAt")
      VALUES ($1::uuid, 'Lease upgrade fixture', '/tmp/memory-lease-upgrade', 7, clock_timestamp())`, [botId]);
    await db.query(`INSERT INTO "MemoryRevision" ("scope", "revision") VALUES ('user', 11)`);
    await db.query(`INSERT INTO "MemoryReviewLease" ("botId", "ownerId", "expiresAt")
      VALUES ($1::uuid, $2::uuid, clock_timestamp() + INTERVAL '10 minutes')`, [botId, ownerId]);
    const before = (await db.query(`SELECT "ownerId",
      round(extract(epoch FROM ("expiresAt" AT TIME ZONE current_setting('TimeZone'))) * 1000)::bigint AS "epochMs"
      FROM "MemoryReviewLease" WHERE "botId" = $1::uuid`, [botId])).rows[0];
    expect((await db.query(`SELECT data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'MemoryReviewLease' AND column_name = 'expiresAt'`)).rows[0].data_type)
      .toBe("timestamp without time zone");

    await deploy(target.toString());
    const readLease = async () => (await db.query(`SELECT "ownerId",
      round(extract(epoch FROM "expiresAt") * 1000)::bigint AS "epochMs",
      "expiresAt" > clock_timestamp() AS future
      FROM "MemoryReviewLease" WHERE "botId" = $1::uuid`, [botId])).rows[0];
    const column = (await db.query(`SELECT data_type, datetime_precision FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'MemoryReviewLease' AND column_name = 'expiresAt'`)).rows[0];
    expect(column).toEqual({ data_type: "timestamp with time zone", datetime_precision: 3 });
    expect(await readLease()).toEqual({ ...before, future: true });
    const anchor = (await db.query("SELECT round(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now")).rows[0].now;

    const views = [];
    for (const zone of ["UTC", "Pacific/Kiritimati"]) {
      const client = new Client({ connectionString: target.toString() });
      connections.push(client);
      await client.connect();
      await client.query("SELECT set_config('TimeZone', $1, false)", [zone]);
      views.push((await client.query(`SELECT "ownerId",
        round(extract(epoch FROM "expiresAt") * 1000)::bigint AS "epochMs",
        round(extract(epoch FROM ("expiresAt" - to_timestamp($2::double precision / 1000))) * 1000)::bigint AS "ttlMs",
        "expiresAt" > clock_timestamp() AS future
        FROM "MemoryReviewLease" WHERE "botId" = $1::uuid`, [botId, anchor])).rows[0]);
      // A contender using either timezone must see the original owner as live.
      const stolen = await client.query(`INSERT INTO "MemoryReviewLease" ("botId", "ownerId", "expiresAt")
        VALUES ($1::uuid, $2::uuid, clock_timestamp() + INTERVAL '30 seconds')
        ON CONFLICT ("botId") DO UPDATE SET "ownerId" = EXCLUDED."ownerId", "expiresAt" = EXCLUDED."expiresAt"
        WHERE "MemoryReviewLease"."expiresAt" <= clock_timestamp() RETURNING "botId"`, [botId, crypto.randomUUID()]);
      expect(stolen.rowCount).toBe(0);
    }
    expect(views[0]).toEqual(views[1]);
    expect(Number(views[0].ttlMs)).toBeGreaterThan(0);
    expect(views[0].epochMs).toBe(before.epochMs);

    await deploy(target.toString());
    expect(await readLease()).toEqual({ ...before, future: true });
    expect((await db.query('SELECT "memoryRevision" FROM "Bot" WHERE "id" = $1::uuid', [botId])).rows[0].memoryRevision).toBe(7);
    expect((await db.query('SELECT "revision" FROM "MemoryRevision" WHERE "scope" = \'user\'')).rows[0].revision).toBe(11);
    expect((await db.query('SELECT count(*)::int AS count FROM "MemoryReviewLease"')).rows[0].count).toBe(1);
  } finally {
    await Promise.allSettled(connections.map(connection => connection.end()));
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
}, 30_000);
