import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { PgBoss } from "pg-boss";
import { workContinuously } from "../src/queue-dispatch";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

test.skipIf(!databaseUrl)("notification workers drain an existing backlog without new notifications", async () => {
  const schema = `dispatch_${crypto.randomUUID().replaceAll("-", "")}`;
  const boss = new PgBoss({ connectionString: databaseUrl!, schema, useListenNotify: true });
  const prisma = createPrismaClient(databaseUrl!);
  const seen = new Set<number>();
  let duplicates = 0;
  let active = 0;
  let peak = 0;
  let finish!: () => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drained = new Promise<void>((resolve) => { finish = resolve; });
  try {
    await boss.start();
    await boss.createQueue("backlog", { notify: true });
    // Seed before registering consumers: a new-arrival NOTIFY cannot rescue
    // consumers that accidentally sleep after each batch of one.
    for (let id = 0; id < 64; id++) await boss.send("backlog", { id });
    await workContinuously<{ id: number }>(boss, "backlog", 8, async (job) => {
      peak = Math.max(peak, ++active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (seen.has(job.data.id)) duplicates++;
        seen.add(job.data.id);
        if (seen.size === 64) finish();
      } finally { active--; }
    });
    await Promise.race([
      drained,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Backlog stalled between batches")), 6_000);
      }),
    ]);
    expect(seen.size).toBe(64);
    expect(duplicates).toBe(0);
    expect(peak).toBeLessThanOrEqual(8);
  } finally {
    clearTimeout(timer);
    await boss.stop({ graceful: true, timeout: 3_000 });
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await prisma.$disconnect();
  }
}, 15_000);
