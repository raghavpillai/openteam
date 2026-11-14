import { expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient, type Bot, type Conversation } from "@openteam/db";
import { AgentDataStore, AgentMessaging, RoutineService, type ToolContext } from "@openteam/messaging";
import { BotService } from "../src/services/bot-service";
import { GroupAdministration } from "../src/services/channel/group-administration";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;
const gate = () => Promise.withResolvers<void>();

async function fixture(idPrefixes?: readonly string[]) {
  const db = createPrismaClient(url!);
  const root = await mkdtemp(join(tmpdir(), "retirement-entrypoints-"));
  const bots: Array<Bot & { conversation: Conversation | null }> = [];
  const channels: string[] = [];
  for (const name of ["Source", "Target"]) {
    const prefix = idPrefixes?.[bots.length];
    const id = prefix ? prefix + crypto.randomUUID().slice(1) : undefined;
    const bot = await db.bot.create({ data: { id, name, status: "active", defaultDirectory: root, conversation: { create: {} } }, include: { conversation: true } });
    bots.push(bot);
    channels.push((await db.channel.create({ data: { kind: "bot_dm", name, directKey: `bot:${bot.id}`, members: { create: { botId: bot.id, ordinal: 0 } } } })).id);
  }
  const data = new AgentDataStore(db, { root, workspaceRoot: root });
  const boss = { send: async () => null, sendDebounced: async () => null };
  const messaging = new AgentMessaging(db, boss as never, data);
  const retire = (id: string) => Effect.runPromise(new BotService(db, boss as never, root, async () => Response.json({ ok: true }), data).archive(id));
  const run = await db.run.create({ data: { botId: bots[0]!.id, conversationId: bots[0]!.conversation!.id, channelId: channels[0], userMessageId: crypto.randomUUID(), status: "running" } });
  const context: ToolContext = { runId: run.id, botId: run.botId, conversationId: run.conversationId, channelId: channels[0]!, deliveryId: null, origin: "user", callId: crypto.randomUUID(), isFork: false, replyToMessageId: null };
  return { db, root, bots, channels, data, boss, messaging, retire, context, cleanup: async () => {
    await db.bot.deleteMany({ where: { id: { in: bots.map(bot => bot.id) } } });
    await db.channel.deleteMany({ where: { id: { in: channels } } });
    await db.retiredAgent.deleteMany({ where: { id: { in: bots.map(bot => bot.id) } } });
    await db.$disconnect(); await rm(root, { recursive: true, force: true });
  } };
}

/** Wait until retirement either finishes or contends on the in-flight operation. */
async function contended(db: ReturnType<typeof createPrismaClient>, done: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!done() && Date.now() < deadline) {
    const rows = await db.$queryRaw<any[]>`SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query NOT LIKE '%pg_stat_activity%'`;
    if (rows.length) return;
    await Bun.sleep(2);
  }
}

for (const kind of ["peer", "manual-routine", "scheduled-routine", "event-followup", "shell-callback"] as const) {
  test.skipIf(!url)(`${kind} cannot leave a new queued wake behind target retirement`, async () => {
    const f = await fixture();
    const target = f.bots[1]!;
    const selected = gate(), release = gate();
    let pending: Promise<any> | undefined, deletion: Promise<any> | undefined;
    let archived = false;
    let pause = true;
    try {
      const wrapped = new Proxy(f.db, { get(owner, key) {
        if (key !== "$transaction") return Reflect.get(owner, key);
        return (work: any) => owner.$transaction((tx: any) => work(new Proxy(tx, { get(inner, prop) {
          if (prop !== "bot") return inner[prop];
          return { ...inner.bot, findUnique: async (input: any) => {
            const snapshot = await inner.bot.findUnique(input);
            if (pause && input.where.id === target.id && input.include?.conversation) {
              selected.resolve(); await release.promise;
            }
            return snapshot;
          } };
        } })), { timeout: 10_000 });
      } });
      const messaging = new AgentMessaging(wrapped, f.boss as never, f.data);
      if (kind === "peer") pending = messaging.sendToAgent(f.context, { target_id: target.id, message: "Work from peer" });
      else if (kind === "shell-callback") pending = messaging.completeShell({ id: "123", scope: target.id, exitCode: 0, outputPath: "/unused/123.log" });
      else {
        const routines = new RoutineService(wrapped, messaging);
        const routine = await routines.mutate(target.id, crypto.randomUUID(), null, { action: "create", name: "Deletion race", prompt: "Check once", enabled: true,
          ...(kind === "event-followup" ? { trigger: { type: "github", repo: "org/repo", ciBranch: "main", events: ["ci-failed"] } } : { schedule: "@every 5m" }),
        });
        if (kind === "event-followup") {
          pause = false;
          const event = { id: "first", source: "github", kind: "ci-failed", repo: "org/repo", branch: "main", text: "Failed" };
          const [first] = await routines.dispatchEvent({ kind: "bot", id: target.id }, event);
          await f.db.run.update({ where: { id: first!.runId! }, data: { status: "running" } });
          await f.db.routineExecution.update({ where: { id: first!.id }, data: { status: "running" } });
          await f.db.inboxEvent.updateMany({ where: { runId: first!.runId! }, data: { status: "processing" } });
          await routines.dispatchEvent({ kind: "bot", id: target.id }, { ...event, id: "follow-up" });
          await f.db.run.update({ where: { id: first!.runId! }, data: { status: "completed" } });
          await f.db.routineExecution.update({ where: { id: first!.id }, data: { status: "completed" } });
          await f.db.inboxEvent.updateMany({ where: { runId: first!.runId! }, data: { status: "completed" } });
          pause = true;
          pending = wrapped.$transaction(tx => routines.startEventFollowUp(tx, String(routine.id)));
        } else if (kind === "manual-routine") pending = routines.runNow(target.id, String(routine.id), crypto.randomUUID());
        else {
          const due = new Date(Date.now() - 1000);
          await f.db.routine.update({ where: { id: String(routine.id) }, data: { nextRunAt: due } });
          pending = routines.dispatchDue(new Date());
        }
      }
      await selected.promise;
      deletion = f.retire(target.id).then(() => { archived = true; });
      await contended(f.db, () => archived);
      release.resolve(); await pending; await deletion;
      expect(await f.db.run.count({ where: { botId: target.id, status: { in: ["queued", "running"] } } })).toBe(0);
      expect(await f.db.inboxEvent.count({ where: { botId: target.id, status: { in: ["pending", "processing"] } } })).toBe(0);
    } finally {
      release.resolve(); await Promise.allSettled([pending, deletion]); await f.cleanup();
    }
  }, 15_000);
}

test.skipIf(!url)("an admitted room send cannot publish after its source agent was retired", async () => {
  const f = await fixture();
  const selected = gate(), release = gate();
  let pending: Promise<any> | undefined, deletion: Promise<any> | undefined;
  let archived = false;
  try {
    const room = await f.db.channel.create({ data: { kind: "group", name: "Room", members: { create: f.bots.map((bot, ordinal) => ({ botId: bot.id, ordinal })) } } });
    f.channels.push(room.id);
    const wrapped = new Proxy(f.db, { get(owner, key) {
      if (key !== "$transaction") return Reflect.get(owner, key);
      return (work: any) => owner.$transaction((tx: any) => work(new Proxy(tx, { get(inner, prop) {
        if (prop !== "channel") return inner[prop];
        return { ...inner.channel, findFirst: async (input: any) => {
          const snapshot = await inner.channel.findFirst(input);
          if (input.where.id === room.id) { selected.resolve(); await release.promise; }
          return snapshot;
        } };
      } })), { timeout: 10_000 });
    } });
    const messaging = new AgentMessaging(wrapped, f.boss as never, f.data);
    pending = messaging.sendVisible({ ...f.context, channelId: room.id }, { type: "text", content: "Late room output" });
    await selected.promise;
    deletion = f.retire(f.bots[0]!.id).then(() => { archived = true; });
    await contended(f.db, () => archived);
    const archivedBeforeSend = archived;
    release.resolve(); await pending; await deletion;
    expect(archivedBeforeSend).toBe(false);
    expect(await f.db.channelMessage.count({ where: { channelId: room.id, senderBotId: f.bots[0]!.id } })).toBe(1);
  } finally {
    release.resolve(); await Promise.allSettled([pending, deletion]); await f.cleanup();
  }
}, 15_000);

for (const mode of ["manual", "scheduled"] as const) {
  test.skipIf(!url)(`room deletion and a ${mode} routine seed cannot deadlock on foreign keys`, async () => {
    const f = await fixture();
    const inserted = gate(), release = gate();
    let launching: Promise<any> | undefined, deleting: Promise<any> | undefined;
    let deleted = false;
    try {
      const room = await f.db.channel.create({ data: { kind: "group", name: "Routine room", members: { create: f.bots.map((bot, ordinal) => ({ botId: bot.id, ordinal })) } } });
      f.channels.push(room.id);
      const wrapped = new Proxy(f.db, { get(owner, key) {
        if (key !== "$transaction") return Reflect.get(owner, key);
        return (work: any) => owner.$transaction((tx: any) => work(new Proxy(tx, { get(inner, prop) {
          if (prop !== "routineExecution") return inner[prop];
          return { ...inner.routineExecution, create: async (input: any) => {
            const row = await inner.routineExecution.create(input);
            inserted.resolve(); await release.promise; return row;
          } };
        } })), { timeout: 10_000 });
      } });
      const messaging = new AgentMessaging(wrapped, f.boss as never, f.data);
      const routines = new RoutineService(wrapped, messaging);
      const owner = { kind: "group" as const, id: room.id };
      const routine = await routines.mutateOwner(owner, crypto.randomUUID(), null, { action: "create", name: "Room routine", prompt: "Check once", schedule: "@every 5m", enabled: true });
      if (mode === "scheduled") await f.db.routine.update({ where: { id: String(routine.id) }, data: { nextRunAt: new Date(Date.now() - 1000) } });
      launching = (mode === "manual" ? routines.runNowOwner(owner, String(routine.id), crypto.randomUUID()) : routines.dispatchDue())
        .then(() => ({}), error => ({ error: String(error) }));
      await inserted.promise;
      const groups = new GroupAdministration(f.db, f.messaging, f.root, async () => Response.json({ ok: true }), f.data);
      deleting = Effect.runPromise(groups.deleteGroup(room.id)).then(() => { deleted = true; return {}; }, error => ({ error: String(error) }));
      await contended(f.db, () => deleted);
      release.resolve();
      expect(await Promise.all([launching, deleting])).toEqual([{}, {}]);
      expect(await f.db.channel.findUnique({ where: { id: room.id } })).toBeNull();
    } finally {
      release.resolve(); await Promise.allSettled([launching, deleting]);
      await f.db.retiredAgent.deleteMany({ where: { id: { in: f.channels } } });
      await f.cleanup();
    }
  }, 15_000);
}

test.skipIf(!url)("retirement disables a routine whose creation already checked the owner", async () => {
  const f = await fixture();
  const checked = gate(), release = gate();
  let creating: Promise<any> | undefined, deletion: Promise<any> | undefined;
  let archived = false;
  try {
    const target = f.bots[1]!;
    const wrapped = new Proxy(f.db, { get(owner, key) {
      if (key !== "$transaction") return Reflect.get(owner, key);
      return (work: any) => owner.$transaction((tx: any) => work(new Proxy(tx, { get(inner, prop) {
        if (prop !== "bot") return inner[prop];
        return { ...inner.bot, count: async (input: any) => {
          const snapshot = await inner.bot.count(input);
          checked.resolve(); await release.promise; return snapshot;
        } };
      } })), { timeout: 10_000 });
    } });
    const routines = new RoutineService(wrapped, f.messaging);
    creating = routines.mutate(target.id, crypto.randomUUID(), null, { action: "create", name: "Last routine", prompt: "Check once", schedule: "@every 5m", enabled: true });
    await checked.promise;
    deletion = f.retire(target.id).then(() => { archived = true; });
    await contended(f.db, () => archived);
    release.resolve(); await creating; await deletion;
    expect(await f.db.routine.count({ where: { botId: target.id, enabled: true, deletedAt: null } })).toBe(0);
  } finally {
    release.resolve(); await Promise.allSettled([creating, deletion]); await f.cleanup();
  }
}, 15_000);

test.skipIf(!url)("late peer sends, routine launches, callbacks, and room output stay rejected after retirement", async () => {
  const f = await fixture();
  try {
    const target = f.bots[1]!;
    const room = await f.db.channel.create({ data: { kind: "group", name: "Surviving room", members: { create: f.bots.map((bot, ordinal) => ({ botId: bot.id, ordinal })) } } });
    f.channels.push(room.id);
    const routines = new RoutineService(f.db, f.messaging, f.data);
    const routine = await routines.mutate(target.id, crypto.randomUUID(), null, { action: "create", name: "Deleted routine", prompt: "Check once", schedule: "@every 5m", enabled: true });
    await f.retire(target.id);
    const peer = await f.messaging.sendToAgent(f.context, { target_id: target.id, message: "Too late" });
    expect(String(peer.acknowledgement)).toContain("No agent found");
    await expect(routines.runNow(target.id, String(routine.id), crypto.randomUUID())).rejects.toThrow();
    expect(await routines.dispatchDue(new Date(Date.now() + 600_000))).toBe(0);
    expect(await f.messaging.completeShell({ id: "late", scope: target.id, exitCode: 0, outputPath: "/unused/late.log" })).toEqual({ delivered: false, ignored: true });
    await expect(f.messaging.sendVisible({ ...f.context, botId: target.id, conversationId: target.conversation!.id, channelId: room.id }, { type: "text", content: "Too late" })).rejects.toThrow("unavailable");
    expect(await f.db.run.count({ where: { botId: target.id, status: { in: ["queued", "running"] } } })).toBe(0);
    expect(await f.db.channelMessage.count({ where: { channelId: room.id } })).toBe(0);
  } finally { await f.cleanup(); }
});

test.skipIf(!url)("reciprocal peer sends complete and callback retries produce exactly one wake", async () => {
  const f = await fixture(["a", "b"]);
  try {
    const target = f.bots[1]!;
    const run = await f.db.run.create({ data: { botId: target.id, conversationId: target.conversation!.id, channelId: f.channels[1], userMessageId: crypto.randomUUID(), status: "running" } });
    const other: ToolContext = { ...f.context, runId: run.id, botId: target.id, conversationId: run.conversationId, channelId: f.channels[1]!, callId: crypto.randomUUID() };
    const sends = await Promise.all([
      f.messaging.sendToAgent(f.context, { target_id: target.id.toUpperCase(), message: "Forward" }),
      f.messaging.sendToAgent(other, { target_id: f.bots[0]!.id, message: "Back" }),
    ]);
    expect(sends).toHaveLength(2);
    expect(await f.db.inboxEvent.count({ where: { botId: { in: f.bots.map(bot => bot.id) }, type: "agent.message" } })).toBe(2);
    const callback = { id: "duplicate", scope: target.id, exitCode: 0, outputPath: "/unused/duplicate.log" };
    const results = await Promise.all(Array.from({ length: 8 }, () => f.messaging.completeShell(callback)));
    expect(results.every(result => result.delivered)).toBe(true);
    expect(await f.db.inboxEvent.count({ where: { botId: target.id, type: "shell.completed" } })).toBe(1);
    await f.retire(target.id);
    expect(await f.messaging.completeShell(callback)).toMatchObject({ delivered: true, duplicate: true });
    expect(await f.db.inboxEvent.count({ where: { botId: target.id, status: { in: ["pending", "processing"] } } })).toBe(0);
  } finally { await f.cleanup(); }
}, 15_000);

test.skipIf(!url)("a shell callback for a deleted room is ignored while its member remains active", async () => {
  const f = await fixture();
  try {
    const room = await f.db.channel.create({ data: { kind: "group", name: "Deleted callback room", members: { create: { botId: f.bots[0]!.id, ordinal: 0 } } } });
    f.channels.push(room.id);
    const groups = new GroupAdministration(f.db, f.messaging, f.root, async () => Response.json({ ok: true }), f.data);
    await Effect.runPromise(groups.deleteGroup(room.id));
    expect(await f.messaging.completeShell({ id: "room-late", scope: f.bots[0]!.id, channelId: room.id, exitCode: 0, outputPath: "/unused/room-late.log" })).toEqual({ delivered: false, ignored: true });
    expect(await f.db.bot.findUniqueOrThrow({ where: { id: f.bots[0]!.id } })).toMatchObject({ status: "active" });
    expect(await f.db.inboxEvent.count({ where: { type: "shell.completed", botId: f.bots[0]!.id } })).toBe(0);
  } finally {
    await f.db.retiredAgent.deleteMany({ where: { id: { in: f.channels } } }); await f.cleanup();
  }
});
