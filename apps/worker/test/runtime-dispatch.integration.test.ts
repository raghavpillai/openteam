import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { TASK_RECOVERY_LOCK } from "@openteam/messaging";
import { dispatchComputerTurn } from "../src/runtime-dispatch";

const url = process.env.OPENTEAM_RECOVERY_TEST_DATABASE_URL;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
async function fixture(
  body: (db: ReturnType<typeof createPrismaClient>, runId: string) => Promise<void>
) {
  const db = createPrismaClient(url!);
  const bot = await db.bot.create({
    data: {
      name: "Dispatch fence",
      defaultDirectory: "/tmp/dispatch-fixture",
      conversation: { create: {} },
    },
    include: { conversation: true },
  });
  const run = await db.run.create({
    data: {
      botId: bot.id,
      conversationId: bot.conversation!.id,
      userMessageId: crypto.randomUUID(),
      status: "running",
    },
  });
  try {
    await body(db, run.id);
  } finally {
    await db.bot.delete({ where: { id: bot.id } });
    await db.$disconnect();
  }
}

test.skipIf(!url)(
  "startup cannot pass the dispatch fence until the computer has accepted the turn",
  () =>
    fixture(async (db, runId) => {
      const accepted = deferred(),
        release = deferred();
      const pending = dispatchComputerTurn(db, runId, async () => {
        accepted.resolve();
        await release.promise;
        return Response.json({ accepted: true });
      });
      await accepted.promise;
      try {
        const lock = await db.$queryRaw<
          { acquired: boolean }[]
        >`SELECT pg_try_advisory_xact_lock(hashtext(${TASK_RECOVERY_LOCK})) AS acquired`;
        expect(lock[0]!.acquired).toBe(false);
      } finally {
        release.resolve();
      }
      expect((await pending).ok).toBe(true);
      const lock = await db.$queryRaw<
        { acquired: boolean }[]
      >`SELECT pg_try_advisory_xact_lock(hashtext(${TASK_RECOVERY_LOCK})) AS acquired`;
      expect(lock[0]!.acquired).toBe(true);
    })
);

test.skipIf(!url)(
  "a claimed turn invalidated by startup is never sent to the computer afterwards",
  () =>
    fixture(async (db, runId) => {
      const locked = deferred(),
        release = deferred();
      let sends = 0;
      const startup = db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${TASK_RECOVERY_LOCK}))`;
        locked.resolve();
        await release.promise;
        await tx.run.update({ where: { id: runId }, data: { status: "interrupted" } });
      });
      await locked.promise;
      const pending = dispatchComputerTurn(db, runId, async () => {
        sends++;
        return Response.json({ accepted: true });
      }).catch((error) => error);
      release.resolve();
      await startup;
      expect(String(await pending)).toContain("invalidated");
      expect(sends).toBe(0);
    })
);

test.skipIf(!url)("dispatch timeout aborts the request and releases recovery's lock", () =>
  fixture(async (db, runId) => {
    await expect(
      dispatchComputerTurn(
        db,
        runId,
        (signal) =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
        50
      )
    ).rejects.toThrow("dispatch timed out");
    const lock = await db.$queryRaw<
      { acquired: boolean }[]
    >`SELECT pg_try_advisory_xact_lock(hashtext(${TASK_RECOVERY_LOCK})) AS acquired`;
    expect(lock[0]!.acquired).toBe(true);
  })
);
