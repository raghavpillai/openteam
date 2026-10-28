import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { createPrismaClient } from "@openteam/db";
import {
  AgentDataStore,
  AgentMessaging,
  reportTaskProgress,
  dispatchTaskContinuations,
  settleTaskProgress,
  recoverTaskInterruption,
  initialTaskProgress,
  automationBackgroundWorkRunning,
  type ToolContext,
} from "@openteam/messaging";
import { SubagentService } from "../src/services/subagent/service";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;

for (const status of ["partial", "blocked"]) test.skipIf(!url)(
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

test.skipIf(!url)(
  "waiting survives a fresh dispatcher and continues once with original scope and durable obligations",
  () =>
    fixture(async (f) => {
      const check = new Date(Date.now() + 3600_000);
      await reportTaskProgress(f.db, f.messaging, f.context, {
        ...f.progress,
        state: "waiting",
        checkAt: check.toISOString(),
      });
      expect(await f.park()).toBe(true);
      expect(await f.db.subagent.findUnique({ where: { id: f.sub.id } })).toMatchObject({
        status: "waiting",
        nextCheckAt: check,
      });
      expect(await dispatchTaskContinuations(f.db, f.messaging)).toBe(0);
      const restarted = createPrismaClient(url!);
      try {
        const newHost = new AgentMessaging(restarted, f.boss as never, f.store);
        const n = await Promise.all([
          dispatchTaskContinuations(restarted, newHost, new Date(check.getTime() + 1)),
          dispatchTaskContinuations(f.db, f.messaging, new Date(check.getTime() + 1)),
        ]);
        expect(n.reduce((a, b) => a + b, 0)).toBe(1);
        expect(
          await f.db.inboxEvent.count({
            where: { botId: f.child.bot.id, type: "subagent.continue" },
          })
        ).toBe(1);
        const wake = await f.db.inboxEvent.findFirstOrThrow({
          where: { botId: f.child.bot.id, type: "subagent.continue" },
        });
        expect(JSON.stringify(wake.payload)).toContain("Do not add fees");
        expect(JSON.stringify(wake.payload)).toContain("outstanding document request");
        expect(JSON.stringify(wake.payload)).toContain("before repeating");
        await expect(
          reportTaskProgress(f.db, f.messaging, f.context, { ...f.progress, key: "late-old-turn" })
        ).rejects.toThrow("current, active");
      } finally {
        await restarted.$disconnect();
      }
    })
);

test.skipIf(!url)(
  "stopping a parked task cancels its wake and cannot be undone by the dispatcher",
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
        { cancel: () => Effect.succeed({}) } as never,
        f.root,
        async () => Response.json({ stopped: true }),
        f.store
      );
      expect(
        await service.stop(f.parent.bot.id, "user-stop", { subagent_id: f.sub.id })
      ).toMatchObject({ stopped: true, status: "stopped" });
      expect(
        await dispatchTaskContinuations(f.db, f.messaging, new Date(check.getTime() + 1000))
      ).toBe(0);
      expect(
        await f.db.inboxEvent.count({
          where: { botId: f.parent.bot.id, type: "subagent.progress", status: "pending" },
        })
      ).toBe(0);
      expect(await f.db.subagent.findUnique({ where: { id: f.sub.id } })).toMatchObject({
        nextCheckAt: null,
        status: "stopped",
      });
    })
);

test.skipIf(!url)(
  "desktop contention defers a parked task, and a missed deadline returns an explicit blocker",
  () =>
    fixture(async (f) => {
      const check = new Date(Date.now() + 1000),
        deadline = new Date(Date.now() + 3000);
      await reportTaskProgress(f.db, f.messaging, f.context, {
        ...f.progress,
        state: "waiting",
        checkAt: check.toISOString(),
        deadline: deadline.toISOString(),
      });
      await f.park();
      const busy = await f.makeBot("Another task");
      await f.db.subagent.create({
        data: {
          parentBotId: f.parent.bot.id,
          childBotId: busy.bot.id,
          parentRunId: f.parent.run.id,
          parentChannelId: f.parent.channel.id,
          launchCallId: crypto.randomUUID(),
          description: "Independent work",
          prompt: "Another authorized task",
          subagentType: "computerUse",
          status: "running",
          outputPath: "/workspace/other",
        },
      });
      expect(
        await dispatchTaskContinuations(f.db, f.messaging, new Date(check.getTime() + 1))
      ).toBe(0);
      expect(
        await dispatchTaskContinuations(f.db, f.messaging, new Date(deadline.getTime() + 1))
      ).toBe(0);
      const current = await f.db.subagent.findUniqueOrThrow({ where: { id: f.sub.id } });
      expect(current.nextCheckAt).toBeNull();
      expect(current.progress).toMatchObject({
        state: "blocked",
        blockSource: "runtime",
        remaining: f.progress.remaining,
      });
      expect(
        await f.db.inboxEvent.count({
          where: { botId: f.parent.bot.id, type: "subagent.progress" },
        })
      ).toBe(2);
    })
);

test.skipIf(!url)(
  "an early worker finish retains unfinished work instead of announcing completion",
  () =>
    fixture(async (f) => {
      await reportTaskProgress(f.db, f.messaging, f.context, f.progress);
      await f.park();
      const current = await f.db.subagent.findUniqueOrThrow({ where: { id: f.sub.id } });
      expect(current).toMatchObject({ status: "waiting", nextCheckAt: null });
      expect(current.progress).toMatchObject({
        state: "blocked",
        blockSource: "runtime",
        remaining: f.progress.remaining,
      });
      expect(
        await f.db.event.count({ where: { entityId: f.sub.id, topic: "subagent.completed" } })
      ).toBe(0);
    })
);

test.skipIf(!url)(
  "routine-owned milestones keep quiet delivery rules and waiting work keeps the automation open",
  () =>
    fixture(async (f) => {
      await f.db.run.update({ where: { id: f.parent.run.id }, data: { origin: "routine" } });
      const routine = await f.db.routine.create({
        data: {
          botId: f.parent.bot.id,
          slug: "document-watch",
          name: "Document watch",
          prompt: "Only notify when a decision needs attention; keep unchanged checks quiet.",
          scheduleText: "On document update",
          scheduleKind: "event",
          timezone: "UTC",
          revisions: {
            create: {
              revision: 1,
              name: "Document watch",
              prompt: "Only notify when a decision needs attention; keep unchanged checks quiet.",
              scheduleText: "On document update",
              scheduleKind: "event",
              timezoneMode: "installation",
              timezone: "UTC",
              enabled: true,
              source: "test",
            },
          },
        },
        include: { revisions: true },
      });
      try {
        await f.db.routineExecution.create({
          data: {
            routineId: routine.id,
            routineRevisionId: routine.revisions[0]!.id,
            runId: f.parent.run.id,
            kind: "scheduled",
            status: "running",
            dedupeKey: crypto.randomUUID(),
            scheduledFor: new Date(),
          },
        });
        await reportTaskProgress(f.db, f.messaging, f.context, {
          ...f.progress,
          state: "waiting",
          checkAt: new Date(Date.now() + 3600_000).toISOString(),
        });
        const wake = await f.db.inboxEvent.findFirstOrThrow({
          where: { botId: f.parent.bot.id, type: "subagent.progress" },
        });
        expect(wake.payload).toMatchObject({ origin: "background_revival" });
        expect(JSON.stringify(wake.payload)).toContain(
          "Only notify when a decision needs attention"
        );
        expect(await f.db.automationResult.count({ where: { runId: f.parent.run.id } })).toBe(0);
        expect((await f.db.subagent.findUniqueOrThrow({ where: { id: f.sub.id } })).status).toBe(
          "running"
        );
        await f.park();
        expect(
          await f.db.$transaction((tx) =>
            automationBackgroundWorkRunning(tx, f.parent.bot.id, f.parent.run.id)
          )
        ).toBe(true);
        expect(
          (await f.db.routineExecution.findUniqueOrThrow({ where: { runId: f.parent.run.id } }))
            .status
        ).toBe("running");
      } finally {
        await f.db.routineExecution.deleteMany({ where: { routineId: routine.id } });
        await f.db.routine.delete({ where: { id: routine.id } });
      }
    })
);

test.skipIf(!url)(
  "a recorded user stop fences the timer if the host dies before stopping its children",
  () =>
    fixture(async (f) => {
      const check = new Date(Date.now() + 1000);
      await reportTaskProgress(f.db, f.messaging, f.context, {
        ...f.progress,
        state: "waiting",
        checkAt: check.toISOString(),
      });
      await f.park();
      await f.db.run.update({
        where: { id: f.parent.run.id },
        data: { status: "cancelled", error: { code: "cancelled_by_user" } },
      });
      expect(
        await dispatchTaskContinuations(f.db, f.messaging, new Date(check.getTime() + 1))
      ).toBe(0);
      expect(await f.db.subagent.findUnique({ where: { id: f.sub.id } })).toMatchObject({
        status: "stopped",
        nextCheckAt: null,
      });
      expect(
        (await f.db.subagentAttempt.findUniqueOrThrow({ where: { id: f.attempt.id } })).status
      ).toBe("stopped");
    })
);

test.skipIf(!url)(
  "accepted parent scope survives a lost turn and retrying old steering cannot restore superseded instructions",
  () =>
    fixture(async (f) => {
      await reportTaskProgress(f.db, f.messaging, f.context, f.progress);
      const service = new SubagentService(
        f.db,
        f.messaging,
        {} as never,
        f.root,
        async () => Response.json({ ok: true }),
        f.store
      );
      const narrow = {
        subagent_id: f.sub.id,
        message:
          "New user scope: read-only now. Do not send the outstanding document or accept a fee.",
      };
      await service.message(f.parent.bot.id, "narrow-scope", narrow);
      const first = await f.db.subagent.findUniqueOrThrow({ where: { id: f.sub.id } });
      await f.db.run.update({
        where: { id: first.currentRunId! },
        data: { status: "running", inputDeliveredAt: new Date() },
      });
      await service.message(f.parent.bot.id, "further-scope", {
        subagent_id: f.sub.id,
        message: "Also verify the existing receipt title. Keep the read-only restriction.",
      });
      const latest = await f.db.subagent.findUniqueOrThrow({ where: { id: f.sub.id } });
      await service.message(f.parent.bot.id, "narrow-scope", narrow);
      expect(await f.db.subagent.findUnique({ where: { id: f.sub.id } })).toMatchObject({
        currentRunId: latest.currentRunId,
        scopeUpdates: latest.scopeUpdates,
        progressRevision: latest.progressRevision,
      });
      await f.db.run.update({
        where: { id: latest.currentRunId! },
        data: { status: "interrupted" },
      });
      const attempt = await f.db.subagentAttempt.findUniqueOrThrow({
        where: { childRunId: latest.currentRunId! },
      });
      await f.db.$transaction((tx) =>
        recoverTaskInterruption(tx, f.messaging, f.sub.id, latest.currentRunId!, attempt.id, {
          code: "runtime_restart",
        })
      );
      expect(await dispatchTaskContinuations(f.db, f.messaging, new Date(Date.now() + 2000))).toBe(
        1
      );
      const wake = await f.db.inboxEvent.findFirstOrThrow({
        where: { botId: f.child.bot.id, type: "subagent.continue" },
      });
      expect(JSON.stringify(wake.payload)).toContain("Do not send the outstanding document");
      expect(JSON.stringify(wake.payload)).toContain("Also verify the existing receipt title");
      expect(
        (await f.messaging.platformPrompt(f.child.bot.id, crypto.randomUUID())).instructions
      ).toContain("read-only now");
    })
);

test.skipIf(!url)(
  "a new goal resumed after completion gets fresh obligations and can narrow hard read-only scope",
  () =>
    fixture(async (f) => {
      await reportTaskProgress(f.db, f.messaging, f.context, {
        ...f.progress,
        state: "complete",
        remaining: [],
      });
      await f.db.subagent.update({
        where: { id: f.sub.id },
        data: {
          status: "completed",
          fileAttachments: ["/workspace/shared/receipt.png"],
          scopeUpdates: [{ callId: "prior", runId: f.child.run.id, message: "Prior goal context" }],
        },
      });
      await f.db.run.update({ where: { id: f.child.run.id }, data: { status: "completed" } });
      await f.db.subagentAttempt.update({
        where: { id: f.attempt.id },
        data: { status: "completed" },
      });
      const service = new SubagentService(
        f.db,
        f.messaging,
        {} as never,
        f.root,
        async () => Response.json({ ok: true }),
        f.store
      );
      await service.task(
        {
          ...f.context,
          botId: f.parent.bot.id,
          conversationId: f.parent.bot.conversation!.id,
          channelId: f.parent.channel.id,
          runId: f.parent.run.id,
          callId: crypto.randomUUID(),
        },
        {
          resume: f.sub.id,
          description: "Inspect a new dependency",
          prompt: "Inspect the private download availability; read-only, do not submit or share.",
          read_only: true,
        }
      );
      const resumed = await f.db.subagent.findUniqueOrThrow({ where: { id: f.sub.id } });
      expect(resumed).toMatchObject({ readOnly: true });
      expect(resumed.fileAttachments).toEqual(["/workspace/shared/receipt.png"]);
      expect((resumed.scopeUpdates as unknown[]).length).toBe(2);
      expect((resumed.progress as { remaining: string[] }).remaining.length).toBeGreaterThan(0);
      expect(JSON.stringify(resumed.scopeUpdates)).toContain("do not submit or share");
    })
);

test.skipIf(!url)("unchanged wait checks stay quiet and preserve the known deadline", () =>
  fixture(async (f) => {
    const deadline = new Date(Date.now() + 7200_000).toISOString();
    const report = {
      ...f.progress,
      state: "waiting" as const,
      checkAt: new Date(Date.now() + 1000).toISOString(),
      deadline,
    };
    await reportTaskProgress(f.db, f.messaging, f.context, report);
    const { deadline: omitted, ...next } = report;
    await reportTaskProgress(f.db, f.messaging, f.context, {
      ...next,
      key: "later-check",
      checkAt: new Date(Date.now() + 2000).toISOString(),
    });
    expect(
      await f.db.inboxEvent.count({ where: { botId: f.parent.bot.id, type: "subagent.progress" } })
    ).toBe(1);
    expect(
      (await f.db.subagent.findUniqueOrThrow({ where: { id: f.sub.id } })).deadlineAt?.toISOString()
    ).toBe(deadline);
  })
);
