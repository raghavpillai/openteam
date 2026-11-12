import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { UNFINISHED_TASKS_REMINDER } from "@openteam/messaging";
import { ChannelService } from "../../server/src/services/channel-service";
import { TurnStoppedError, turnCompletionFailure, turnContentWithNotes, WakeWorker } from "../src/worker";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

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
/** The real computer runtime runs in a child process this file owns. */
let computer: ReturnType<typeof Bun.spawn> | undefined;
let computerUrl = "";
let channels: ChannelService;
const script = (body: Record<string, unknown>) =>
  fetch(`${computerUrl}/script`, { method: "POST", body: JSON.stringify(body) });
const modelRequests = async () => (await (await fetch(`${computerUrl}/requests`)).json()) as any[];
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
  computer = Bun.spawn(["bun", join(import.meta.dir, "fixtures/supersede-computer.ts")], {
    env: { ...process.env, OPENTEAM_PI_AGENT_DIR: join(root, "pi"), OPENTEAM_WORKSPACE_ROOT: root, OPENTEAM_AGENT_DATA_ROOT: join(root, "data") },
    stdout: "pipe", stderr: "ignore",
  });
  const reader = (computer.stdout as ReadableStream<Uint8Array>).getReader();
  let output = "";
  while (!/READY (\d+)/.test(output)) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("The computer fixture did not start");
    output += new TextDecoder().decode(chunk.value);
  }
  computerUrl = `http://127.0.0.1:${/READY (\d+)/.exec(output)![1]}`;
  void (async () => { while (!(await reader.read()).done); })();
  channels = new ChannelService(db, worker.messaging, root, (path: string, init?: RequestInit) => fetch(`${computerUrl}${path}`, init));
});

afterAll(async () => {
  if (!databaseUrl) return;
  await Promise.allSettled(turns);
  computer?.kill("SIGKILL");
  await computer?.exited;
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
      clientId: payload.clientId, cwd: root, sessionPath: null, channelId, deliveryId: null,
      origin: inbox.run.origin, runtimeProfile: "agent", subagentType: null, readOnly: false, inferenceParentRunId: null,
      taskConfiguration: null, fileAttachments: [], attachmentOwnerBotId: botId,
      interruptedRunId: payload.interruptedRunId ?? null,
    };
  };
  const startTurn = async (claimed: any, content: string, sessionPath: string | null) => {
    const events: any[] = [];
    const response = await fetch(`${computerUrl}/turns`, { method: "POST", body: JSON.stringify({
      runId: claimed.runId, botId, contextSessionId: conversationId, conversationId, sessionPath, content,
      clientMessageId: claimed.clientId, cwd: root, instructions: "System fixture", channelId, deliveryId: null,
      requestSource: "turn", runtimeProfile: "agent", reasoning: "off",
    }) });
    if (!response.ok) throw new Error(`Computer rejected turn: ${await response.text()}`);
    const done = (async () => {
      let buffered = "";
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffered += new TextDecoder().decode(chunk);
        let newline: number;
        while ((newline = buffered.indexOf("\n")) >= 0) {
          const event = JSON.parse(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
          events.push(event);
          if (event.type === "prompt.delivered") await db.run.update({ where: { id: claimed.runId }, data: { inputDeliveredAt: new Date() } });
        }
      }
    })();
    turns.push(done);
    return { events, done };
  };
  const send = (content: string, clientId: string, thread?: { replyToMessageId: string }) =>
    Effect.runPromise(channels.sendDirectMessage(conversationId, { content, clientId, ...(thread ? { ...thread, isFork: true } : {}) }) as any) as Promise<{ run: { id: string }; message: { id: string } }>;
  const run = (runId: string) => db.run.findUniqueOrThrow({ where: { id: runId } });
  return { botId, conversationId, channelId, claimedFor, startTurn, send, run };
};

test.skipIf(!databaseUrl)("a typed message during a running Shell cancels the turn, kills the command, and the new turn carries the unfinished-tasks reminder", async () => {
  const bot = await fixtureBot();
  const finished = join(root, "finished");
  await script({ firstReply: { role: "assistant", tool_calls: [{ index: 0, id: "shell-1", type: "function", function: {
    name: "Shell", arguments: JSON.stringify({ command: `echo started; sleep 3; touch ${finished}`, block_until_ms: 60_000 }) } }] } });
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
  const tape = (await Bun.file(sessionPath).text()).trim().split("\n").map((line) => JSON.parse(line))
    .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
  const shellResult = tape.find((message) => message.role === "toolResult" && message.toolCallId === "shell-1");
  expect(shellResult.isError).toBe(true);
  expect(shellResult.content[0].text).toMatch(/^Error: Shell command was interrupted by the user after \d+ms before it completed\.\n\nOutput collected before interruption:\n\n```\nstarted\n\n```$/);

  // The new turn carries the reminder ahead of the query, and the model sees both.
  const claimedSecond = await bot.claimedFor(second.run.id, "worker-second");
  expect(claimedSecond.interruptedRunId).toBe(first.run.id);
  const content = turnContentWithNotes({ origin: "user", runtimeProfile: "agent", notes: [], unfinishedTasks: await worker.supersededUnfinishedRun(claimedSecond) }, claimedSecond.content);
  expect(content.startsWith(`<system_reminder>\n${UNFINISHED_TASKS_REMINDER}\n</system_reminder>\n`)).toBe(true);
  const secondTurn = await bot.startTurn(claimedSecond, content, sessionPath);
  await secondTurn.done;
  const sent = JSON.stringify((await modelRequests()).at(-1).messages);
  expect(sent).toContain("Error: Shell command was interrupted by the user after");
  expect(sent).toContain(UNFINISHED_TASKS_REMINDER);
  await Bun.sleep(3_500);
  expect(existsSync(finished)).toBe(false);
}, 60_000);

for (const origin of ["background_revival"] as const)
  for (const stopRecorded of [true, false]) test.skipIf(!databaseUrl)(`an explicit Stop wins over an earlier typed interruption of a ${origin} wake${stopRecorded ? " after its durable cancellation" : " before cancellation is recorded"}`, async () => {
    const bot = await fixtureBot();
    const { botId, channelId } = bot;
    const clientId = `stop-redrive:${botId}`;
    const wake = await db.$transaction((tx: any) => worker.messaging.enqueueWake(tx, {
      botId, channelId, origin, type: "subagent.completed",
      content: "[SAND_HIDDEN_PROMPT]Check the previously authorized result.", clientId, priority: 200, wrapUserContent: false,
    }));
    await db.run.update({ where: { id: wake.run.id }, data: { status: "running", inputDeliveredAt: new Date() } });
    const claimed = await bot.claimedFor(wake.run.id, crypto.randomUUID());
    const typed = await db.$transaction((tx: any) => worker.messaging.acceptDirectUserMessage(tx, {
      botId, channelId, content: "Look at this instead.", clientId: crypto.randomUUID(),
    }));
    expect(typed.interruptRunId).toBe(wake.run.id);
    // Stop arrives after that typed message but before the old runtime settles.
    if (stopRecorded) await db.run.update({ where: { id: wake.run.id }, data: {
      status: "cancelled", error: { code: "cancelled_by_user", message: "The user stopped this turn" },
    } });
    await worker.fail({ ...claimed, instructions: "" }, stopRecorded
      ? new Error("Computer turn ended with status interrupted")
      : new TurnStoppedError("Computer turn ended with status cancelled"), true);
    expect(await db.inboxEvent.findUnique({ where: { idempotencyKey: `${clientId}:redrive:1` } })).toBeNull();
    expect((await db.run.findUniqueOrThrow({ where: { id: wake.run.id } })).error).toMatchObject({ code: "cancelled_by_user" });
    expect(await worker.supersededUnfinishedRun({ botId, interruptedRunId: wake.run.id })).toBe(false);
  });
