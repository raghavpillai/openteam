import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quietRoutineOriginNote, renderQuietRevivalBatchPrompt, renderRevivalBatchPrompt, RoutineService } from "@openteam/messaging";
import { WakeWorker } from "../src/worker";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
type Notify = (tx: unknown, subagent: Record<string, unknown>, status: "completed" | "failed", result: string) => Promise<void>;

// A real worker and parent bot whose wakes are claimed directly; nothing needs the queue.
async function withParent(run: (input: { worker: WakeWorker; db: WakeWorker["prisma"]; root: string; botId: string; channelId: string; extraBotIds: string[]; notify: Notify; claim: () => Promise<{ runId: string; content: string } | null> }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "revival-batch-"));
  const keys = ["DATABASE_URL", "OPENTEAM_WORKSPACE_ROOT", "OPENTEAM_AGENT_DATA_ROOT"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { DATABASE_URL: databaseUrl, OPENTEAM_WORKSPACE_ROOT: root, OPENTEAM_AGENT_DATA_ROOT: join(root, "data") });
  const worker = new WakeWorker();
  (worker.messaging as unknown as { boss: unknown }).boss = { send: async () => "job" };
  const db = worker.prisma;
  const botId = crypto.randomUUID();
  const channelId = crypto.randomUUID();
  const extraBotIds: string[] = [];
  const notify = (worker as unknown as { notifySubagentParent: Notify }).notifySubagentParent.bind(worker);
  const claim = () => (worker as unknown as { claim(id: string): Promise<{ runId: string; content: string } | null> }).claim(botId);
  try {
    await run({ worker, db, root, botId, channelId, extraBotIds, notify, claim });
  } finally {
    await db.bot.deleteMany({ where: { id: { in: [botId, ...extraBotIds] } } });
    await db.channel.deleteMany({ where: { id: channelId } });
    await worker.stop();
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(root, { recursive: true, force: true });
  }
}

test.skipIf(!databaseUrl)("background results that finish together reach the parent as one revival turn", () => withParent(async ({ worker, db, root, botId, channelId, notify, claim }) => {
    const bot = await db.bot.create({ data: { id: botId, name: "Parent", defaultDirectory: root, status: "active", onboardingStatus: "completed", conversation: { create: {} } }, include: { conversation: true } });
    await db.channel.create({ data: { id: channelId, kind: "bot_dm", name: "Parent", directKey: `bot:${botId}`, members: { create: { botId, ordinal: 0 } } } });
    const source = await db.run.create({ data: { botId, conversationId: bot.conversation!.id, channelId, userMessageId: crypto.randomUUID(), status: "completed", origin: "user" } });
    const subagent = (id: string, description: string) => ({ id, parentBotId: botId, parentRunId: source.id, parentChannelId: channelId, description, prompt: description, subagentType: "executor", currentRunId: crypto.randomUUID(), outputPath: "/tmp/x" });
    await db.$transaction((tx) => notify(tx, subagent("s1", "Find flights"), "completed", "Two nonstops."));
    await worker.messaging.completeShell({ id: "42", scope: botId, channelId, outputPath: "/t/42.log", exitCode: 0, title: "npm test" });
    await db.$transaction((tx) => notify(tx, subagent("s2", "Find hotels"), "failed", "Site blocked."));
    // The flight search finished ten minutes ago, while the parent was busy.
    await db.inboxEvent.updateMany({ where: { botId, idempotencyKey: { startsWith: "subagent:s1:" } }, data: { createdAt: new Date(Date.now() - 10 * 60_000) } });
    const pending = await db.inboxEvent.findMany({ where: { botId }, orderBy: { createdAt: "asc" } });
    expect(pending.map((wake) => wake.type)).toEqual(["subagent.completed", "shell.completed", "subagent.failed"]);

    const claimed = await claim();
    const expected = renderRevivalBatchPrompt([
      { block: 'Background task "Find flights" (executor) finished:\nTwo nonstops.', subagentType: "executor", heldForMs: 10 * 60_000 },
      { block: 'Background task "npm test" (shell) finished:\nFull output: /t/42.log', subagentType: "shell" },
      { block: 'Background task "Find hotels" (executor) failed:\nSite blocked.', subagentType: "executor" },
    ]).replace(/about \d+ minutes ago/, "about 10 minutes ago");
    const body = claimed?.content.match(/^<timestamp>[^<]+<\/timestamp>\n<user_query>\n([\s\S]*)\n<\/user_query>$/)?.[1];
    expect(body).toBe(expected);
    expect(body).toStartWith("[SAND_HIDDEN_PROMPT][A background task just completed] 3 background tasks you started have finished.");

    const after = await db.inboxEvent.findMany({ where: { botId }, include: { run: true } });
    const own = after.find((wake) => wake.runId === claimed!.runId)!;
    expect(own.status).toBe("processing");
    expect((own.payload as { content: string }).content).toBe(claimed!.content);
    expect((await db.message.findFirst({ where: { runId: claimed!.runId } }))?.content).toBe(claimed!.content);
    const folded = after.filter((wake) => wake.runId !== claimed!.runId);
    expect(folded).toHaveLength(2);
    for (const wake of folded) {
      expect(wake.status).toBe("completed");
      expect(wake.run.status).toBe("completed");
    }
    const events = await db.event.findMany({ where: { topic: "inbox.completed", entityId: { in: folded.map((wake) => wake.id) } } });
    expect(events.map((event) => (event.payload as { batchedIntoRunId?: string }).batchedIntoRunId)).toEqual([claimed!.runId, claimed!.runId]);
}));

test.skipIf(!databaseUrl)("a routine hears from its background work once none is running, in one quiet revival", () => withParent(async ({ worker, db, root, botId, channelId, extraBotIds, notify, claim }) => {
  const childIds = [crypto.randomUUID(), crypto.randomUUID()];
  extraBotIds.push(...childIds);
    const bot = await db.bot.create({ data: { id: botId, name: "Parent", defaultDirectory: root, status: "active", onboardingStatus: "completed", conversation: { create: {} } }, include: { conversation: true } });
    for (const id of childIds) await db.bot.create({ data: { id, name: "Child", defaultDirectory: root, status: "active", onboardingStatus: "completed" } });
    await db.channel.create({ data: { id: channelId, kind: "bot_dm", name: "Parent", directKey: `bot:${botId}`, members: { create: { botId, ordinal: 0 } } } });
    const routines = new RoutineService(db, worker.messaging);
    const routine = await routines.mutate(botId, crypto.randomUUID(), null, { action: "create", name: "Price watch", prompt: "Check the kettle prices.", schedule: "@every 1h", enabled: false }) as { id: string };
    const revision = await db.routineRevision.findFirstOrThrow({ where: { routineId: routine.id } });
    const run = await db.run.create({ data: { botId, conversationId: bot.conversation!.id, channelId, userMessageId: crypto.randomUUID(), status: "completed", origin: "routine" } });
    await db.routineExecution.create({ data: { routineId: routine.id, routineRevisionId: revision.id, runId: run.id, kind: "test", status: "running", dedupeKey: `fixture:${run.id}`, scheduledFor: new Date() } });
    // The run started two background tasks and a background shell, then ended its turn.
    const tasks = await Promise.all(["Check store A", "Check store B"].map((prompt, index) => db.subagent.create({
      data: { parentBotId: botId, childBotId: childIds[index]!, parentRunId: run.id, parentChannelId: channelId, launchCallId: `call-${index}`, description: prompt, prompt, subagentType: "executor", status: "running", outputPath: "/tmp/x",
        attempts: { create: { parentRunId: run.id, parentChannelId: channelId, parentToolCallId: `call-${index}`, description: prompt, prompt, status: "running" } } },
      include: { attempts: true },
    })));
    await db.runItem.create({ data: { runId: run.id, kind: "command", status: "completed", content: { shellKind: "background", result: { details: { status: "running", outputPath: "/t/9.log" } } } } });
    const finish = async (index: number, status: "completed" | "failed", result: string) => {
      const task = tasks[index]!;
      await db.$transaction(async (tx) => {
        // Parent notification follows settlement of both the child and its attempt.
        await tx.subagent.update({ where: { id: task.id }, data: { status } });
        await tx.subagentAttempt.update({ where: { id: task.attempts[0]!.id }, data: { status, completedAt: new Date() } });
        await notify(tx, { ...task, currentRunId: crypto.randomUUID() }, status, result);
      });
    };

    await finish(0, "completed", "Store A: $49.");
    // Store B and the shell are still running, so the routine waits for them.
    expect(await claim()).toBeNull();
    await worker.messaging.completeShell({ id: "9", scope: botId, channelId, automationRunId: run.id, outputPath: "/t/9.log", exitCode: 0, title: "fetch prices" });
    expect(await claim()).toBeNull();
    // The first result waited ten minutes; a routine's results are not marked as held.
    await db.inboxEvent.updateMany({ where: { botId, idempotencyKey: { startsWith: `subagent:${tasks[0]!.id}:` } }, data: { createdAt: new Date(Date.now() - 10 * 60_000) } });
    await finish(1, "failed", "Store B blocked the page.");
    const pending = await db.inboxEvent.findMany({ where: { botId }, include: { run: true }, orderBy: { createdAt: "asc" } });
    expect(pending.map((wake) => [wake.type, wake.run.origin])).toEqual([["subagent.completed", "routine"], ["shell.completed", "routine"], ["subagent.failed", "routine"]]);

    const { slug } = await db.routine.findUniqueOrThrow({ where: { id: routine.id } });
    const note = quietRoutineOriginNote({ name: "Price watch", folder: slug });
    const claimed = await claim();
    const expected = renderQuietRevivalBatchPrompt([
      `Background task "Check store A" (executor) finished:\nStore A: $49.\n${note}`,
      `Background task "fetch prices" (shell) finished:\nFull output: /t/9.log\n${note}`,
      `Background task "Check store B" (executor) failed:\nStore B blocked the page.\n${note}`,
    ]);
    const body = claimed?.content.match(/^<timestamp>[^<]+<\/timestamp>\n<user_query>\n([\s\S]*)\n<\/user_query>$/)?.[1];
    expect(body).toBe(expected);
    expect(expected).toStartWith("[SAND_HIDDEN_PROMPT][A background task just completed] 3 background tasks you started have finished.");
    expect(expected).toEndWith("Never message the user just to say that nothing has changed.");
    expect(expected).not.toContain("reached you only now");
    expect(expected).not.toContain("held back");
    const after = await db.inboxEvent.findMany({ where: { botId } });
    expect(after.filter((wake) => wake.runId !== claimed!.runId).every((wake) => wake.status === "completed")).toBe(true);
    expect((await db.message.findFirst({ where: { runId: claimed!.runId } }))?.content).toBe(claimed!.content);
}));
