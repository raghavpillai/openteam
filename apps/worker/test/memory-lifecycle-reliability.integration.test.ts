import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { DynamicToolCallRequest, type ComputerTurnRequest } from "@openteam/contracts";
import { createPrismaClient } from "@openteam/db";
import { AppService } from "../../server/src/app-service";
import { errorResponse, json, parseBody } from "../../server/src/http";
import { botRoutes } from "../../server/src/routes/bot";
import { channelRoutes } from "../../server/src/routes/channel";
import { clientRoutes } from "../../server/src/routes/client";
import { conversationRoutes } from "../../server/src/routes/conversation";
import { WakeWorker } from "../src/worker";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const dbTest = databaseUrl ? test : test.skip;
type ToolCall = (tool: string, args: unknown) => Promise<any>;
type Bot = { id: string; conversationId: string; channelId: string };

/** Real public/tool HTTP routes and worker; only the computer/model peer is controlled. */
async function fixture(body: (h: {
  app(): AppService;
  createBot(): Promise<Bot>;
  http(path: string, method?: string, body?: unknown): Promise<any>;
  request(path: string, method?: string, body?: unknown): Promise<Response>;
  send(bot: Bot, content: string, channelId?: string): Promise<ComputerTurnRequest>;
  until(check: () => Promise<boolean>): Promise<void>;
  reviewed(runId: string): Promise<void>;
  stopWorker(): Promise<void>;
  restart(): Promise<void>;
  gate(): { promise: Promise<void>; release(): void };
  setTurn(handler: (input: ComputerTurnRequest, call: ToolCall) => Promise<string | null>): void;
  setInference(handler: (prompt: string) => Promise<string | Response>): void;
  turns: ComputerTurnRequest[];
  reviews: string[];
  tools: Array<{ runId: string; tool: string; result: unknown }>;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "memory-lifecycle-http-"));
  const keys = ["DATABASE_URL", "OPENTEAM_COMPUTER_URL", "OPENTEAM_CONTROL_TOKEN", "OPENTEAM_WORKSPACE_ROOT", "OPENTEAM_AGENT_DATA_ROOT", "OPENTEAM_AUTH_MODE"] as const;
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  const bots: Bot[] = [], channels: string[] = [], releases: Array<() => void> = [];
  const turns: ComputerTurnRequest[] = [], reviews: string[] = [], errors: unknown[] = [];
  const tools: Array<{ runId: string; tool: string; result: unknown }> = [];
  let app: AppService | undefined, worker: WakeWorker | undefined;
  let onTurn = async (_input: ComputerTurnRequest, _call: ToolCall): Promise<string | null> => "Lifecycle fixture ready.";
  let onInference = async (_prompt: string): Promise<string | Response> => "NONE";
  const token = "synthetic-memory-lifecycle";
  const api = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 255, async fetch(request) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/internal/tools/call") {
        if (request.headers.get("authorization") !== `Bearer ${token}`) return json({ error: "Unauthorized" }, 401);
        return json(await Effect.runPromise(app!.handleDynamicTool(await parseBody(request, DynamicToolCallRequest))));
      }
      const context = { app: app!, request, url, path: url.pathname, authMode: "disabled" as const, authenticatedSessionId: null };
      for (const route of [botRoutes, channelRoutes, conversationRoutes, clientRoutes]) { const response = await route(context); if (response) return response; }
      return json({ error: "Not found" }, 404);
    } catch (error) { return errorResponse(error); }
  } });
  const request = (path: string, method = "GET", body?: unknown) => fetch(new URL(path, api.url), {
    method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const http = async (path: string, method = "GET", body?: unknown) => {
    const response = await request(path, method, body), result = await response.json();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
    return result as any;
  };
  const computer = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 255, async fetch(request, server) {
    server.timeout(request, 0);
    const path = new URL(request.url).pathname;
    if (path === "/health") return Response.json({ status: "ready", inference: { ready: true, authenticated: true } });
    if (path === "/v1/task-capabilities") return Response.json({ desktopAvailable: true, boxAvailable: true });
    if (path === "/v1/agent-stores" && request.method === "GET") return Response.json({ agents: [] });
    if (path === "/v1/directories") {
      const input = await request.json() as { paths: string[] };
      for (const directory of input.paths ?? []) await mkdir(directory, { recursive: true });
      return Response.json({ directories: input.paths });
    }
    if (path.startsWith("/v1/context-sessions/") && request.method === "GET") return Response.json({ type: "context.state", contextSessionId: path.split("/").at(-1), epoch: 0, archives: [] });
    if (path === "/v1/infer") {
      const input = await request.json() as { kind: string; prompt: string };
      if (input.kind !== "extraction") return Response.json({ text: "NONE" });
      reviews.push(input.prompt);
      const result = await onInference(input.prompt);
      return result instanceof Response ? result : Response.json({ text: result });
    }
    if (path !== "/v1/turns") return Response.json({ ok: true, quarantined: [] });
    const input = await request.json() as ComputerTurnRequest;
    turns.push(input);
    try {
      const call: ToolCall = async (tool, args) => {
        const result = await http("/api/internal/tools/call", "POST", { runId: input.runId, botId: input.botId,
          conversationId: input.conversationId, channelId: input.channelId, deliveryId: input.deliveryId,
          callId: crypto.randomUUID(), tool, arguments: args });
        tools.push({ runId: input.runId, tool, result });
        return result;
      };
      const reply = await onTurn(input, call);
      if (reply !== null) await call("SendToUser", { type: "text", content: reply });
      return new Response([
        { type: "session.attached", runtimeEngine: "pi", inferenceProvider: "openai-codex", contextSessionId: input.contextSessionId,
          sessionPath: input.sessionPath ?? `/var/lib/openteam/pi/${input.contextSessionId}.jsonl`, sessionId: input.contextSessionId, model: "controlled-lifecycle" },
        { type: "context.state", contextSessionId: input.contextSessionId, epoch: 0, archives: [] },
        { type: "turn.started", turnId: input.runId }, { type: "prompt.delivered", turnId: input.runId },
        { type: "turn.completed", turnId: input.runId, status: "completed" },
      ].map(event => JSON.stringify(event)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });
    } catch (error) { errors.push(error); return Response.json({ error: String(error) }, { status: 500 }); }
  } });
  const until = async (check: () => Promise<boolean>) => {
    const end = Date.now() + 45_000;
    while (Date.now() < end) { if (errors.length) throw errors[0]; if (await check()) return; await Bun.sleep(50); }
    throw new Error("Memory lifecycle fixture timed out");
  };
  const start = async () => {
    app = new AppService("disabled"); await Effect.runPromise(app.boot());
    await app.agentData.writeInferenceSettings({ providerId: "openai-codex", modelId: "controlled-lifecycle", reasoning: "low" });
    worker = new WakeWorker(); await worker.start();
  };
  const stopWorker = async () => { await worker?.stop(); worker = undefined; };
  const reviewed = (runId: string) => until(async () => await app!.prisma.run.count({ where: { id: runId, status: "completed", memoryReviewPending: false } }) === 1);
  try {
    Object.assign(process.env, { DATABASE_URL: databaseUrl, OPENTEAM_COMPUTER_URL: computer.url.origin, OPENTEAM_CONTROL_TOKEN: token,
      OPENTEAM_WORKSPACE_ROOT: root, OPENTEAM_AGENT_DATA_ROOT: join(root, "data"), OPENTEAM_AUTH_MODE: "disabled" });
    await start();
    await body({
      app: () => app!, http, request, until, reviewed, stopWorker, turns, reviews, tools,
      setTurn(handler) { onTurn = handler; }, setInference(handler) { onInference = handler; },
      gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); releases.push(release); return { promise, release }; },
      async restart() { await stopWorker(); await Effect.runPromise(app!.close()); app = undefined; await start(); },
      async createBot() {
        const bot = await http("/api/bots", "POST", { name: "Synthetic lifecycle user", clientRequestId: crypto.randomUUID() });
        await until(async () => await app!.prisma.bot.count({ where: { id: bot.id, status: "active", onboardingStatus: "completed" } }) === 1);
        const channel = await app!.prisma.channel.findUniqueOrThrow({ where: { directKey: `bot:${bot.id}` } });
        const result = { id: bot.id, conversationId: bot.conversationId, channelId: channel.id }; bots.push(result); channels.push(channel.id); return result;
      },
      async send(bot, content, channelId = bot.channelId) {
        if (!channels.includes(channelId)) channels.push(channelId);
        const before = new Set(turns.map(turn => turn.runId));
        await http(channelId === bot.channelId ? `/api/conversations/${bot.conversationId}/messages` : `/api/channels/${channelId}/messages`, "POST", { content, clientId: crypto.randomUUID() });
        let input: ComputerTurnRequest | undefined;
        await until(async () => {
          input = turns.find(turn => !before.has(turn.runId) && turn.botId === bot.id && turn.channelId === channelId && turn.content.includes(content));
          return Boolean(input && await app!.prisma.run.count({ where: { id: input.runId, status: "completed", inboxEvents: { some: { status: "completed" } } } }));
        });
        // A room can select a peer for the visible answer and give this bot a
        // later quiet turn. Publication also follows durable inbox settlement.
        let visible = false;
        await until(async () => {
          const snapshot = await http(`/api/channels/${channelId}`);
          const visibleRunIds = channelId === bot.channelId ? [input!.runId]
            : turns.filter(turn => !before.has(turn.runId) && turn.channelId === channelId).map(turn => turn.runId);
          visible = snapshot.messages.some((message: any) => visibleRunIds.includes(message.sourceRunId) && message.sender === "agent");
          return visible;
        });
        expect(visible).toBe(true);
        return input!;
      },
    });
  } finally {
    for (const release of releases) release();
    await stopWorker();
    if (app) await Effect.runPromise(app.close());
    computer.stop(true); api.stop(true);
    const cleanup = createPrismaClient(databaseUrl!);
    try {
      const ids = bots.map(bot => bot.id);
      await cleanup.memoryFact.deleteMany({ where: { writtenByBotId: { in: ids } } });
      await cleanup.idempotencyRecord.deleteMany({ where: { OR: ids.map(id => ({ scope: `state:${id}` })) } });
      await cleanup.channel.deleteMany({ where: { id: { in: channels } } });
      await cleanup.bot.deleteMany({ where: { id: { in: ids } } });
      await cleanup.retiredAgent.deleteMany({ where: { id: { in: ids } } });
    } finally { await cleanup.$disconnect(); }
    for (const key of keys) { const value = previous.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
}

dbTest("clearing the memory panel after correction fences the delayed review and its cached prompt", async () => fixture(async h => {
  const old = "The user's favourite football player is Ronaldo.", current = "The user's favourite football player is Messi.";
  const remember = "Remember Ronaldo as my favourite football player.", correct = "My favourite football player is now Messi.";
  const gate = h.gate();
  h.setTurn(async (input, call) => {
    if (input.content.includes(remember)) { await call("UpdateMemory", { action: "write", type: "profile", fact: old }); return "Remembered Ronaldo."; }
    if (input.content.includes(correct)) {
      const recall = String(await call("RecallMemory", { query: "favourite football player" }));
      const id = /\bid: ([\da-f-]{36})/.exec(recall)?.[1];
      expect(id).toBeDefined(); await call("UpdateMemory", { action: "replace", type: "profile", id, fact: current }); return "Corrected to Messi.";
    }
    if (input.content.includes("Who is my favourite football player?")) {
      const recall = String(await call("RecallMemory", { query: "favourite football player" }));
      expect(recall).not.toMatch(/Ronaldo|Messi/); return "No saved favourite remains.";
    }
    return "Lifecycle fixture ready.";
  });
  h.setInference(async prompt => { if (prompt.includes(correct)) { await gate.promise; return `profile: ${current}\nprofile: A delayed review must not restore this cleared exchange.`; } return "NONE"; });
  const bot = await h.createBot(), first = await h.send(bot, remember); await h.reviewed(first.runId);
  const correction = await h.send(bot, correct);
  await h.until(async () => h.reviews.some(prompt => prompt.includes(correct)));
  expect(await h.http(`/api/bots/${bot.id}/memories`)).toMatchObject({ memories: [{ content: current }] });
  const pending = await h.app().prisma.run.findUniqueOrThrow({ where: { id: correction.runId } });
  expect(pending.memoryReviewPending).toBe(true);
  expect(await h.http(`/api/bots/${bot.id}/memories`, "DELETE")).toMatchObject({ memories: [], total: 0 });
  const afterClear = await h.app().prisma.bot.findUniqueOrThrow({ where: { id: bot.id } });
  const sharedRevision = await h.app().prisma.memoryRevision.findUnique({ where: { scope: "user" } });
  expect(afterClear.memoryRevision + (sharedRevision?.revision ?? 0)).toBeGreaterThan(pending.memoryReviewRevision!);
  expect((await h.app().prisma.contextPromptSnapshot.findUniqueOrThrow({ where: { contextSessionId: correction.contextSessionId } })).promptSections).not.toHaveProperty("memory");
  gate.release(); await h.reviewed(correction.runId);
  expect(await h.app().prisma.memoryFact.count({ where: { writtenByBotId: bot.id } })).toBe(0);
  const probe = await h.send(bot, "Who is my favourite football player?"); await h.reviewed(probe.runId);
  expect(probe.contextSessionId).toBe(correction.contextSessionId);
  expect(probe.userInfo).not.toMatch(/Ronaldo|Messi|delayed review/i);
  expect((await h.app().prisma.bot.findUniqueOrThrow({ where: { id: bot.id } })).pendingMemoryExchanges).toEqual([]);
  expect(await h.app().prisma.memoryReviewLease.count({ where: { botId: bot.id } })).toBe(0);
}), 120_000);

dbTest("rejected hiding and idempotent unhiding preserve review work, while archive survives restart without replaying its backlog", async () => fixture(async h => {
  const content = "Remember my synthetic archived lifecycle preference for amber calendars.";
  let failures = 0;
  h.setInference(async () => { failures++; return Response.json({ error: "Controlled lifecycle outage" }, { status: 503 }); });
  const bot = await h.createBot();
  const group = await h.http("/api/channels", "POST", { name: "Reversible sidebar lifecycle", botIds: [bot.id] });
  const turn = await h.send(bot, content, group.id);
  await h.until(async () => failures >= 3 && await h.app().prisma.memoryReviewLease.count({ where: { botId: bot.id } }) === 0);
  await h.stopWorker();
  for (const hidden of [true, false]) {
    const response = await h.request(`/api/channels/${group.id}/hidden`, "PATCH", { hidden, clientId: crypto.randomUUID() });
    expect(response.status).toBe(hidden ? 400 : 200);
    if (hidden) expect(await response.json()).toMatchObject({ error: { code: "hiding_removed" } });
    expect(await h.app().prisma.channel.findUniqueOrThrow({ where: { id: group.id } })).toMatchObject({ hiddenFromSidebar: false, archivedAt: null });
    expect(await h.app().prisma.run.findUniqueOrThrow({ where: { id: turn.runId } })).toMatchObject({ status: "completed", memoryReviewPending: true });
  }
  expect((await h.app().prisma.bot.findUniqueOrThrow({ where: { id: bot.id } })).pendingMemoryExchanges).toEqual([expect.objectContaining({ id: turn.runId, user: content })]);
  await h.http(`/api/bots/${bot.id}/archive`, "POST");
  expect(await h.app().prisma.bot.findUniqueOrThrow({ where: { id: bot.id } })).toMatchObject({ status: "archived" });
  expect((await h.request(`/api/bots/${bot.id}/unarchive`, "POST")).status).toBe(404); // No public restore API is shipped.
  const attempts = failures;
  await h.restart();
  await h.reviewed(turn.runId);
  expect(failures).toBe(attempts);
  expect(await h.app().prisma.memoryFact.count({ where: { writtenByBotId: bot.id } })).toBe(0);
  expect(await h.app().prisma.memoryReviewLease.count({ where: { botId: bot.id } })).toBe(0);
  expect(await h.app().prisma.contextSession.count({ where: { botId: bot.id } })).toBe(0);
  expect((await h.app().prisma.channel.findUniqueOrThrow({ where: { id: bot.channelId } })).archivedAt).not.toBeNull();
  expect((await h.request(`/api/bots/${bot.id}/memories`)).status).toBe(404);
}), 120_000);

dbTest("switching into a shared chat and widening membership cannot expose shared-owner facts from a delayed private review", async () => fixture(async h => {
  const secret = "The owner's private lifecycle code is CITRINE-207.";
  const store = "Remember my private lifecycle code CITRINE-207 in shared user memory.";
  const gate = h.gate();
  let roomId: string | undefined;
  h.setTurn(async (input, call) => {
    if (input.content.includes(store)) { await call("UpdateMemory", { action: "write", type: "shared_profile", fact: secret }); return "Saved the private code."; }
    if (input.channelId === roomId) {
      expect(input.userInfo).not.toContain("CITRINE-207");
      const recall = String(await call("RecallMemory", { query: "private lifecycle code" }));
      expect(recall).not.toContain("CITRINE-207");
      expect(await call("UpdateMemory", { action: "write", type: "shared_profile", fact: "Forbidden room write SHOULD-NOT-STORE-207." })).toContain("Not saved");
      if (input.deliveryId && (await h.app().prisma.channelDelivery.findUniqueOrThrow({ where: { id: input.deliveryId }, include: { round: true } })).round.roundIndex > 0) return null;
      return "Private shared memory is unavailable in this room.";
    }
    if (input.content.includes("Read my private lifecycle code.")) {
      expect(String(await call("RecallMemory", { query: "private lifecycle code" }))).toContain(secret);
      return "Your private code remains available in your personal chat.";
    }
    return "Lifecycle fixture ready.";
  });
  h.setInference(async prompt => { if (prompt.includes(store)) await gate.promise; return "NONE"; });
  const bot = await h.createBot(), privateTurn = await h.send(bot, store);
  await h.until(async () => h.reviews.some(prompt => prompt.includes(store)));
  roomId = (await h.http("/api/channels", "POST", { name: "Changing privacy context", botIds: [bot.id] })).id;
  const initialRoom = await h.send(bot, "Can this room read my private lifecycle code?", roomId);
  expect(initialRoom.contextSessionId).not.toBe(privateTurn.contextSessionId);
  expect((await h.app().prisma.run.findUniqueOrThrow({ where: { id: privateTurn.runId } })).memoryReviewPending).toBe(true);
  const peer = await h.createBot();
  await h.http(`/api/channels/${roomId}/members`, "PUT", { botIds: [bot.id, peer.id], clientId: crypto.randomUUID() });
  const widenedRoom = await h.send(bot, "With another member, can this room read my private lifecycle code?", roomId);
  expect(widenedRoom.userInfo).not.toContain("CITRINE-207");
  expect((await h.app().prisma.run.findUniqueOrThrow({ where: { id: privateTurn.runId } })).memoryReviewPending).toBe(true);
  gate.release(); await h.reviewed(privateTurn.runId); await h.reviewed(initialRoom.runId); await h.reviewed(widenedRoom.runId);
  await h.until(async () => await h.app().prisma.run.count({ where: { botId: { in: [bot.id, peer.id] }, OR: [{ memoryReviewPending: true }, { status: { in: ["queued", "running"] } }] } }) === 0);
  const personal = await h.send(bot, "Read my private lifecycle code."); await h.reviewed(personal.runId);
  // Additions remain pinned until the next epoch; explicit recall must still
  // retrieve the shared fact in a personal chat after these context switches.
  expect(h.tools.find(tool => tool.runId === personal.runId && tool.tool === "RecallMemory")!.result).toContain(secret);
  const roomTurns = h.turns.filter(turn => turn.channelId === roomId);
  expect(roomTurns.length).toBeGreaterThanOrEqual(2);
  for (const turn of roomTurns) expect(turn.userInfo).not.toContain("CITRINE-207");
  const roomReviews = h.reviews.filter(prompt => prompt.toLowerCase().includes("can this room read my private lifecycle code?"));
  expect(roomReviews.length).toBeGreaterThanOrEqual(2);
  for (const prompt of roomReviews) expect(prompt).not.toContain("CITRINE-207");
  expect(await h.app().prisma.memoryFact.findMany({ where: { writtenByBotId: bot.id }, select: { fact: true, scope: true } })).toEqual([{ fact: secret, scope: "user" }]);
  expect(await h.app().prisma.memoryFact.count({ where: { fact: { contains: "SHOULD-NOT-STORE-207" } } })).toBe(0);
  expect(await h.app().prisma.run.count({ where: { botId: { in: [bot.id, peer.id] }, memoryReviewPending: true } })).toBe(0);
}), 180_000);
