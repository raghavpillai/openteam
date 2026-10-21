import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { UNFINISHED_TASKS_REMINDER } from "@openteam/messaging";
import { ChannelService } from "../../server/src/services/channel-service";
import { turnCompletionFailure, turnContentWithNotes, WakeWorker } from "../src/worker";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
// Pi is a computer dependency; load it the way the computer resolves it.
const computerDir = join(import.meta.dir, "../../computer/src");
const pi = (name: string) => import(Bun.resolveSync(name, computerDir));
const { InMemoryCredentialStore } = await pi("@earendil-works/pi-ai");
const { streamSimple } = await pi("@earendil-works/pi-ai/api/openai-completions");
const { ModelRuntime, SessionManager } = await pi("@earendil-works/pi-coding-agent");
const { ComputerRuntime } = await import(join(computerDir, "runtime.ts"));

const model: any = {
  id: "supersede-fixture", name: "Supersede fixture", provider: "openai", api: "openai-completions",
  baseUrl: "https://offline.invalid/v1", reasoning: false, input: ["text"], contextWindow: 128_000,
  maxTokens: 4_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const sse = (delta: unknown, finish: string) =>
  new Response([
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ].map((chunk) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: model.id, ...chunk })}\n\n`).join("") + "data: [DONE]\n\n",
  { headers: { "content-type": "text/event-stream" } });

const waitUntil = async (predicate: () => boolean | Promise<boolean>, label: string) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
};

const keys = ["DATABASE_URL", "OPENTEAM_WORKSPACE_ROOT", "OPENTEAM_AGENT_DATA_ROOT", "OPENTEAM_PI_AGENT_DIR"] as const;
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
let root = "";
let worker: any;
let db: any;
let runtime: any;
let channels: ChannelService;
const requests: any[] = [];
/** The model answers the first request of a turn with this, then with plain text. */
let firstReply: unknown = null;
/** Held setup: a turn waits here before its input reaches the model. */
let holdSetup: Promise<void> | null = null;
const bots: string[] = [];
const channelIds: string[] = [];
const turns: Array<Promise<void>> = [];

beforeAll(async () => {
  if (!databaseUrl) return;
  root = await mkdtemp(join(tmpdir(), "supersede-turn-"));
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl, OPENTEAM_WORKSPACE_ROOT: root,
    OPENTEAM_AGENT_DATA_ROOT: join(root, "data"), OPENTEAM_PI_AGENT_DIR: join(root, "pi"),
  });
  await mkdir(join(root, "data"), { recursive: true });
  worker = new WakeWorker();
  db = worker.prisma;
  await worker.boss.start();
  for (const queue of ["bot-wake", "transcript-project"]) await worker.boss.createQueue(queue);
  const provider = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  provider.checkAuth = async () => ({ type: "api_key" });
  provider.streamSimple = (_model: unknown, context: unknown, options: any) => streamSimple(model, context, {
    ...options, apiKey: "fixture", maxRetries: 0,
    fetch: (async (_url: unknown, init: any) => {
      requests.push(JSON.parse(await new Response(init.body).text()));
      const reply = firstReply;
      firstReply = null;
      return reply ? sse(reply, "tool_calls") : sse({ role: "assistant", content: "Following the new message." }, "stop");
    }) as unknown as typeof fetch,
  });
  runtime = new ComputerRuntime();
  runtime.started = true;
  runtime.modelRuntime = provider;
  runtime.resolveModel = () => model;
  runtime.tools.processSecrets = async () => ({});
  const beginTurn = runtime.tools.userForms.beginTurn.bind(runtime.tools.userForms);
  runtime.tools.userForms.beginTurn = async (...args: unknown[]) => { await holdSetup; return beginTurn(...args); };
  channels = new ChannelService(db, worker.messaging, root, async (path: string, init?: RequestInit) => {
    const cancel = path.match(/^\/v1\/turns\/([^/]+)\/cancel$/);
    if (!cancel?.[1]) return Response.json({ error: "not_found" }, { status: 404 });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const cancelled = await runtime.cancel(cancel[1], body.reason, { recovery: body.recovery === true });
    return cancelled ? Response.json({ ok: true }) : Response.json({ ok: false }, { status: 409 });
  });
});

afterAll(async () => {
  if (!databaseUrl) return;
  // Every turn this file started has ended, so no Pi session, Shell or deadline remains.
  await Promise.allSettled(turns);
  for (const runId of [...runtime.activeByRun.keys()]) await runtime.cancel(runId).catch(() => undefined);
  runtime.closeIdleProviderConnections();
  await db.bot.deleteMany({ where: { id: { in: bots } } });
  await db.channel.deleteMany({ where: { id: { in: channelIds } } });
  await worker.boss.stop({ graceful: false }).catch(() => undefined);
  await db.$disconnect();
  for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  await rm(root, { recursive: true, force: true });
});

const fixtureBot = async () => {
  const botId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const channelId = crypto.randomUUID();
  bots.push(botId);
  channelIds.push(channelId);
  await db.bot.create({ data: { id: botId, name: "Supersede fixture", defaultDirectory: root, status: "active", onboardingStatus: "completed", conversation: { create: { id: conversationId } } } });
  await db.channel.create({ data: { id: channelId, kind: "bot_dm", name: "Supersede fixture", directKey: `bot:${botId}`, members: { create: { botId, ordinal: 0 } } } });
  const claimedFor = async (runId: string, ownerId: string) => {
    const inbox = await db.inboxEvent.findFirstOrThrow({ where: { runId }, include: { run: true } });
    const payload = inbox.payload as { content: string; clientId: string; interruptedRunId?: string };
    await db.run.update({ where: { id: runId }, data: { status: "running" } });
    await db.botRunLease.deleteMany({ where: { botId } });
    await db.botRunLease.create({ data: { botId, runId, ownerId, expiresAt: new Date(Date.now() + 120_000) } });
    return {
      inboxId: inbox.id, inboxType: inbox.type, runId, botId, contextSessionId: "context", runChannelId: channelId,
      screenBotId: botId, pluginBotId: botId, conversationId, ownerId, content: payload.content, images: [],
      clientId: payload.clientId, cwd: root, instructions: "", sessionPath: null, channelId, deliveryId: null,
      origin: inbox.run.origin, runtimeProfile: "agent", subagentType: null, readOnly: false, inferenceParentRunId: null,
      taskConfiguration: null, fileAttachments: [], attachmentOwnerBotId: botId,
      interruptedRunId: payload.interruptedRunId ?? null,
    };
  };
  const startTurn = async (claimed: any, content: string, sessionPath: string | null) => {
    const events: any[] = [];
    const queue = await runtime.run({
      runId: claimed.runId, botId, contextSessionId: conversationId, conversationId, sessionPath, content,
      clientMessageId: claimed.clientId, cwd: root, instructions: "System fixture", channelId, deliveryId: null,
      requestSource: "turn", runtimeProfile: "agent", model: `${model.provider}/${model.id}`, reasoning: "off",
    });
    const done = (async () => {
      for await (const event of queue) {
        events.push(event);
        if (event.type === "prompt.delivered") await db.run.update({ where: { id: claimed.runId }, data: { inputDeliveredAt: new Date() } });
      }
    })();
    turns.push(done);
    return { events, done };
  };
  const send = (content: string, clientId: string, thread?: { replyToMessageId: string }) =>
    Effect.runPromise(channels.sendDirectMessage(conversationId, { content, clientId, ...(thread ? { ...thread, isFork: true } : {}) }) as any) as Promise<{ run: { id: string }; message: { id: string } }>;
  const run = (runId: string) => db.run.findUniqueOrThrow({ where: { id: runId } });
  return { botId, conversationId, claimedFor, startTurn, send, run };
};

test.skipIf(!databaseUrl)("a typed message during a running Shell cancels the turn, kills the command, and the new turn carries the unfinished-tasks reminder", async () => {
  const bot = await fixtureBot();
  const finished = join(root, "finished");
  firstReply = { role: "assistant", tool_calls: [{ index: 0, id: "shell-1", type: "function", function: {
    name: "Shell", arguments: JSON.stringify({ command: `echo started; sleep 3; touch ${finished}`, block_until_ms: 60_000 }) } }] };
  const first = await bot.send("Run the long check.", "typed-first-0001");
  const claimedFirst = await bot.claimedFor(first.run.id, "worker-first");
  const firstTurn = await bot.startTurn(claimedFirst, claimedFirst.content, null);
  await waitUntil(() => firstTurn.events.some((event) => event.type === "item.started" && JSON.stringify(event).includes("echo started")), "Shell to start");
  await Bun.sleep(300);

  const second = await bot.send("Actually, stop and look at this instead.", "typed-second-0002");
  expect(second.run.id).not.toBe(first.run.id);
  await firstTurn.done;
  const completion = firstTurn.events.find((event) => event.type === "turn.completed");
  expect(completion.status).toBe("interrupted");
  await waitUntil(async () => (await bot.run(first.run.id)).status === "cancelled", "old run cancelled");
  expect((await bot.run(first.run.id)).error).toEqual({ code: "priority_peer_interrupt", message: "superseded by a new user message" });
  await worker.fail(claimedFirst, turnCompletionFailure(completion));

  // The in-flight Shell was killed and reads as the reference renders an interrupted call.
  const sessionPath = firstTurn.events.find((event) => event.type === "session.attached")?.sessionPath;
  const tape = SessionManager.open(sessionPath).buildSessionContext().messages as any[];
  const shellResult = tape.find((message) => message.role === "toolResult" && message.toolCallId === "shell-1");
  expect(shellResult.isError).toBe(true);
  expect(shellResult.content[0].text).toMatch(/^Error: Shell command was interrupted by the user after \d+ms before it completed\.\n\nOutput collected before interruption:\n\n```\nstarted\n\n```$/);

  // The new turn carries the reminder ahead of the query, and the model sees both.
  const claimedSecond = await bot.claimedFor(second.run.id, "worker-second");
  expect(claimedSecond.interruptedRunId).toBe(first.run.id);
  const content = turnContentWithNotes({ origin: "user", runtimeProfile: "agent", notes: [], unfinishedTasks: await worker.supersededUnfinishedRun(claimedSecond) }, claimedSecond.content);
  expect(content.startsWith(`<system_reminder>\n${UNFINISHED_TASKS_REMINDER}\n\n`)).toBe(true);
  const secondTurn = await bot.startTurn(claimedSecond, content, sessionPath);
  await secondTurn.done;
  const sent = JSON.stringify(requests.at(-1).messages);
  expect(sent).toContain("Error: Shell command was interrupted by the user after");
  expect(sent).toContain(UNFINISHED_TASKS_REMINDER);
  await Bun.sleep(3_500);
  expect(existsSync(finished)).toBe(false);
}, 60_000);

test.skipIf(!databaseUrl)("a message that arrives before the turn dispatched queues behind it, unless it carries that plain typed input for recovery", async () => {
  // A thread message carries no recovery: the undispatched turn goes on and finishes.
  const bot = await fixtureBot();
  let release!: () => void;
  holdSetup = new Promise<void>((resolve) => { release = resolve; });
  const first = await bot.send("First question.", "early-first-0001");
  const claimedFirst = await bot.claimedFor(first.run.id, "worker-early-first");
  const firstTurn = bot.startTurn(claimedFirst, claimedFirst.content, null);
  await Bun.sleep(100);
  const thread = await bot.send("A side question.", "early-thread-0002", { replyToMessageId: first.message.id });
  expect(thread.run.id).not.toBe(first.run.id);
  await Bun.sleep(100);
  expect((await bot.run(first.run.id)).status).toBe("running");
  release();
  holdSetup = null;
  const { events, done } = await firstTurn;
  await done;
  expect(events.find((event) => event.type === "turn.completed")?.status).not.toBe("interrupted");
  expect((await bot.run(first.run.id)).inputDeliveredAt).not.toBeNull();
  const claimedThread = await bot.claimedFor(thread.run.id, "worker-thread");
  expect(await worker.supersededUnfinishedRun(claimedThread)).toBe(false);

  // A plain message supersedes an undispatched plain message, whose input the next turn replays, with no reminder.
  const other = await fixtureBot();
  holdSetup = new Promise<void>((resolve) => { release = resolve; });
  const plain = await other.send("Book a table.", "early-plain-0003");
  const claimedPlain = await other.claimedFor(plain.run.id, "worker-plain");
  const plainTurn = other.startTurn(claimedPlain, claimedPlain.content, null);
  await Bun.sleep(100);
  const next = await other.send("For four people.", "early-next-0004");
  await waitUntil(async () => (await other.run(plain.run.id)).status === "cancelled", "undispatched run superseded for recovery");
  release();
  holdSetup = null;
  // Its setup sees the cancel and the turn never starts.
  await expect(plainTurn).rejects.toThrow();
  expect((await other.run(plain.run.id)).inputDeliveredAt).toBeNull();
  const claimedNext = await other.claimedFor(next.run.id, "worker-next");
  expect(await worker.supersededUnfinishedRun(claimedNext)).toBe(false);
}, 60_000);
