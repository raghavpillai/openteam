import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore, AgentMessaging, reportTaskProgress, dispatchTaskContinuations, settleTaskProgress, initialTaskProgress, type ToolContext } from "@openteam/messaging";
import { SubagentService } from "../src/services/subagent/service";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;

test.skipIf(!url)("a stopped original request fences a parked worker even when its immediate parent turn completed", () => fixture(async f => {
  const check = new Date(Date.now() + 1000);
  await reportTaskProgress(f.db, f.messaging, f.context, { ...f.progress, state: "waiting", checkAt: check.toISOString() });
  await f.park();
  // The request belongs to the same parent bot; its immediate completion wake is a separate turn.
  const request = await f.db.run.create({ data: { botId: f.parent.bot.id, channelId: f.parent.channel.id,
    conversationId: f.parent.bot.conversation!.id, userMessageId: crypto.randomUUID(), status: "completed", requestStoppedAt: new Date() } });
  await f.db.subagent.update({ where: { id: f.sub.id }, data: { requestRunId: request.id } });
  await f.db.run.update({ where: { id: f.parent.run.id }, data: { status: "completed" } });
  expect(await dispatchTaskContinuations(f.db, f.messaging, new Date(check.getTime() + 1))).toBe(0);
  expect(await f.db.subagent.findUniqueOrThrow({ where: { id: f.sub.id } })).toMatchObject({ status: "stopped", nextCheckAt: null });
  expect(await f.db.inboxEvent.count({ where: { botId: f.child.bot.id, type: "subagent.continue" } })).toBe(0);
}));

test.skipIf(!url)("resuming a stopped task retains permission revocation before the new scope", () => fixture(async f => {
  const service = new SubagentService(f.db, f.messaging, { cancel: () => Effect.succeed({}) } as never,
    f.root, async () => Response.json({ stopped: true }), f.store);
  await service.stop(f.parent.bot.id, "stop-before-status-read", { subagent_id: `sand-subagent-${f.sub.id}` });
  const prompt = "Read the existing status only. Do not send, submit or change anything.";
  await service.task({ ...f.context, botId: f.parent.bot.id, runId: f.parent.run.id,
    conversationId: f.parent.bot.conversation!.id, channelId: f.parent.channel.id, callId: crypto.randomUUID() }, {
    description: "Inspect stopped work", subagent_type: "computerUse", resume: `sand-subagent-${f.sub.id}`,
    prompt, read_only: true,
  });
  const resumed = await f.db.subagent.findUniqueOrThrow({ where: { id: f.sub.id } });
  const updates = resumed.scopeUpdates as any[];
  expect(updates).toHaveLength(2);
  expect(updates[0]).toMatchObject({ source: "host_stop", runId: f.child.run.id });
  expect(updates[1].message).toBe(prompt);
  expect(resumed.readOnly).toBe(true);
  expect(resumed.prompt).toBe(f.sub.prompt);
}));

for (const status of ["partial"]) test.skipIf(!url)(
  `an initial ${status} report keeps ownership without copying private report text into progress`,
  () => fixture(async f => {
    const report = `Status: ${status}\nAn outside decision remains pending. Private fixture context: not-for-progress-storage.`;
    await f.db.subagent.update({ where: { id: f.sub.id }, data: { progress: initialTaskProgress(f.child.run.id) as any } });
    expect(await f.db.$transaction(async tx => settleTaskProgress(tx, f.messaging,
      await tx.subagent.findUniqueOrThrow({ where: { id: f.sub.id } }), f.attempt.id, f.child.run.id, report))).toBe(true);
    const saved = await f.db.subagent.findUniqueOrThrow({ where: { id: f.sub.id } });
    expect(saved).toMatchObject({ status: "waiting", nextCheckAt: null, result: report });
    expect(saved.progress).toMatchObject({ state: "blocked", blockSource: "runtime" });
    expect(JSON.stringify(saved.progress)).not.toContain("not-for-progress-storage");
    expect((await f.db.subagentAttempt.findUniqueOrThrow({ where: { id: f.attempt.id } })).result).toBe(report);
    expect(await dispatchTaskContinuations(f.db, f.messaging, new Date(Date.now() + 3600_000))).toBe(0);
  })
);
async function fixture(body: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const f = await createFixture();
  try {
    await body(f);
  } finally {
    await f.db.bot.deleteMany({ where: { id: { in: f.botIds } } });
    await f.db.channel.deleteMany({ where: { id: { in: f.channelIds } } });
    await f.db.idempotencyRecord.deleteMany({ where: { scope: `task-progress:${f.sub.id}` } });
    await f.db.$disconnect();
    await rm(f.root, { recursive: true, force: true });
  }
}
async function createFixture() {
  const db = createPrismaClient(url!);
  const root = await mkdtemp(join(tmpdir(), "durable-task-"));
  const store = new AgentDataStore(db, { root: join(root, "data"), workspaceRoot: root });
  const jobs: unknown[] = [];
  const boss = {
    send: async (...args: unknown[]) => {
      jobs.push(args);
      return crypto.randomUUID();
    },
  };
  const messaging = new AgentMessaging(db, boss as never, store);
  const botIds: string[] = [],
    channelIds: string[] = [];
  const makeBot = async (name: string) => {
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
    const channel = await db.channel.create({
      data: {
        kind: "bot_dm",
        name,
        directKey: `bot:${bot.id}`,
        members: { create: { botId: bot.id, ordinal: 0 } },
      },
    });
    channelIds.push(channel.id);
    await store.initializeBot(bot.id);
    const run = await db.run.create({
      data: {
        botId: bot.id,
        conversationId: bot.conversation!.id,
        channelId: channel.id,
        userMessageId: crypto.randomUUID(),
        status: "running",
      },
    });
    return { bot, channel, run };
  };
  await store.writeRootSettings({});
  const parent = await makeBot("Owner"),
    child = await makeBot("Worker");
  const sub = await db.subagent.create({
    data: {
      parentBotId: parent.bot.id,
      childBotId: child.bot.id,
      parentRunId: parent.run.id,
      parentChannelId: parent.channel.id,
      currentRunId: child.run.id,
      launchCallId: crypto.randomUUID(),
      description: "Finish a delegated workflow",
      prompt:
        "Complete the approved workflow. Do not add fees or send outside the approved destination.",
      subagentType: "computerUse",
      status: "running",
      outputPath: "/workspace/result",
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
  const context = {
    botId: child.bot.id,
    conversationId: child.bot.conversation!.id,
    channelId: child.channel.id,
    runId: child.run.id,
    deliveryId: null,
    callId: crypto.randomUUID(),
  } as ToolContext;
  const progress = {
    key: "verified-stage",
    state: "working" as const,
    summary: "The requested stage is verified",
    evidence: ["https://example.test/case/receipt"],
    remaining: ["Answer the outstanding document request"],
    nextAction: "Inspect the case and provide the authorized document",
  };
  const park = async () => {
    await db.run.update({ where: { id: child.run.id }, data: { status: "completed" } });
    return db.$transaction(async (tx) =>
      settleTaskProgress(
        tx,
        messaging,
        await tx.subagent.findUniqueOrThrow({ where: { id: sub.id } }),
        attempt.id,
        child.run.id
      )
    );
  };
  return {
    db,
    root,
    store,
    boss,
    jobs,
    messaging,
    botIds,
    channelIds,
    makeBot,
    parent,
    child,
    sub,
    attempt,
    context,
    progress,
    park,
  };
}

test.skipIf(!url)(
  "concurrent duplicate milestones save and wake once without finishing or resuming the worker",
  () =>
    fixture(async (f) => {
      const reports = await Promise.all(
        Array.from({ length: 4 }, () =>
          reportTaskProgress(
            f.db,
            f.messaging,
            { ...f.context, callId: crypto.randomUUID() },
            f.progress
          )
        )
      );
      for (const report of reports) expect(report).toEqual(reports[0]!);
      expect(
        await f.db.inboxEvent.count({
          where: { botId: f.parent.bot.id, type: "subagent.progress" },
        })
      ).toBe(1);
      expect(await f.db.subagent.findUnique({ where: { id: f.sub.id } })).toMatchObject({
        status: "running",
        currentRunId: f.child.run.id,
        progressRevision: 1,
      });
      await expect(
        reportTaskProgress(f.db, f.messaging, f.context, {
          ...f.progress,
          summary: "A different result",
        })
      ).rejects.toThrow("milestone key");
      await expect(
        reportTaskProgress(f.db, f.messaging, { ...f.context, botId: f.parent.bot.id }, f.progress)
      ).rejects.toThrow("current, active");
      await reportTaskProgress(f.db, f.messaging, f.context, {
        ...f.progress,
        key: "later-stage",
        summary: "A later stage is verified",
      });
      const replay = await reportTaskProgress(f.db, f.messaging, f.context, f.progress);
      expect(replay).toMatchObject({
        revision: 2,
        deferred: false,
        progress: { summary: "A later stage is verified" },
      });
    })
);

test.skipIf(!url)(
  "new parent instructions replace a parked continuation before its old timer can fire",
  () =>
    fixture(async (f) => {
      const check = new Date(Date.now() + 1000);
      await reportTaskProgress(f.db, f.messaging, f.context, {
        ...f.progress,
        state: "waiting",
        checkAt: check.toISOString(),
      });
      await f.park();
      const service = new SubagentService(
        f.db,
        f.messaging,
        {} as never,
        f.root,
        async () => Response.json({ ok: true }),
        f.store
      );
      const context = {
        ...f.context,
        botId: f.parent.bot.id,
        runId: f.parent.run.id,
        channelId: f.parent.channel.id,
        conversationId: f.parent.bot.conversation!.id,
        callId: crypto.randomUUID(),
      };
      const result = await service.task(context, {
        resume: f.sub.id,
        description: "Apply updated scope",
        prompt: "New user instruction: inspect only. Do not send the document or incur fees.",
      });
      expect(String(result)).toContain("Subagent is running");
      const current = await f.db.subagent.findUniqueOrThrow({ where: { id: f.sub.id } });
      expect(current.nextCheckAt).toBeNull();
      expect(JSON.stringify(current.scopeUpdates)).toContain("inspect only");
      expect(current.prompt).toContain("Do not add fees");
      expect(current.currentRunId).not.toBe(f.child.run.id);
      expect(
        await dispatchTaskContinuations(f.db, f.messaging, new Date(check.getTime() + 1))
      ).toBe(0);
    })
);

test.skipIf(!url)(
  "a user stop wins when an automatic continuation races the cancellation acknowledgement",
  () =>
    fixture(async (f) => {
      const check = new Date(Date.now() + 1000);
      await reportTaskProgress(f.db, f.messaging, f.context, {
        ...f.progress,
        state: "waiting",
        checkAt: check.toISOString(),
      });
      await f.park();
      let raced = false;
      const runs = {
        cancel: (id: string) =>
          Effect.tryPromise(async () => {
            await f.db.run.updateMany({
              where: { id, status: { in: ["queued", "running"] } },
              data: { status: "cancelled" },
            });
            await f.db.inboxEvent.updateMany({
              where: { runId: id, status: "pending" },
              data: { status: "completed" },
            });
          }),
      };
      const service = new SubagentService(
        f.db,
        f.messaging,
        runs as never,
        f.root,
        async () => {
          if (!raced) {
            raced = true;
            expect(
              await dispatchTaskContinuations(f.db, f.messaging, new Date(check.getTime() + 1))
            ).toBe(1);
          }
          return Response.json({ stopped: true });
        },
        f.store
      );
      expect(
        await service.stop(f.parent.bot.id, "cancel-race", { subagent_id: f.sub.id })
      ).toMatchObject({ stopped: true });
      expect((await f.db.subagent.findUniqueOrThrow({ where: { id: f.sub.id } })).status).toBe(
        "stopped"
      );
      expect(
        await f.db.run.count({
          where: { botId: f.child.bot.id, status: { in: ["queued", "running"] } },
        })
      ).toBe(0);
    })
);
