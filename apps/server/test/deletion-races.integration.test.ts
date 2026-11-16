// Bot retirement and group deletion racing workers, settlements, routines and sends.
// Each test parks one side inside its transaction, starts the other, and checks the outcome.
import { expect, test } from "bun:test";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { AgentMessaging, lockAgentLifecycle, RoutineService } from "@openteam/messaging";
import { BotAgentStore } from "../../computer/src/bot-agent-store";
import { NativeToolExecutor } from "../../computer/src/native-tool-executor";
import { Projection } from "../../worker/src/projection";
import { dispatchComputerTurn } from "../../worker/src/runtime-dispatch";
import { BotService } from "../src/services/bot-service";
import { GroupAdministration } from "../src/services/channel/group-administration";
import { bareWorker, databaseUrl, dbIt, fakeBoss, gate, interceptTransactions, waitForLockWaiter, withHarness, type Db, type Harness } from "./harness";

const files = { deleteAgentFiles: async () => {}, repairActiveAgentAfterDeletion: async () => null };
const ok = async () => Response.json({ ok: true });
const archive = (db: Db, id: string, computer = ok, data: unknown = files) => Effect.runPromise(new BotService(db, fakeBoss(), "/unused", computer, data as never).archive(id));
const groups = (db: Db, computer: (path: string, init: RequestInit) => Promise<Response> = ok, h?: Harness) =>
  new GroupAdministration(db, (h?.messaging ?? {}) as never, h?.dir ?? "/unused", computer, h?.store);
/** Resolves to `{}` or `{ error }` so a race's outcome can be compared as data. */
const settled = (promise: Promise<unknown>) => promise.then(() => ({}), error => ({ error: String(error) }));
/** Pauses the first call to `tx.<model>.<method>` matching `when` until `release`. */
const pauseOn = (db: Db, model: string, method: string, reached: { resolve(): void }, release: Promise<void>, when: (input: any) => boolean = () => true) =>
  interceptTransactions(db, (tx, property) => property !== model ? undefined : { ...tx[model], [method]: async (input: any) => {
    const result = await tx[model][method](input);
    if (when(input)) { reached.resolve(); await release; }
    return result;
  } });
const groupRun = async (h: Harness, bot: Awaited<ReturnType<Harness["bot"]>>, roomId: string, status: string, deliveryStatus = status) => {
  const root = await h.db.channelMessage.create({ data: { channelId: roomId, sender: "user", content: "Work" } });
  const round = await h.db.channelRound.create({ data: { channelId: roomId, triggerMessageId: root.id, rootMessageId: root.id, deliveries: { create: { botId: bot.id, ordinal: 0, status: deliveryStatus as never } } }, include: { deliveries: true } });
  return h.run(bot, { channelId: roomId, deliveryId: round.deliveries[0]!.id, status });
};

// ---- Group deletion ----

dbIt("a deleted group cannot return after event pruning, a failed directory cleanup or a stale adoption snapshot", async h => {
  const stores = new BotAgentStore(h.dir, join(h.dir, "retired"));
  h.onClose(() => stores.closeAll());
  const bot = await h.bot("Member", {}, { dm: false });
  const room = await h.channel({ kind: "group", name: "Delete room", members: { create: { botId: bot.id, ordinal: 0 } } });
  await stores.openForWake(room.id);
  await writeFile(join(stores.agentDirectory(room.id), "group.json"), JSON.stringify({ memberIds: [bot.id] }));
  expect(await Effect.runPromise(groups(h.db, async () => { throw new Error("offline"); }).deleteGroup(room.id))).toEqual({ deleted: true, channelId: room.id });
  await h.db.event.deleteMany({ where: { entityId: room.id } });
  const records = await stores.listAgentDirectories();
  expect(records).toHaveLength(1);
  let deletes = 0, snapshots = 0;
  const worker = bareWorker({ prisma: h.db, workspaceRoot: h.dir, agentStoreEtag: null, pendingAgentStoreRecords: new Map(), computerFetch: async (_path: string, init: RequestInit) => {
    if (init.method === "DELETE") return ++deletes === 1 ? new Response("offline", { status: 503 }) : Response.json({ ok: true, removed: await stores.deleteAgent(room.id) });
    return ++snapshots === 1 ? Response.json({ agents: records }, { headers: { etag: '"unchanged"' } }) : new Response(null, { status: 304 });
  } });
  expect(await worker.reconcileAgentStores(false)).toBe(0);
  expect(await worker.reconcileAgentStores(false)).toBe(0);
  expect(deletes).toBe(2);
  expect(await h.db.channel.findUnique({ where: { id: room.id } })).toBeNull();
  expect(await stores.listAgentDirectories()).toEqual([]);
  expect(stores.hasLiveHandle(room.id)).toBe(false);

  // A worker that read the store before another worker adopted and the owner deleted the group.
  const id = crypto.randomUUID(), reached = gate(), release = gate();
  h.channelIds.add(id);
  const record = { id, kind: "group", name: "Delete me", description: "", title: "", createdAt: 1, updatedAt: 1, hasStore: true, notifyOnAgentUpdates: true, hiddenFromSidebar: false, memberIds: [bot.id] };
  const computer = async (_path: string, init: RequestInit) => init.method === "GET" ? Response.json({ agents: [record] }) : Response.json({ ok: true });
  const wrapped = interceptTransactions(h.db, (tx, property) => property !== "$executeRaw" ? undefined : async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (values[0] === `adopt-group:${id}`) { reached.resolve(); await release.promise; }
    return tx.$executeRaw(strings, ...values);
  });
  const adoption = bareWorker({ prisma: wrapped, computerFetch: computer, workspaceRoot: "/unused", agentStoreEtag: null, pendingAgentStoreRecords: new Map() }).reconcileAgentStores(false);
  try {
    await reached.promise;
    await h.db.channel.create({ data: { id, kind: "group", name: "Delete me", members: { create: { botId: bot.id, ordinal: 0 } } } });
    await Effect.runPromise(groups(h.db, computer).deleteGroup(id));
  } finally { release.resolve(); }
  expect({ adopted: await adoption, resurrected: !!await h.db.channel.findUnique({ where: { id } }) }).toEqual({ adopted: 0, resurrected: false });
});

dbIt("group deletion serializes with a worker claim, then retains finished history and leaves unrelated runs alone", async h => {
  const bot = await h.bot("Claim fixture", {}, { dm: false });
  const room = await h.channel({ kind: "group", name: "Delete me", members: { create: { botId: bot.id, ordinal: 0 } } });
  const queued = await groupRun(h, bot, room.id, "queued");
  const finished = await groupRun(h, bot, room.id, "completed");
  await h.db.inboxEvent.create({ data: { botId: bot.id, conversationId: bot.conversationId, runId: queued.id, idempotencyKey: crypto.randomUUID(), type: "channel.message", payload: { content: "Work", clientId: crypto.randomUUID() } } });
  const claimWrite = gate(), releaseClaim = gate(), contended = gate();
  const claimDb = interceptTransactions(h.db, (tx, property) => property !== "run" ? undefined : { ...tx.run, update: async (input: any) => {
    if (input.data.status === "running") { claimWrite.resolve(); await releaseClaim.promise; }
    return tx.run.update(input);
  } });
  const claim = settled(bareWorker({ prisma: claimDb, workspaceRoot: "/unused", messaging: { assets: { runtimeImages: async () => [] } } }).claim(bot.id));
  await claimWrite.promise;
  const unrelated = await h.run(bot);
  const deleteDb = interceptTransactions(h.db, (tx, property) => {
    if (property === "$executeRaw") return async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (values[0] === `group-execution:${room.id}`) contended.resolve();
      return tx.$executeRaw(strings, ...values);
    };
    if (property === "run") return { ...tx.run, updateMany: async (input: any) => { const result = await tx.run.updateMany(input); contended.resolve(); return result; } };
  });
  const deletion = settled(Effect.runPromise(groups(deleteDb).deleteGroup(room.id)));
  await contended.promise;
  releaseClaim.resolve();
  expect(await Promise.all([claim, deletion])).toEqual([{}, {}]);
  expect(await h.db.channel.findUnique({ where: { id: room.id } })).toBeNull();
  expect(await h.db.run.findUniqueOrThrow({ where: { id: queued.id } })).toMatchObject({ status: "cancelled", channelId: null, deliveryId: null });
  expect(await h.db.run.findUniqueOrThrow({ where: { id: finished.id } })).toMatchObject({ status: "completed", channelId: null, deliveryId: null });
  expect((await h.db.run.findUniqueOrThrow({ where: { id: unrelated.id } })).status).toBe("running");
  expect(await h.db.channelRound.count({ where: { channelId: room.id } })).toBe(0);
  let sends = 0;
  await expect(dispatchComputerTurn(h.db, queued.id, async () => { sends++; return Response.json({ ok: true }); })).rejects.toThrow("invalidated");
  expect(sends).toBe(0);
}, 20_000);

test.skipIf(!databaseUrl || process.platform === "win32")("room deletion stops completed turns' background commands without stopping another room", () => withHarness(async h => {
  await chmod(h.dir, 0o755);
  const executor = new NativeToolExecutor({ agentDir: h.dir, controlToken: "fixture" });
  const bot = await h.bot("Member", {}, { dm: false });
  const jobs: string[] = [], rooms: string[] = [];
  const status = async (id: string, wait = 0) => (await executor.awaitShell({ shell_id: id, block_until_ms: wait }, undefined, bot.id)).details.status;
  h.onClose(async () => { executor.stopBackgroundShells(bot.id); await Promise.all(jobs.map(job => status(job, 5000).catch(() => {}))); });
  for (let i = 0; i < 2; i++) {
    const room = await h.channel({ kind: "group", name: `Room ${i}`, members: { create: { botId: bot.id, ordinal: 0 } } });
    rooms.push(room.id);
    await h.run(bot, { channelId: room.id, status: "completed" });
    jobs.push(String((await executor.shell({ command: "sleep 20", block_until_ms: 0 }, h.dir, undefined, undefined, bot.id, { channelId: room.id })).details?.shellId));
  }
  const administration = new GroupAdministration(h.db, {} as never, h.dir, async path => {
    const match = path.match(/^\/v1\/bots\/([^/]+)\/background-shells\/stop$/);
    return Response.json({ ok: true, ...(match ? { stopped: executor.stopBackgroundShells(decodeURIComponent(match[1]!)) } : {}) });
  });
  expect(await Effect.runPromise(administration.deleteGroup(rooms[0]!))).toEqual({ deleted: true, channelId: rooms[0]! });
  expect(await status(jobs[0]!, 3000)).toBe("completed");
  expect(await status(jobs[1]!)).toBe("running");
  expect(await h.db.channel.findUnique({ where: { id: rooms[1] } })).not.toBeNull();
}));

// ---- Bot archive against in-flight work ----

dbIt("archive includes a child whose launch commits while deletion waits for the lifecycle lock", async h => {
  const parent = await h.bot("Parent", {}, { dm: false });
  const childId = crypto.randomUUID(), locked = gate(), releaseLaunch = gate(), archiveWaiting = gate();
  const launch = h.db.$transaction(async tx => {
    await lockAgentLifecycle(tx, parent.id);
    locked.resolve();
    await releaseLaunch.promise;
    const child = await tx.bot.create({ data: { id: childId, name: "Late child", defaultDirectory: "/unused", status: "active", conversation: { create: {} } }, include: { conversation: true } });
    const run = await tx.run.create({ data: { botId: childId, conversationId: child.conversation!.id, userMessageId: crypto.randomUUID(), status: "running" } });
    await tx.subagent.create({ data: { parentBotId: parent.id, childBotId: childId, parentRunId: crypto.randomUUID(), parentChannelId: crypto.randomUUID(), launchCallId: crypto.randomUUID(), description: "Late child", prompt: "Work", subagentType: "executor", status: "running", currentRunId: run.id, outputPath: "/unused/child.jsonl" } });
  });
  h.botIds.add(childId);
  await locked.promise;
  const archiveDb = interceptTransactions(h.db, (tx, property) => property !== "$executeRaw" ? undefined : async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (values[0] === `agent-lifecycle:${parent.id}`) archiveWaiting.resolve();
    return tx.$executeRaw(strings, ...values);
  });
  const archived = archive(archiveDb, parent.id);
  await archiveWaiting.promise;
  releaseLaunch.resolve();
  await launch; await archived;
  expect((await h.db.bot.findUniqueOrThrow({ where: { id: childId } })).status).toBe("archived");
  expect(await h.db.run.count({ where: { botId: childId, status: "running" } })).toBe(0);
  expect(await h.db.retiredAgent.findUnique({ where: { id: childId } })).not.toBeNull();
});

dbIt("a delayed runtime acceptance must not start work after archive already returned", async h => {
  const bot = await h.bot("Delayed dispatch", {}, { dm: false });
  const run = await h.run(bot);
  const started = gate(), accept = gate();
  let active = false, archiveDone = false;
  const dispatch = dispatchComputerTurn(h.db, run.id, async () => { started.resolve(); await accept.promise; active = true; return Response.json({ ok: true }); });
  await started.promise;
  const archived = archive(h.db, bot.id, (async (path: string) => {
    if (path.endsWith("/cancel")) {
      if (!active) return new Response("Run is not actively executing", { status: 400 });
      active = false;
    }
    return Response.json({ ok: true });
  }) as never).then(() => { archiveDone = true; });
  const fenced = await waitForLockWaiter(h.db, () => archiveDone, "%Run%");
  const returnedBeforeAcceptance = archiveDone;
  accept.resolve(); await dispatch; await archived;
  expect({ returnedBeforeAcceptance, runtimeActive: active, fenced }).toEqual({ returnedBeforeAcceptance: false, runtimeActive: false, fenced: true });
}, 15_000);

for (const kind of ["completion", "failure"] as const) dbIt(`a late ${kind} cannot overwrite deletion after reading a running turn`, async h => {
  const bot = await h.bot("Late settlement", {}, { dm: false });
  const run = await h.run(bot);
  const inbox = await h.db.inboxEvent.create({ data: { botId: bot.id, conversationId: run.conversationId, runId: run.id, idempotencyKey: crypto.randomUUID(), type: "user.message", status: "processing", payload: {} } });
  const read = gate(), release = gate();
  const wrapped = pauseOn(h.db, "run", kind === "completion" ? "findUniqueOrThrow" : "findUnique", read, release.promise);
  const settlement = kind === "completion"
    ? new Projection(wrapped).apply(run.id, run.conversationId, bot.id, { type: "turn.completed", status: "completed" } as never)
    : bareWorker({ prisma: wrapped, messaging: { scheduleTranscriptProjection: async () => {} }, routines: { afterExecution: async () => {} } })
      .fail({ runId: run.id, botId: bot.id, inboxId: inbox.id, origin: "user", ownerId: "fixture" }, new Error("late disconnect"), true);
  await read.promise;
  let archived = false;
  const archiving = archive(h.db, bot.id).then(() => { archived = true; });
  // Deletion must wait on the settlement's run row before persisting its authoritative cancellation.
  await waitForLockWaiter(h.db, () => archived, "%Run%");
  const archivedBeforeSettlement = archived;
  release.resolve(); await settlement; await archiving;
  const final = await h.db.run.findUniqueOrThrow({ where: { id: run.id } });
  // A completion that wins first stays completed history; a failure that wins first is interrupted.
  expect({ archivedBeforeSettlement, status: final.status, code: (final.error as any)?.code }).toEqual({
    archivedBeforeSettlement: false, status: kind === "completion" ? "completed" : "interrupted", code: kind === "completion" ? undefined : "runtime_interrupted",
  });
}, 15_000);

dbIt("parent deletion and a child's failure settle without a run/subagent deadlock", async h => {
  const parent = await h.bot("Parent", {}, { dm: false }), child = await h.bot("Failing child", {}, { dm: false });
  const parentRun = await h.run(parent), childRun = await h.run(child);
  const sub = await h.db.subagent.create({ data: {
    parentBotId: parent.id, childBotId: child.id, parentRunId: parentRun.id, parentChannelId: crypto.randomUUID(), launchCallId: crypto.randomUUID(),
    description: "Child", prompt: "Work", subagentType: "executor", status: "running", currentRunId: childRun.id, outputPath: "/unused/child-output.jsonl",
  } });
  await h.db.subagentAttempt.create({ data: { subagentId: sub.id, parentRunId: sub.parentRunId, parentChannelId: sub.parentChannelId, parentToolCallId: sub.launchCallId, childRunId: childRun.id, description: sub.description, prompt: sub.prompt, status: "running" } });
  const inbox = await h.db.inboxEvent.create({ data: { botId: child.id, conversationId: childRun.conversationId, runId: childRun.id, idempotencyKey: crypto.randomUUID(), type: "subagent.task", status: "processing", payload: {} } });
  const read = gate(), release = gate();
  const worker = bareWorker({ prisma: pauseOn(h.db, "run", "update", read, release.promise), messaging: { scheduleTranscriptProjection: async () => {} }, routines: { afterExecution: async () => {} }, notifySubagentParent: async () => {} });
  const failure = settled(worker.fail({ runId: childRun.id, botId: child.id, inboxId: inbox.id, origin: "subagent", ownerId: "fixture" }, new Error("late disconnect"), true));
  await read.promise;
  const archiving = settled(archive(h.db, parent.id));
  const waiting = await waitForLockWaiter(h.db, undefined, "%Run%");
  release.resolve();
  expect(await Promise.all([failure, archiving])).toEqual([{}, {}]);
  expect(waiting).toBe(true);
  expect(await h.db.bot.count({ where: { id: { in: [parent.id, child.id] }, status: "archived" } })).toBe(2);
  expect(await h.db.run.count({ where: { botId: { in: [parent.id, child.id] }, status: { in: ["queued", "running"] } } })).toBe(0);
}, 15_000);

for (const failure of [null, "context-network", "active-context"] as const) dbIt(`archive cancels the parent turn before deleting its context${failure ? ` and survives ${failure}, keeping cleanup pending` : ""}`, async h => {
  const bot = await h.bot("Archived", {}, { dm: false });
  const run = await h.run(bot);
  const session = await h.db.contextSession.create({ data: { botId: bot.id, scope: "home", scopeId: bot.conversationId, runtimeSessionPath: `/sessions/${bot.id}.jsonl` } });
  const calls: string[] = [];
  let runtimeActive = true, cancelBody: unknown, contextWasActive: boolean | undefined;
  const states: string[] = [];
  const computer = async (path: string, init: RequestInit) => {
    calls.push(path);
    // Every runtime call happens after the archive and its cancellation have committed.
    states.push(`${(await h.db.bot.findUniqueOrThrow({ where: { id: bot.id } })).status}/${(await h.db.run.findUniqueOrThrow({ where: { id: run.id } })).status}`);
    if (path.endsWith("/cancel")) { cancelBody = JSON.parse(String(init.body)); runtimeActive = false; }
    if (path.includes("context-sessions")) {
      contextWasActive = runtimeActive;
      if (failure === "context-network") throw new TypeError("fetch failed");
      if (failure === "active-context" || runtimeActive) return new Response("Cannot delete an active context session", { status: 500 });
    }
    return Response.json({ ok: true });
  };
  expect(await archive(h.db, bot.id, computer as never)).toEqual({ ok: true });
  expect(cancelBody).toEqual({ reason: "stop", recovery: true });
  expect(contextWasActive).toBe(false);
  expect(calls.indexOf(`/v1/turns/${run.id}/cancel`)).toBeLessThan(calls.indexOf(`/v1/context-sessions/${session.id}`));
  expect(calls).toEqual(expect.arrayContaining([`/v1/bots/${bot.id}/background-shells/stop`, `/v1/agent-stores/${bot.id}`, `/v1/screens/${bot.id}`]));
  expect(new Set(states)).toEqual(new Set(["archived/cancelled"]));
  expect(!!await h.db.contextSession.findUnique({ where: { id: session.id } })).toBe(!!failure);
  expect((await h.db.retiredAgent.findUniqueOrThrow({ where: { id: bot.id } })).cleanupPending).toBe(!!failure);
});

// ---- Retirement against wake entry points ----

async function pair(h: Harness) {
  const source = await h.bot("Source"), target = await h.bot("Target");
  const run = await h.run(source);
  return { source, target, context: h.context(source, { runId: run.id }), retire: (id: string) => archive(h.db, id, ok, h.store) };
}

for (const kind of ["peer", "manual-routine", "scheduled-routine", "event-followup", "shell-callback"] as const) dbIt(`${kind} cannot leave a new queued wake behind target retirement`, async h => {
  const { target, context, retire } = await pair(h);
  const selected = gate(), release = gate();
  let pause = true, archived = false;
  const wrapped = pauseOn(h.db, "bot", "findUnique", selected, release.promise, input => pause && input.where.id === target.id && !!input.include?.conversation);
  const messaging = new AgentMessaging(wrapped, h.messaging.boss, h.store);
  let pending: Promise<unknown>;
  if (kind === "peer") pending = messaging.sendToAgent(context, { target_id: target.id, message: "Work from peer" });
  else if (kind === "shell-callback") pending = messaging.completeShell({ id: "123", scope: target.id, exitCode: 0, outputPath: "/unused/123.log" });
  else {
    const routines = new RoutineService(wrapped, messaging);
    const routine = await routines.mutate(target.id, crypto.randomUUID(), null, { action: "create", name: "Deletion race", prompt: "Check once", enabled: true,
      ...(kind === "event-followup" ? { trigger: { type: "github", repo: "org/repo", ciBranch: "main", events: ["ci-failed"] } } : { schedule: "@every 5m" }) });
    if (kind === "event-followup") {
      pause = false;
      const event = { id: "first", source: "github", kind: "ci-failed", repo: "org/repo", branch: "main", text: "Failed" };
      const [first] = await routines.dispatchEvent({ kind: "bot", id: target.id }, event);
      const mark = async (status: string, inbox: string) => {
        await h.db.run.update({ where: { id: first!.runId! }, data: { status: status as never } });
        await h.db.routineExecution.update({ where: { id: first!.id }, data: { status: status as never } });
        await h.db.inboxEvent.updateMany({ where: { runId: first!.runId! }, data: { status: inbox as never } });
      };
      await mark("running", "processing");
      await routines.dispatchEvent({ kind: "bot", id: target.id }, { ...event, id: "follow-up" });
      await mark("completed", "completed");
      pause = true;
      pending = wrapped.$transaction(tx => routines.startEventFollowUp(tx, String(routine.id)));
    } else if (kind === "manual-routine") pending = routines.runNow(target.id, String(routine.id), crypto.randomUUID());
    else {
      await h.db.routine.update({ where: { id: String(routine.id) }, data: { nextRunAt: new Date(Date.now() - 1000) } });
      pending = routines.dispatchDue(new Date());
    }
  }
  try {
    await selected.promise;
    const deletion = retire(target.id).then(() => { archived = true; });
    await waitForLockWaiter(h.db, () => archived);
    release.resolve(); await pending; await deletion;
  } finally { release.resolve(); await pending.catch(() => {}); }
  expect(await h.db.run.count({ where: { botId: target.id, status: { in: ["queued", "running"] } } })).toBe(0);
  expect(await h.db.inboxEvent.count({ where: { botId: target.id, status: { in: ["pending", "processing"] } } })).toBe(0);
}, 15_000);

dbIt("an admitted room send cannot publish after its source agent was retired", async h => {
  const { source, target, context, retire } = await pair(h);
  const room = await h.channel({ kind: "group", name: "Room", members: { create: [source, target].map((bot, ordinal) => ({ botId: bot.id, ordinal })) } });
  const selected = gate(), release = gate();
  let archived = false;
  const messaging = new AgentMessaging(pauseOn(h.db, "channel", "findFirst", selected, release.promise, input => input.where.id === room.id), h.messaging.boss, h.store);
  const pending = messaging.sendVisible({ ...context, channelId: room.id }, { type: "text", content: "Late room output" });
  await selected.promise;
  const deletion = retire(source.id).then(() => { archived = true; });
  await waitForLockWaiter(h.db, () => archived);
  const archivedBeforeSend = archived;
  release.resolve(); await pending; await deletion;
  expect(archivedBeforeSend).toBe(false);
  expect(await h.db.channelMessage.count({ where: { channelId: room.id, senderBotId: source.id } })).toBe(1);
}, 15_000);

dbIt("room deletion and a scheduled routine seed cannot deadlock on foreign keys", async h => {
  const { source, target } = await pair(h);
  const room = await h.channel({ kind: "group", name: "Routine room", members: { create: [source, target].map((bot, ordinal) => ({ botId: bot.id, ordinal })) } });
  const inserted = gate(), release = gate();
  let deleted = false;
  const wrapped = pauseOn(h.db, "routineExecution", "create", inserted, release.promise);
  const routines = new RoutineService(wrapped, new AgentMessaging(wrapped, h.messaging.boss, h.store));
  const routine = await routines.mutateOwner({ kind: "group", id: room.id }, crypto.randomUUID(), null, { action: "create", name: "Room routine", prompt: "Check once", schedule: "@every 5m", enabled: true });
  await h.db.routine.update({ where: { id: String(routine.id) }, data: { nextRunAt: new Date(Date.now() - 1000) } });
  const launching = settled(routines.dispatchDue());
  await inserted.promise;
  const deleting = settled(Effect.runPromise(groups(h.db, ok, h).deleteGroup(room.id)).then(() => { deleted = true; }));
  await waitForLockWaiter(h.db, () => deleted);
  release.resolve();
  expect(await Promise.all([launching, deleting])).toEqual([{}, {}]);
  expect(await h.db.channel.findUnique({ where: { id: room.id } })).toBeNull();
}, 15_000);

