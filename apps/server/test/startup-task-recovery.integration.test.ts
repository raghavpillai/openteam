import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import {
  AgentDataStore,
  AgentMessaging,
  initialTaskProgress,
  dispatchTaskContinuations,
  TASK_RECOVERY_LOCK,
} from "@openteam/messaging";
import { recover } from "../src/services/startup-recovery";

const url = process.env.OPENTEAM_RECOVERY_TEST_DATABASE_URL;
async function fixture(body: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try {
    await body(f);
  } finally {
    await f.db.bot.deleteMany({ where: { id: { in: f.botIds } } });
    await f.db.channel.deleteMany({ where: { id: { in: f.channelIds } } });
    await f.db.$disconnect();
    await rm(f.root, { recursive: true, force: true });
  }
}
async function setup() {
  const db = createPrismaClient(url!);
  const root = await mkdtemp(join(tmpdir(), "startup-task-recovery-"));
  const store = new AgentDataStore(db, { root, workspaceRoot: root });
  await store.writeRootSettings({});
  const boss = { send: async () => crypto.randomUUID() };
  const messaging = new AgentMessaging(db, boss as never, store);
  const botIds: string[] = [],
    channelIds: string[] = [];
  const make = async (name: string) => {
    const bot = await db.bot.create({
      data: {
        name,
        status: "active",
        onboardingStatus: "completed",
        defaultDirectory: root,
        conversation: { create: {} },
      },
      include: { conversation: true },
    });
    botIds.push(bot.id);
    await store.initializeBot(bot.id);
    const channel = await db.channel.create({
      data: {
        name,
        kind: "bot_dm",
        directKey: `bot:${bot.id}`,
        members: { create: { botId: bot.id, ordinal: 0 } },
      },
    });
    channelIds.push(channel.id);
    const wake = await db.$transaction((tx) =>
      messaging.enqueueWake(tx, {
        botId: bot.id,
        channelId: channel.id,
        origin: "user",
        type: "user.message",
        content: "Inspect the private export; no new fees or publication.",
        clientId: crypto.randomUUID(),
        priority: 300,
      })
    );
    await db.run.update({
      where: { id: wake.run.id },
      data: { status: "running", inputDeliveredAt: new Date() },
    });
    await db.inboxEvent.updateMany({
      where: { runId: wake.run.id },
      data: { status: "processing", claimedAt: new Date() },
    });
    await db.botRunLease.create({
      data: {
        botId: bot.id,
        runId: wake.run.id,
        scope: "foreground",
        ownerId: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 120000),
      },
    });
    return { bot, channel, run: wake.run };
  };
  const parent = await make("Owner"),
    child = await make("Worker");
  // Only the parent is a user-origin request. The child owns a delegated task.
  await db.run.update({ where: { id: child.run.id }, data: { origin: "agent" } });
  const sub = await db.subagent.create({
    data: {
      parentBotId: parent.bot.id,
      childBotId: child.bot.id,
      parentRunId: parent.run.id,
      parentChannelId: parent.channel.id,
      currentRunId: child.run.id,
      launchCallId: crypto.randomUUID(),
      description: "Private export",
      prompt: "Generate once, verify the receipt, keep private and accept no fees.",
      subagentType: "executor",
      status: "running",
      outputPath: "/workspace/report",
      progress: initialTaskProgress(child.run.id),
    },
  });
  const attempt = await db.subagentAttempt.create({
    data: {
      subagentId: sub.id,
      parentRunId: parent.run.id,
      parentChannelId: parent.channel.id,
      parentToolCallId: sub.launchCallId,
      childRunId: child.run.id,
      description: sub.description,
      prompt: sub.prompt,
      status: "running",
    },
  });
  const cancellations: string[] = [];
  const computer = async (path: string) => {
    cancellations.push(path);
    return Response.json({ ok: true });
  };
  return {
    db,
    root,
    store,
    boss,
    messaging,
    botIds,
    channelIds,
    parent,
    child,
    sub,
    attempt,
    cancellations,
    computer,
  };
}

test.skipIf(!url)(
  "startup preserves uncheckpointed obligations and schedules one reconciliation",
  () =>
    fixture(async (f) => {
      await recover(f.db, f.boss as never, f.messaging, f.computer);
      expect(f.cancellations).toContain(`/v1/turns/${f.child.run.id}/cancel`);
      expect(await f.db.subagent.findUnique({ where: { id: f.sub.id } })).toMatchObject({
        status: "waiting",
        recoveryAttempts: 1,
        progress: {
          reconciliationRequired: true,
          remaining: initialTaskProgress(f.child.run.id).remaining,
        },
      });
      expect((await f.db.run.findUniqueOrThrow({ where: { id: f.child.run.id } })).status).toBe(
        "interrupted"
      );
      expect(await f.db.botRunLease.count({ where: { runId: f.child.run.id } })).toBe(0);
      await recover(f.db, f.boss as never, f.messaging, f.computer);
      expect(
        (await f.db.subagent.findUniqueOrThrow({ where: { id: f.sub.id } })).recoveryAttempts
      ).toBe(1);
      expect(await dispatchTaskContinuations(f.db, f.messaging, new Date(Date.now() + 2000))).toBe(
        1
      );
      expect(await dispatchTaskContinuations(f.db, f.messaging, new Date(Date.now() + 2000))).toBe(
        0
      );
      const wake = await f.db.inboxEvent.findFirstOrThrow({
        where: { botId: f.child.bot.id, type: "subagent.continue" },
      });
      expect(JSON.stringify(wake.payload)).toContain("before repeating");
      expect(
        await f.db.inboxEvent.count({
          where: { botId: f.parent.bot.id, type: "runtime.reconcile" },
        })
      ).toBe(1);
    })
);

test.skipIf(!url)("startup fences new queue claims while it stops old Pi contexts", () =>
  fixture(async (f) => {
    let inspected = false;
    const other = createPrismaClient(url!);
    try {
      await recover(f.db, f.boss as never, f.messaging, async () => {
        const result = await other.$queryRaw<
          { acquired: boolean }[]
        >`SELECT pg_try_advisory_xact_lock_shared(hashtext(${TASK_RECOVERY_LOCK})) AS acquired`;
        expect(result[0]!.acquired).toBe(false);
        inspected = true;
        return Response.json({ ok: true });
      });
      expect(inspected).toBe(true);
      const result = await other.$queryRaw<
        { acquired: boolean }[]
      >`SELECT pg_try_advisory_xact_lock_shared(hashtext(${TASK_RECOVERY_LOCK})) AS acquired`;
      expect(result[0]!.acquired).toBe(true);
    } finally {
      await other.$disconnect();
    }
  })
);

test.skipIf(!url)("a failed context stop rolls recovery back without queuing duplicate work", () =>
  fixture(async (f) => {
    await expect(
      recover(
        f.db,
        f.boss as never,
        f.messaging,
        async () => new Response("unavailable", { status: 503 })
      )
    ).rejects.toThrow("Could not reconcile");
    expect((await f.db.subagent.findUniqueOrThrow({ where: { id: f.sub.id } })).status).toBe(
      "running"
    );
    expect(
      await f.db.inboxEvent.count({ where: { type: "subagent.continue", botId: f.child.bot.id } })
    ).toBe(0);
    expect((await f.db.run.findUniqueOrThrow({ where: { id: f.child.run.id } })).status).toBe(
      "running"
    );
  })
);

test.skipIf(!url)(
  "recovery exhaustion leaves an explicit parent-owned blocker with no automatic timer",
  () =>
    fixture(async (f) => {
      await f.db.subagent.update({ where: { id: f.sub.id }, data: { recoveryAttempts: 3 } });
      await recover(f.db, f.boss as never, f.messaging, f.computer);
      expect(await f.db.subagent.findUnique({ where: { id: f.sub.id } })).toMatchObject({
        status: "waiting",
        nextCheckAt: null,
        recoveryAttempts: 3,
        progress: { state: "blocked", blockSource: "runtime" },
      });
      expect(
        await dispatchTaskContinuations(f.db, f.messaging, new Date(Date.now() + 3600000))
      ).toBe(0);
    })
);
