import { expect, test } from "bun:test";
import { Client } from "pg";
import { createPrismaClient } from "../src/client";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;

test("dropped Postgres connections fail one query at most and the client reconnects", async () => {
  if (!url) return;
  const tagged = new URL(url);
  tagged.searchParams.set("application_name", `reconnect-${crypto.randomUUID().slice(0, 8)}`);
  const prisma = createPrismaClient(tagged.toString());
  const admin = new Client({ connectionString: url });
  await admin.connect();
  // Ends this client's server sessions, like a Postgres restart or a network drop.
  const dropConnections = () =>
    admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1",
      [tagged.searchParams.get("application_name")]
    );
  try {
    expect(await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`).toEqual([{ ok: 1 }]);
    await dropConnections();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 2 AS ok`).toEqual([{ ok: 2 }]);

    const transaction = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1`;
      await dropConnections();
      await new Promise((resolve) => setTimeout(resolve, 200));
      await tx.$queryRaw`SELECT 1`;
    });
    await expect(transaction).rejects.toThrow();
    expect(await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 3 AS ok`).toEqual([{ ok: 3 }]);
  } finally {
    await prisma.$disconnect();
    await admin.end();
  }
});
