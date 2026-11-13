import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { DynamicToolCallRequest, type ComputerTurnRequest } from "@openteam/contracts";
import { AppService } from "../../server/src/app-service";
import { errorResponse, json, parseBody } from "../../server/src/http";
import { botRoutes } from "../../server/src/routes/bot";
import { channelRoutes } from "../../server/src/routes/channel";
import { clientRoutes } from "../../server/src/routes/client";
import { conversationRoutes } from "../../server/src/routes/conversation";
import { WakeWorker } from "../src/worker";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const oldFact = "My favourite football player is Ronaldo.";
const currentFact = "My favourite player is now Messi.";
const question = "Who is my favourite football player?";
const currentReply = "Your favourite football player is Messi.";
const missingReply = "I don't have a saved favourite football player.";

// This exercises production HTTP handlers, tool execution, queue dispatch and
// PostgreSQL persistence. The computer/model is a controlled fixture: it selects
// tools deterministically and answers from their actual results. Extraction is
// deliberately NONE, so it cannot hide a broken explicit write/replace/forget.
test.skipIf(!databaseUrl)("a user remembers, corrects, recalls across fresh chats and restart, then forgets through HTTP", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-user-journey-"));
  const token = "synthetic-memory-journey-control";
  const groupIds: string[] = [];
  const turns: ComputerTurnRequest[] = [];
  const extractions: string[] = [];
  const toolResults: Array<{ runId: string; tool: string; args: unknown; result: unknown }> = [];
  const fixtureErrors: unknown[] = [];
  let app: AppService | undefined;
  let worker: WakeWorker | undefined;
  let botId: string | undefined;
  let appStarts = 0;
  const keys = ["DATABASE_URL", "OPENTEAM_COMPUTER_URL", "OPENTEAM_CONTROL_TOKEN", "OPENTEAM_WORKSPACE_ROOT", "OPENTEAM_AGENT_DATA_ROOT", "OPENTEAM_AUTH_MODE"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));

  // Public routes are the same handlers main.ts dispatches. The internal tool
  // branch uses main.ts's authenticated body decoder and AppService entrypoint.
  const api = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    try {
      if (!app) return json({ error: "app unavailable" }, 503);
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/api/internal/tools/call") {
        if (request.headers.get("authorization") !== `Bearer ${token}`) return json({ error: "Unauthorized" }, 401);
        return json(await Effect.runPromise(app.handleDynamicTool(await parseBody(request, DynamicToolCallRequest))));
      }
      const context = { app, request, url, path: url.pathname, authMode: "disabled" as const, authenticatedSessionId: null };
      for (const route of [botRoutes, channelRoutes, conversationRoutes, clientRoutes]) {
        const response = await route(context);
        if (response) return response;
      }
      return json({ error: "Not found" }, 404);
    } catch (error) { return errorResponse(error); }
  } });
  const http = async <T = any>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(new URL(path, api.url), {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${JSON.stringify(result)}`);
    return result as T;
  };
  const computer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/v1/task-capabilities") return Response.json({ desktopAvailable: true, boxAvailable: true });
    if (path === "/health") return Response.json({ status: "ready", inference: { ready: true, authenticated: true } });
    if (path === "/v1/agent-stores" && request.method === "GET") return Response.json({ agents: [] });
    if (path === "/v1/infer") {
      const input = await request.json() as { kind: string; prompt: string };
      if (input.kind === "extraction") extractions.push(input.prompt);
      return Response.json({ text: "NONE" });
    }
    if (path === "/v1/directories") {
      const input = await request.json() as { paths: string[] };
      for (const directory of input.paths ?? []) await mkdir(directory, { recursive: true });
      return Response.json({ directories: input.paths });
    }
    if (path.startsWith("/v1/context-sessions/") && request.method === "GET")
      return Response.json({ type: "context.state", contextSessionId: path.split("/").at(-1), epoch: 0, archives: [] });
    if (path !== "/v1/turns") return Response.json({ ok: true, quarantined: [] });
    const input = await request.json() as ComputerTurnRequest;
    turns.push(input);
    try {
      const call = async (tool: string, args: unknown) => {
        const result = await http("/api/internal/tools/call", {
          runId: input.runId, botId: input.botId, conversationId: input.conversationId,
          channelId: input.channelId, deliveryId: input.deliveryId, callId: crypto.randomUUID(), tool, arguments: args,
        });
        toolResults.push({ runId: input.runId, tool, args, result });
        return result;
      };
      let reply = "Memory journey ready.";
      if (input.content.includes("Remember my favourite football player: Ronaldo.")) {
        await call("UpdateMemory", { action: "write", type: "profile", fact: oldFact });
        reply = "Remembered Ronaldo as your favourite football player.";
      } else if (input.content.includes("Correct my favourite football player to Messi.")) {
        const recall = String(await call("RecallMemory", { query: question }));
        const id = /\bid: ([\da-f-]{36})/.exec(recall)?.[1];
        if (!id) throw new Error(`Correction did not receive an editable fact: ${recall}`);
        await call("UpdateMemory", { action: "replace", type: "profile", id, fact: currentFact });
        await call("RecallMemory", { query: question, includeHistory: true });
        reply = "Corrected your favourite football player to Messi.";
      } else if (input.content.includes("Forget my favourite football player.")) {
        const recall = String(await call("RecallMemory", { query: question }));
        if (!recall.includes(currentFact)) throw new Error(`Forget did not recall the current fact: ${recall}`);
        await call("UpdateMemory", { action: "forget", type: "profile", fact: currentFact });
        reply = "Forgot your favourite football player.";
      } else if (input.content.includes(question)) {
        const recall = String(await call("RecallMemory", { query: question }));
        reply = recall.includes(currentFact) ? currentReply
          : recall.includes(oldFact) ? "Your favourite football player is Ronaldo." : missingReply;
      }
      await call("SendToUser", { type: "text", content: reply });
      return new Response([
        { type: "session.attached", runtimeEngine: "pi", inferenceProvider: "openai-codex", contextSessionId: input.contextSessionId,
          sessionPath: input.sessionPath ?? `/var/lib/openteam/pi/${input.contextSessionId}.jsonl`, sessionId: input.contextSessionId, model: "controlled-memory-journey" },
        { type: "context.state", contextSessionId: input.contextSessionId, epoch: 0, archives: [] },
        { type: "turn.started", turnId: input.runId },
        { type: "prompt.delivered", turnId: input.runId },
        { type: "turn.completed", turnId: input.runId, status: "completed" },
      ].map(event => JSON.stringify(event)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });
    } catch (error) {
      fixtureErrors.push(error);
      return Response.json({ error: String(error) }, { status: 500 });
    }
  } });
  const until = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 600; i++) {
      if (fixtureErrors.length) throw fixtureErrors[0];
      if (await check()) return;
      await Bun.sleep(50);
    }
    throw new Error("Memory journey timed out");
  };
  const start = async () => {
    app = new AppService("disabled");
    await Effect.runPromise(app.boot());
    appStarts++;
    worker = new WakeWorker();
    await worker.start();
  };
  const stop = async () => {
    await worker?.stop(); worker = undefined;
    if (app) { await Effect.runPromise(app.close()); app = undefined; }
  };
  const send = async (channelId: string, content: string, reply: string, conversationId?: string) => {
    const before = new Set(turns.map(turn => turn.runId));
    await http(conversationId ? `/api/conversations/${conversationId}/messages` : `/api/channels/${channelId}/messages`, { content, clientId: crypto.randomUUID() });
    let input: ComputerTurnRequest | undefined;
    await until(async () => {
      input = turns.find(turn => !before.has(turn.runId) && turn.channelId === channelId && turn.content.includes(content));
      return Boolean(input && await app!.prisma.run.count({ where: { id: input.runId, status: "completed", memoryReviewPending: false, inboxEvents: { some: { status: "completed" } } } }));
    });
    const visible = await http<{ messages: Array<{ sourceRunId: string | null; content: string; sender: string }> }>(`/api/channels/${channelId}`);
    expect(visible.messages.filter(message => message.sourceRunId === input!.runId && message.sender === "agent").map(message => message.content)).toEqual([reply]);
    return input!;
  };
  const snapshot = async (contextSessionId: string) =>
    (await app!.prisma.contextPromptSnapshot.findUniqueOrThrow({ where: { contextSessionId } })).promptSections as Record<string, { render: string }>;

  try {
    Object.assign(process.env, { DATABASE_URL: databaseUrl, OPENTEAM_COMPUTER_URL: computer.url.origin, OPENTEAM_CONTROL_TOKEN: token,
      OPENTEAM_WORKSPACE_ROOT: root, OPENTEAM_AGENT_DATA_ROOT: join(root, "data"), OPENTEAM_AUTH_MODE: "disabled" });
    await start();
    await app!.agentData.writeInferenceSettings({ providerId: "openai-codex", modelId: "controlled-memory-journey", reasoning: "low" });
    const bot = await http<{ id: string; conversationId: string }>("/api/bots", { name: "Memory user journey", clientRequestId: crypto.randomUUID() });
    botId = bot.id;
    await until(async () => Boolean(await app!.prisma.bot.count({ where: { id: bot.id, status: "active", onboardingStatus: "completed" } })));
    const home = await app!.prisma.channel.findUniqueOrThrow({ where: { directKey: `bot:${bot.id}` } });
    const remember = await send(home.id, "Remember my favourite football player: Ronaldo.", "Remembered Ronaldo as your favourite football player.", bot.conversationId);
    const original = await app!.prisma.memoryFact.findFirstOrThrow({ where: { writtenByBotId: bot.id, supersededAt: null } });
    expect(original).toMatchObject({ fact: oldFact, origin: "tool", turnId: remember.runId, scope: "agent", tier: "profile" });
    const cached = await http<{ id: string }>("/api/channels", { name: "Previously cached memory chat", botIds: [bot.id] });
    groupIds.push(cached.id);
    const primed = await send(cached.id, question, "Your favourite football player is Ronaldo.");
    expect(primed.userInfo).toContain(oldFact);
    expect((await snapshot(primed.contextSessionId)).memory!.render).toContain(oldFact);

    const correction = await send(home.id, "Correct my favourite football player to Messi.", "Corrected your favourite football player to Messi.", bot.conversationId);
    expect(await snapshot(primed.contextSessionId)).not.toHaveProperty("memory");
    const corrected = await app!.prisma.memoryFact.findFirstOrThrow({ where: { writtenByBotId: bot.id, supersededAt: null } });
    expect(corrected).toMatchObject({ fact: currentFact, origin: "tool", turnId: correction.runId });
    expect(await app!.prisma.memoryFact.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({ supersededById: corrected.id, supersededAt: expect.any(Date) });
    expect(await http(`/api/bots/${bot.id}/memories`)).toMatchObject({ memories: [{ content: currentFact }] });

    const fresh = await http<{ id: string }>("/api/channels", { name: "Fresh memory chat", botIds: [bot.id] });
    groupIds.push(fresh.id);
    const freshAsk = await send(fresh.id, question, currentReply);
    expect(freshAsk.contextSessionId).not.toBe(primed.contextSessionId);
    expect(freshAsk.contextSessionId).not.toBe(remember.contextSessionId);
    expect(freshAsk.userInfo).toContain(currentFact);
    expect(freshAsk.userInfo).not.toContain(oldFact);
    expect(freshAsk.sessionPath).toBeNull();

    const originalApp = app, originalWorker = worker;
    await stop();
    await start();
    expect(appStarts).toBe(2);
    expect(app).not.toBe(originalApp);
    expect(worker).not.toBe(originalWorker);
    const afterRestart = await send(cached.id, question, currentReply);
    expect(afterRestart.contextSessionId).toBe(primed.contextSessionId);
    expect(afterRestart.sessionPath).toBe(primed.sessionPath ?? `/var/lib/openteam/pi/${primed.contextSessionId}.jsonl`);
    expect(afterRestart.userInfo).toContain(currentFact);
    expect(afterRestart.userInfo).not.toContain(oldFact);
    expect((await snapshot(afterRestart.contextSessionId)).memory!.render).toContain(currentFact);

    const forget = await send(home.id, "Forget my favourite football player.", "Forgot your favourite football player.", bot.conversationId);
    expect(await snapshot(afterRestart.contextSessionId)).not.toHaveProperty("memory");
    expect(await snapshot(freshAsk.contextSessionId)).not.toHaveProperty("memory");
    expect(await http(`/api/bots/${bot.id}/memories`)).toMatchObject({ memories: [] });
    const missing = await send(cached.id, question, missingReply);
    expect(missing.userInfo).not.toContain(currentFact);
    expect(missing.userInfo).not.toContain(oldFact);
    expect((await snapshot(missing.contextSessionId)).memory!.render).not.toMatch(/Ronaldo|Messi/);
    expect(await app!.prisma.memoryFact.count({ where: { writtenByBotId: bot.id, supersededAt: null } })).toBe(0);
    expect(await app!.prisma.memoryFact.count({ where: { writtenByBotId: bot.id, fact: currentFact } })).toBe(0);

    const callsFor = (runId: string, tool: string) => toolResults.filter(call => call.runId === runId && call.tool === tool);
    expect(callsFor(correction.runId, "RecallMemory")[0]!.result).toContain(oldFact);
    expect(callsFor(correction.runId, "RecallMemory")[1]!.result).toContain(oldFact);
    expect(callsFor(correction.runId, "RecallMemory")[1]!.result).toContain(currentFact);
    expect(callsFor(correction.runId, "RecallMemory")[1]!.result).toContain("superseded");
    expect(callsFor(correction.runId, "UpdateMemory")[0]!.args).toMatchObject({ action: "replace", id: original.id });
    expect(callsFor(afterRestart.runId, "RecallMemory")[0]!.result).toContain(currentFact);
    expect(callsFor(afterRestart.runId, "RecallMemory")[0]!.result).not.toContain(oldFact);
    expect(callsFor(forget.runId, "UpdateMemory")[0]!.result).toContain("Forgot");
    expect(callsFor(missing.runId, "RecallMemory")[0]!.result).not.toMatch(/Ronaldo|Messi/);
    expect(extractions).toHaveLength(7);
    expect(extractions.some(prompt => prompt.includes("Assistant: Corrected your favourite football player to Messi."))).toBe(true);
    expect(extractions.some(prompt => prompt.includes(`Assistant: ${missingReply}`))).toBe(true);
    expect(await app!.prisma.run.count({ where: { botId: bot.id, memoryReviewPending: true } })).toBe(0);
    expect(await app!.prisma.memoryReviewLease.count({ where: { botId: bot.id } })).toBe(0);
    expect((await app!.prisma.bot.findUniqueOrThrow({ where: { id: bot.id } })).pendingMemoryExchanges).toEqual([]);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await worker?.stop();
    if (app) {
      await app.agentData.stopWatching();
      if (botId) {
        await app.prisma.memoryFact.deleteMany({ where: { writtenByBotId: botId } });
        await app.prisma.channel.deleteMany({ where: { OR: [{ id: { in: groupIds } }, { directKey: `bot:${botId}` }] } });
        await app.prisma.bot.deleteMany({ where: { id: botId } });
      }
      await Effect.runPromise(app.close());
    }
    api.stop(true); computer.stop(true);
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
