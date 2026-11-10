import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { createPrismaClient } from "@openteam/db";
import {
  AgentDataStore,
  AgentMessaging,
  ensureRequestForTask,
  reportRequestProgress,
  settleRequestProgress,
  dispatchRequestChecks,
  recoverRequestProgress,
  stopRequestProgress,
  requestProgressSnapshot,
  requestWakeAllowed,
  type ToolContext,
} from "@openteam/messaging";
import { SubagentService } from "../src/services/subagent/service";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;

test.skipIf(!url)("an approval reply resuming the same worker retains its original broader request without requiring the model to repeat its ID", () => fixture(async f => {
  await f.service.task(f.context, { description: "Approved one-message step", subagent_type: "computerUse", prompt: "Send the approved message once, then read the receipt." });
  const child = await f.db.subagent.findFirstOrThrow({ where: { parentBotId: f.owner.id } });
  await f.db.bot.update({ where: { id: child.childBotId }, data: { status: "active" } });
  await f.db.subagent.update({ where: { id: child.id }, data: { status: "completed" } });
  const reply = await f.db.$transaction(tx => f.messaging.enqueueWake(tx, { botId: f.owner.id, channelId: f.channel.id,
    origin: "user", type: "user.message", content: "Read its status only; do not send anything further.", clientId: crypto.randomUUID(), priority: 300 }));
  await f.db.run.update({ where: { id: reply.run.id }, data: { status: "running" } });
  await f.service.task({ ...f.context, runId: reply.run.id, callId: crypto.randomUUID() }, { description: "Read the existing status", subagent_type: "computerUse",
    resume: `sand-subagent-${child.id}`, prompt: "Read the status only; no further outgoing action is approved.", read_only: true });
  expect(await f.db.subagent.findUniqueOrThrow({ where: { id: child.id } })).toMatchObject({ requestRunId: f.context.runId, readOnly: true });
  expect((await requestProgressSnapshot(f.db, f.owner.id, f.channel.id)).map(s => s.request_run_id)).toEqual([f.context.runId]);
}));
async function fixture(body: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try {
    await body(f);
  } finally {
    const runs = await f.db.run.findMany({ where: { botId: f.owner.id }, select: { id: true } });
    await f.db.idempotencyRecord.deleteMany({
      where: { scope: { in: runs.map((r) => `request-progress:${r.id}`) } },
    });
    const children = await f.db.subagent.findMany({
      where: { parentBotId: f.owner.id },
      select: { childBotId: true },
    });
    const ids = [f.owner.id, ...children.map((c) => c.childBotId)];
    const channels = await f.db.channelMember.findMany({
      where: { botId: { in: ids } },
      select: { channelId: true },
    });
    await f.db.bot.deleteMany({ where: { id: { in: ids } } });
    await f.db.channel.deleteMany({ where: { id: { in: channels.map((c) => c.channelId) } } });
    await f.db.$disconnect();
    await rm(f.dir, { recursive: true, force: true });
  }
}
async function setup() {
  const db = createPrismaClient(url!);
  const dir = await mkdtemp(join(tmpdir(), "request-owner-"));
  const store = new AgentDataStore(db, { root: join(dir, "data"), workspaceRoot: dir });
  await store.writeRootSettings({});
  await store.writeInferenceSettings({
    providerId: "openai-codex",
    modelId: "fixture-model",
    reasoning: "low",
  });
  const messaging = new AgentMessaging(
    db,
    { send: async () => crypto.randomUUID() } as never,
    store
  );
  const owner = await db.bot.create({
    data: {
      name: "Request owner",
      status: "active",
      onboardingStatus: "completed",
      defaultDirectory: dir,
      conversation: { create: {} },
    },
    include: { conversation: true },
  });
  await store.initializeBot(owner.id);
  const channel = await db.channel.create({
    data: {
      kind: "bot_dm",
      name: "Requests",
      directKey: `bot:${owner.id}`,
      members: { create: { botId: owner.id, ordinal: 0 } },
    },
  });
  const wake = await db.$transaction((tx) =>
    messaging.enqueueWake(tx, {
      botId: owner.id,
      channelId: channel.id,
      origin: "user",
      type: "user.message",
      content:
        "Arrange the appointment and verify confirmation. Approve only one message at a time. Private login stays in its secure source.",
      clientId: crypto.randomUUID(),
      priority: 300,
    })
  );
  await db.run.update({ where: { id: wake.run.id }, data: { status: "running" } });
  const context: ToolContext = {
    botId: owner.id,
    runId: wake.run.id,
    channelId: channel.id,
    conversationId: owner.conversation!.id,
    deliveryId: null,
    origin: "user",
    callId: crypto.randomUUID(),
    replyToMessageId: null,
    isFork: false,
  };
  const service = new SubagentService(
    db,
    messaging,
    { cancel: () => Effect.succeed({}) } as never,
    dir,
    async () => Response.json({ stopped: true }),
    store
  );
  return { db, dir, store, messaging, owner, channel, context, service };
}
const wait = (key = "confirmation-pending") => ({
  key,
  state: "waiting" as const,
  summary: "An authorized message was sent once; confirmation remains pending.",
  evidence: ["/appointments/receipt"],
  remaining: ["Verify the appointment confirmation"],
  nextAction: "Read the confirmation status. Ask before any further outgoing message.",
  checkAt: new Date(Date.now() + 3600_000).toISOString(),
  deadline: new Date(Date.now() + 7200_000).toISOString(),
});
async function end(f: Awaited<ReturnType<typeof setup>>, runId = f.context.runId) {
  await f.db.$transaction((tx) => settleRequestProgress(tx, f.messaging, f.owner.id, runId));
}

test.skipIf(!url)(
  "a completed exact-message worker leaves the larger request owned until its parent records a next step",
  () =>
    fixture(async (f) => {
      await f.service.task(f.context, {
        description: "Send the approved message",
        subagent_type: "computerUse",
        prompt:
          "Send exactly this approved message once. Then read status only; no other outgoing messages.",
      });
      const child = await f.db.subagent.findFirstOrThrow({ where: { parentBotId: f.owner.id } });
      expect(child.requestRunId).toBe(f.context.runId);
      await end(f);
      expect(
        await f.db.inboxEvent.count({ where: { botId: f.owner.id, type: "request.check" } })
      ).toBe(0);
      await f.db.subagent.update({
        where: { id: child.id },
        data: {
          status: "completed",
          progress: { state: "complete", remaining: [] },
          nextCheckAt: null,
        },
      });
      await end(f);
      await end(f); // a repeated completion must not enqueue another reminder
      const checks = await f.db.inboxEvent.findMany({
        where: { botId: f.owner.id, type: "request.check" },
      });
      expect(checks).toHaveLength(1);
      expect(await f.db.run.findUniqueOrThrow({ where: { id: f.context.runId } })).toMatchObject({
        requestReconciliations: 1,
        requestNextCheckAt: null,
      });
      const saved = JSON.stringify(
        (await requestProgressSnapshot(f.db, f.owner.id, f.channel.id))[0]
      );
      expect(saved).not.toContain("Private login");
      const outcome = (await reportRequestProgress(f.db, f.context, wait())) as any;
      expect(outcome.request_run_id).toBe(f.context.runId);
      expect(outcome.deferred).toBe(true);
      expect((await f.db.subagent.findUniqueOrThrow({ where: { id: child.id } })).prompt).toBe(
        child.prompt
      );
      expect(
        await f.db.inboxEvent.count({
          where: { botId: f.owner.id, type: "request.check", status: "pending" },
        })
      ).toBe(0);
    })
);

test.skipIf(!url)(
  "a saved parent wait survives a fresh dispatcher and concurrent duplicate checks enqueue once",
  () =>
    fixture(async (f) => {
      const input = wait();
      const [a, b] = await Promise.all([
        reportRequestProgress(f.db, f.context, input),
        reportRequestProgress(f.db, f.context, input),
      ]);
      expect(a).toEqual(b);
      const fresh = new AgentMessaging(
        f.db,
        { send: async () => crypto.randomUUID() } as never,
        f.store
      );
      const future = new Date(Date.now() + 3601_000);
      const results = await Promise.all([
        dispatchRequestChecks(f.db, fresh, future),
        dispatchRequestChecks(f.db, fresh, future),
      ]);
      expect(results.reduce((a, b) => a + b, 0)).toBe(1);
      const checks = await f.db.inboxEvent.findMany({
        where: { botId: f.owner.id, type: "request.check", status: "pending" },
      });
      expect(checks).toHaveLength(1);
      expect(await f.db.$transaction((tx) => requestWakeAllowed(tx, checks[0]!))).toBe(true);
      expect(await f.db.subagent.count({ where: { parentBotId: f.owner.id } })).toBe(0); // no automatic outgoing action
    })
);

test.skipIf(!url)(
  "user cancellation wins against due dispatch and cannot be undone by a late milestone",
  () =>
    fixture(async (f) => {
      await reportRequestProgress(f.db, f.context, wait());
      await Promise.all([
        dispatchRequestChecks(f.db, f.messaging, new Date(Date.now() + 3601_000)),
        f.db.$transaction((tx) => stopRequestProgress(tx, f.owner.id)),
      ]);
      expect(await dispatchRequestChecks(f.db, f.messaging, new Date(Date.now() + 86400_000))).toBe(
        0
      );
      expect(
        await f.db.inboxEvent.count({
          where: { botId: f.owner.id, type: "request.check", status: "pending" },
        })
      ).toBe(0);
      await expect(reportRequestProgress(f.db, f.context, wait("late"))).rejects.toThrow("stopped");
      expect(await requestProgressSnapshot(f.db, f.owner.id, f.channel.id)).toEqual([]);
    })
);

test.skipIf(!url)(
  "a parent-only wait never holds an update, and stopping the bot still ends it",
  () =>
    fixture(async (f) => {
      await reportRequestProgress(f.db, f.context, wait());
      expect(
        (await Effect.runPromise(f.service.busyBots())).bots.find((b) => b.botId === f.owner.id)?.runIds
      ).toContain(f.context.runId);
      await f.db.run.update({ where: { id: f.context.runId }, data: { status: "completed" } });
      expect(
        (await Effect.runPromise(f.service.busyBots())).bots.find((b) => b.botId === f.owner.id)
      ).toBeUndefined();
      expect((await Effect.runPromise(f.service.stopBot(f.owner.id))).hadActiveRun).toBe(true);
      expect(await dispatchRequestChecks(f.db, f.messaging, new Date(Date.now() + 86400_000))).toBe(
        0
      );
    })
);

test.skipIf(!url)("a new check supersedes queued old checks without a second owner", () =>
  fixture(async (f) => {
    await reportRequestProgress(f.db, f.context, wait());
    await dispatchRequestChecks(f.db, f.messaging, new Date(Date.now() + 3601_000));
    const old = await f.db.inboxEvent.findFirstOrThrow({
      where: { botId: f.owner.id, type: "request.check" },
    });
    await reportRequestProgress(f.db, f.context, wait("later-status-check"));
    expect(await f.db.$transaction((tx) => requestWakeAllowed(tx, old))).toBe(false);
    expect((await f.db.run.findUniqueOrThrow({ where: { id: old.runId } })).status).toBe(
      "cancelled"
    );
  })
);

test.skipIf(!url)(
  "a fresh approved step replaces the parent's earlier wait without reviving its old timer",
  () =>
    fixture(async (f) => {
      const pending = wait();
      await reportRequestProgress(f.db, f.context, pending);
      await f.service.task(f.context, {
        request_run_id: f.context.runId,
        description: "Read the changed status",
        subagent_type: "computerUse",
        prompt: "Read the status only. Earlier send approval does not carry over.",
        read_only: true,
      });
      const root = await f.db.run.findUniqueOrThrow({ where: { id: f.context.runId } });
      expect(root.requestProgress).toMatchObject({ state: "working" });
      expect(root.requestNextCheckAt).toBeNull();
      await expect(reportRequestProgress(f.db, f.context, pending)).rejects.toThrow("superseded");
      await expect(reportRequestProgress(f.db, f.context, wait("duplicate-owner"))).rejects.toThrow(
        "unfinished workers"
      );
    })
);

test.skipIf(!url)("a failed durable enqueue leaves the original wait available for one retry", () =>
  fixture(async (f) => {
    await reportRequestProgress(f.db, f.context, wait());
    const unavailable = new AgentMessaging(
      f.db,
      {
        send: async () => {
          throw new Error("queue write unavailable");
        },
      } as never,
      f.store
    );
    const due = new Date(Date.now() + 3601_000);
    await expect(dispatchRequestChecks(f.db, unavailable, due)).rejects.toThrow(
      "queue write unavailable"
    );
    const root = await f.db.run.findUniqueOrThrow({ where: { id: f.context.runId } });
    expect(root.requestProgress).toMatchObject({ state: "waiting" });
    expect(root.requestNextCheckAt).not.toBeNull();
    expect(await dispatchRequestChecks(f.db, f.messaging, due)).toBe(1);
    expect(
      await f.db.inboxEvent.count({ where: { botId: f.owner.id, type: "request.check" } })
    ).toBe(1);
  })
);

test.skipIf(!url)(
  "deleting the original delivery channel retires the wait instead of breaking the dispatcher or recreating a route",
  () =>
    fixture(async (f) => {
      await reportRequestProgress(f.db, f.context, wait());
      await f.db.channel.delete({ where: { id: f.channel.id } });
      expect(await dispatchRequestChecks(f.db, f.messaging, new Date(Date.now() + 3601_000))).toBe(
        0
      );
      expect(
        (await f.db.run.findUniqueOrThrow({ where: { id: f.context.runId } })).requestStoppedAt
      ).not.toBeNull();
    })
);

test.skipIf(!url)(
  "an unresolved turn gets at most three private reconciliation reminders, then a durable blocker",
  () =>
    fixture(async (f) => {
      await f.db.$transaction((tx) => ensureRequestForTask(tx, f.owner.id, f.context.runId));
      for (let i = 0; i < 5; i++) {
        await end(f);
        await f.db.inboxEvent.updateMany({
          where: { botId: f.owner.id, type: "request.check", status: "pending" },
          data: { status: "completed" },
        });
      }
      expect(
        await f.db.inboxEvent.count({ where: { botId: f.owner.id, type: "request.check" } })
      ).toBe(3);
      const root = await f.db.run.findUniqueOrThrow({ where: { id: f.context.runId } });
      expect(root.requestReconciliations).toBe(3);
      expect(root.requestProgress).toMatchObject({ state: "blocked", blockSource: "runtime" });
      expect(root.requestNextCheckAt).toBeNull();
    })
);

test.skipIf(!url)(
  "recovery catches a crash between model completion and parent bookkeeping without duplicating the check",
  () =>
    fixture(async (f) => {
      await f.db.$transaction((tx) => ensureRequestForTask(tx, f.owner.id, f.context.runId));
      await f.db.run.update({ where: { id: f.context.runId }, data: { status: "completed" } });
      await recoverRequestProgress(f.db, f.messaging);
      await recoverRequestProgress(f.db, f.messaging);
      expect(
        await f.db.inboxEvent.count({
          where: { botId: f.owner.id, type: "request.check", status: "pending" },
        })
      ).toBe(1);
    })
);

test.skipIf(!url)(
  "folded independent completions are reconciled together without erasing either request",
  () =>
    fixture(async (f) => {
      await f.db.$transaction((tx) => ensureRequestForTask(tx, f.owner.id, f.context.runId));
      const other = await f.db.$transaction((tx) =>
        f.messaging.enqueueWake(tx, {
          botId: f.owner.id,
          channelId: f.channel.id,
          origin: "user",
          type: "user.message",
          content: "Independently verify the document export too.",
          clientId: crypto.randomUUID(),
          priority: 300,
        })
      );
      await f.db.$transaction((tx) => ensureRequestForTask(tx, f.owner.id, other.run.id));
      await end(f);
      const checks = await f.db.inboxEvent.findMany({
        where: { botId: f.owner.id, type: "request.check", status: "pending" },
      });
      expect(checks).toHaveLength(2);
      expect(checks.map((c) => (c.payload as any).taskContextRunId).sort()).toEqual(
        [f.context.runId, other.run.id].sort()
      );
    })
);

test.skipIf(!url)(
  "independent requests survive interleaving and approval replies explicitly keep the original ownership",
  () =>
    fixture(async (f) => {
      const original = (await reportRequestProgress(f.db, f.context, wait())) as any;
      const other = await f.db.$transaction((tx) =>
        f.messaging.enqueueWake(tx, {
          botId: f.owner.id,
          channelId: f.channel.id,
          origin: "user",
          type: "user.message",
          content: "Find a document too. This is independent of the appointment.",
          clientId: crypto.randomUUID(),
          priority: 300,
        })
      );
      await f.db.run.update({ where: { id: other.run.id }, data: { status: "running" } });
      const next = { ...f.context, runId: other.run.id, callId: crypto.randomUUID() };
      await f.db.$transaction((tx) => ensureRequestForTask(tx, f.owner.id, next.runId));
      await f.service.task(next, {
        request_run_id: original.request_run_id,
        description: "Read pending confirmation",
        subagent_type: "computerUse",
        prompt: "The later user instruction permits reading status only. Do not send anything.",
        read_only: true,
      });
      const child = await f.db.subagent.findFirstOrThrow({ where: { parentBotId: f.owner.id } });
      expect(child.requestRunId).toBe(f.context.runId);
      expect(child.readOnly).toBe(true);
      const snapshots = await requestProgressSnapshot(f.db, f.owner.id, f.channel.id);
      expect(snapshots.map((s) => s.request_run_id).sort()).toEqual(
        [f.context.runId, next.runId].sort()
      );
      await expect(
        reportRequestProgress(f.db, f.context, {
          key: "premature-done",
          state: "complete",
          summary: "A scoped step ended",
          evidence: ["/step"],
          remaining: [],
        })
      ).rejects.toThrow("unfinished workers");
    })
);

test.skipIf(!url)(
  "a required new decision parks the request without a timer and records interpretation versus actual refusal",
  () =>
    fixture(async (f) => {
      await reportRequestProgress(f.db, f.context, {
        key: "changed-terms",
        state: "blocked",
        summary: "The appointment now requires a fee; no fee is approved.",
        evidence: ["/appointments/changed-terms"],
        remaining: ["Obtain the user's fee decision"],
        nextAction: "Ask whether the user accepts the new fee; do not submit anything.",
        blockSource: "user",
      });
      await end(f);
      expect(await dispatchRequestChecks(f.db, f.messaging, new Date(Date.now() + 86400_000))).toBe(
        0
      );
      expect(
        await f.db.inboxEvent.count({ where: { botId: f.owner.id, type: "request.check" } })
      ).toBe(0);
      await expect(
        reportRequestProgress(f.db, f.context, {
          key: "invented-refusal",
          state: "blocked",
          summary: "The tool refused",
          evidence: [],
          remaining: ["Send the authorized message"],
          nextAction: "Resolve block",
          blockSource: "tool",
        })
      ).rejects.toThrow("actual returned error");
    })
);

test.skipIf(!url)(
  "a missed deadline retains reconciliation and evidence instead of authorizing an expired action",
  () =>
    fixture(async (f) => {
      await reportRequestProgress(f.db, f.context, wait());
      await dispatchRequestChecks(f.db, f.messaging, new Date(Date.now() + 86400_000));
      const root = await f.db.run.findUniqueOrThrow({ where: { id: f.context.runId } });
      expect(root.requestProgress).toMatchObject({
        state: "working",
        reconciliationRequired: true,
        nextAction: "Read the confirmation status. Ask before any further outgoing message.",
      });
      expect((root.requestProgress as any).deadline).toBeDefined();
      expect(await f.db.subagent.count({ where: { parentBotId: f.owner.id } })).toBe(0);
    })
);

test.skipIf(!url)(
  "verified completion clears its wait, rejects changed-key replay and stays complete across later turns",
  () =>
    fixture(async (f) => {
      await reportRequestProgress(f.db, f.context, wait());
      const complete = {
        key: "verified-and-delivered",
        state: "complete" as const,
        summary: "Confirmation independently verified and delivered to the user",
        evidence: ["/appointments/confirmation", "message:delivered"],
        remaining: [],
      };
      await reportRequestProgress(f.db, f.context, complete);
      expect(await requestProgressSnapshot(f.db, f.owner.id, f.channel.id)).toEqual([]);
      expect(await dispatchRequestChecks(f.db, f.messaging, new Date(Date.now() + 86400_000))).toBe(
        0
      );
      await end(f);
      await expect(
        reportRequestProgress(f.db, f.context, { ...complete, summary: "different" })
      ).rejects.toThrow("different progress");
      await expect(
        f.db.$transaction((tx) => ensureRequestForTask(tx, f.owner.id, f.context.runId))
      ).rejects.toThrow("completed request");
    })
);

test.skipIf(!url)("an arbitrary request ID cannot cross agents or conversations", () =>
  fixture(async (f) => {
    await expect(
      reportRequestProgress(f.db, f.context, { ...wait(), request_run_id: crypto.randomUUID() })
    ).rejects.toThrow("belong");
    const otherChannel = await f.db.channel.create({
      data: {
        name: "Different conversation",
        kind: "group",
        members: { create: { botId: f.owner.id, ordinal: 0 } },
      },
    });
    const other = await f.db.$transaction((tx) =>
      f.messaging.enqueueWake(tx, {
        botId: f.owner.id,
        channelId: otherChannel.id,
        origin: "user",
        type: "user.message",
        content: "Separate conversation",
        clientId: crypto.randomUUID(),
        priority: 300,
      })
    );
    await expect(
      reportRequestProgress(f.db, f.context, { ...wait(), request_run_id: other.run.id })
    ).rejects.toThrow("conversation");
  })
);
