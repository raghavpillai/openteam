/** Shared fixtures for the PostgreSQL-backed server tests (OPENTEAM_TEST_DATABASE_URL). */
import { test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore, AgentMessaging, type ToolContext } from "@openteam/messaging";
import { WakeWorker } from "../../worker/src/worker";

export const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
/** A test that runs only when a test database is configured. */
export const dbTest = test.skipIf(!databaseUrl);
export type Db = ReturnType<typeof createPrismaClient>;
export const gate = () => Promise.withResolvers<void>();

export type Job = { name: string; data: unknown };
/** A pg-boss stand-in that records every job it is handed. */
export const fakeBoss = (jobs: Job[] = []) => {
  const send = async (name: string, data: unknown) => { jobs.push({ name, data }); return crypto.randomUUID(); };
  return { send, sendDebounced: send } as never;
};

/** A WakeWorker whose constructor never ran, with just the fields a test needs. */
export const bareWorker = (fields: Record<string, unknown>): any => Object.assign(Object.create(WakeWorker.prototype), fields);

/** Wraps `db` so each interactive transaction's client goes through `intercept(tx, property)`;
 * returning undefined falls through to the real property. */
export function interceptTransactions(db: Db, intercept: (tx: any, property: PropertyKey) => unknown): Db {
  return new Proxy(db, { get(target, key) {
    if (key !== "$transaction") return Reflect.get(target, key);
    return (work: any) => target.$transaction((tx: any) => work(new Proxy(tx, { get(inner, property) {
      return intercept(inner, property) ?? inner[property];
    } })), { timeout: 10_000 });
  } }) as Db;
}

/** Polls until a backend waits on a lock (or `done()`); returns whether a waiter was seen. */
export async function waitForLockWaiter(db: Db, done: () => boolean = () => false, like = "%") {
  const deadline = Date.now() + 3000;
  while (!done() && Date.now() < deadline) {
    const rows = await db.$queryRaw<unknown[]>`SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock'
      AND query LIKE ${like} AND query NOT LIKE '%pg_stat_activity%'`;
    if (rows.length) return true;
    await Bun.sleep(2);
  }
  return false;
}

export type Harness = Awaited<ReturnType<typeof openHarness>>;
export type SeededBot = Awaited<ReturnType<Harness["bot"]>>;
/** The parts of a seeded bot the run and context helpers use. */
type Owner = { id: string; conversationId: string; channelId: string | null };

/** A database client, temp workspace, agent data store and messaging host; `close` removes
 * every bot (with its subagent children), channel and retired-agent record it created. */
export async function openHarness() {
  const db = createPrismaClient(databaseUrl!);
  const dir = await mkdtemp(join(tmpdir(), "openteam-test-"));
  const store = new AgentDataStore(db, { root: join(dir, "data"), workspaceRoot: dir });
  await store.writeRootSettings({});
  const jobs: Job[] = [];
  const messaging = new AgentMessaging(db, fakeBoss(jobs), store);
  const botIds = new Set<string>(), channelIds = new Set<string>(), cleanups: Array<() => Promise<unknown>> = [];

  /** An active bot with its conversation and DM channel. */
  const bot = async (name = "Fixture", data: Record<string, unknown> = {}, options: { dm?: boolean } = {}) => {
    const row = await db.bot.create({ data: { name, status: "active", onboardingStatus: "completed", defaultDirectory: dir, conversation: { create: {} }, ...data }, include: { conversation: true } });
    botIds.add(row.id);
    await store.initializeBot(row.id);
    const channel = options.dm === false ? null : await db.channel.create({ data: { kind: "bot_dm", name, directKey: `bot:${row.id}`, members: { create: { botId: row.id, ordinal: 0 } } } });
    if (channel) channelIds.add(channel.id);
    return { ...row, conversationId: row.conversation!.id, channel: channel!, channelId: channel?.id ?? null };
  };
  /** A channel the harness removes on close. */
  const channel = async (data: Parameters<Db["channel"]["create"]>[0]["data"]) => {
    const row = await db.channel.create({ data });
    channelIds.add(row.id);
    return row;
  };
  /** A run row for `owner` in its DM unless overridden. */
  const run = (owner: Owner, data: Record<string, unknown> = {}) => db.run.create({ data: {
    botId: owner.id, conversationId: owner.conversationId, channelId: owner.channelId, userMessageId: crypto.randomUUID(), status: "running", origin: "user", ...data,
  } as never });
  /** Enqueues a user message wake in the bot's DM, marks it running and returns its tool context. */
  const turn = async (owner: Owner, content = "Do the work.", input: Record<string, unknown> = {}): Promise<ToolContext> => {
    const channelId = (input.channelId as string | undefined) ?? owner.channelId!;
    const wake = await db.$transaction(tx => messaging.enqueueWake(tx, {
      botId: owner.id, channelId, origin: "user", type: "user.message", content, clientId: crypto.randomUUID(), priority: 300, ...input,
    } as never));
    await db.run.update({ where: { id: wake.run.id }, data: { status: "running" } });
    return context(owner, { runId: wake.run.id, channelId, origin: (input.origin as ToolContext["origin"]) ?? "user" });
  };
  const context = (owner: Owner, overrides: Partial<ToolContext> & { runId: string }): ToolContext => ({
    botId: owner.id, conversationId: owner.conversationId, channelId: owner.channelId!, deliveryId: null, origin: "user",
    callId: crypto.randomUUID(), replyToMessageId: null, isFork: false, ...overrides,
  });

  const close = async () => {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
    const ids = [...botIds];
    const children = await db.subagent.findMany({ where: { parentBotId: { in: ids } }, select: { childBotId: true } });
    ids.push(...children.map(child => child.childBotId));
    const members = await db.channelMember.findMany({ where: { botId: { in: ids } }, select: { channelId: true } });
    const channels = [...channelIds, ...members.map(member => member.channelId)];
    await db.bot.deleteMany({ where: { id: { in: ids } } });
    await db.channel.deleteMany({ where: { id: { in: channels } } });
    await db.retiredAgent.deleteMany({ where: { id: { in: [...ids, ...channels] } } });
    await db.$disconnect();
    await rm(dir, { recursive: true, force: true });
  };
  return { db, dir, store, jobs, messaging, bot, channel, run, turn, context, botIds, channelIds, onClose: (cleanup: () => Promise<unknown>) => cleanups.push(cleanup), close };
}

/** Runs `body` with a fresh harness and always closes it. */
export async function withHarness<T>(body: (h: Harness) => Promise<T>): Promise<T> {
  const h = await openHarness();
  try { return await body(h); } finally { await h.close(); }
}

/** A database test whose body receives a fresh harness. */
export const dbIt = (name: string, body: (h: Harness) => Promise<unknown>, timeout?: number) =>
  dbTest(name, () => withHarness(body).then(() => {}), timeout);
