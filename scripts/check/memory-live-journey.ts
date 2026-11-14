/**
 * Opt-in real MAIN-agent memory journey through ComputerRuntime, WakeWorker,
 * production platform prompts and HTTP tool/public routes. All user data is synthetic.
 * Both the main agent and automatic extractor use the explicitly selected live model.
 *
 * OPENTEAM_MEMORY_LIVE=1 OPENTEAM_TEST_DATABASE_URL=... \
 * OPENTEAM_PI_AGENT_DIR=/absolute/disposable/already-imported-pi-auth \
 * OPENTEAM_MEMORY_LIVE_MODEL=openai-codex/<selected-model> \
 * OPENTEAM_MEMORY_LIVE_REASONING=medium bun scripts/check/memory-live-journey.ts
 * Optional: OPENTEAM_MEMORY_LIVE_RESULTS=/absolute/sanitized-results.json
 *
 * Credentials must already be imported into a disposable application Pi directory.
 * This script copies that input into its own temporary Pi root; it never imports
 * vendor CLI credentials, writes source authentication, or chooses a model for you.
 * Only RecallMemory, UpdateMemory and SendToUser are registered and HTTP-allowed.
 * SendToUser writes only to this harness's synthetic PostgreSQL chat.
 */
import { access, chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { run } from "../../apps/server/src/routes/context";
import { DynamicToolCallRequest, type ComputerTurnRequest } from "../../packages/contracts/src/index";
import { normalizePiReasoningLevel, parsePiModelRef } from "../../packages/contracts/src/inference";
import { ComputerRuntime } from "../../apps/computer/src/runtime";
import type { RuntimeTools } from "../../apps/computer/src/runtime/tools";
import { ScreenBroker } from "../../apps/computer/src/screen-broker";
import { AppService } from "../../apps/server/src/app-service";
import { WakeWorker } from "../../apps/worker/src/worker";
import { botRoutes } from "../../apps/server/src/routes/bot";
import { channelRoutes } from "../../apps/server/src/routes/channel";
import { conversationRoutes } from "../../apps/server/src/routes/conversation";
import { errorResponse, json, parseBody } from "../../apps/server/src/http";

if (process.env.OPENTEAM_MEMORY_LIVE !== "1") throw new Error("Set OPENTEAM_MEMORY_LIVE=1 to explicitly enable live model calls.");
const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Set OPENTEAM_TEST_DATABASE_URL to a dedicated disposable database with the current schema.");
const importedPi = process.env.OPENTEAM_PI_AGENT_DIR;
if (!importedPi || !isAbsolute(importedPi)) throw new Error("Set OPENTEAM_PI_AGENT_DIR to an absolute disposable directory containing already imported application authentication.");
if ([join(homedir(), ".pi", "agent"), "/home/box/.pi/agent"].includes(resolve(importedPi)))
  throw new Error("Production/default Pi authentication directories are forbidden; use an explicitly imported disposable directory.");
await access(join(importedPi, "auth.json"));
const model = process.env.OPENTEAM_MEMORY_LIVE_MODEL;
if (!model) throw new Error("Set OPENTEAM_MEMORY_LIVE_MODEL explicitly; there is no default.");
const modelRef = parsePiModelRef(model);
const reasoningInput = process.env.OPENTEAM_MEMORY_LIVE_REASONING;
if (!reasoningInput) throw new Error("Set OPENTEAM_MEMORY_LIVE_REASONING explicitly.");
const reasoning = normalizePiReasoningLevel(reasoningInput);
const resultsPath = process.env.OPENTEAM_MEMORY_LIVE_RESULTS;
if (resultsPath && !isAbsolute(resultsPath)) throw new Error("OPENTEAM_MEMORY_LIVE_RESULTS must be an absolute path.");
if (resultsPath && (resolve(resultsPath) === resolve(importedPi) || resolve(resultsPath).startsWith(resolve(importedPi) + sep)))
  throw new Error("Results must be outside the imported authentication directory.");

const environmentKeys = ["DATABASE_URL", "OPENTEAM_PI_AGENT_DIR", "OPENTEAM_AGENT_DATA_ROOT", "OPENTEAM_WORKSPACE_ROOT", "OPENTEAM_CONTROL_TOKEN", "OPENTEAM_AUTH_MODE", "OPENTEAM_WORKER_CONCURRENCY", "OPENTEAM_SERVER_URL", "OPENTEAM_COMPUTER_URL"] as const;
const previousEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
const root = await mkdtemp(join(tmpdir(), "openteam-memory-live-journey-"));
await chmod(root, 0o700);
const workspace = join(root, "workspace");
const token = crypto.randomUUID();
const allowed = new Set(["RecallMemory", "UpdateMemory", "SendToUser"]);
type Fact = { id: string; fact: string; scope: string; origin: string; turnId: string | null; supersededAt: Date | null; supersededById: string | null };
type ToolCall = { step: string; runId: string; tool: string; args: Record<string, unknown>; result?: unknown };
type Step = { name: string; runId: string; contextSessionId: string; coldSession: boolean; promptHasRonaldo: boolean; promptHasMessi: boolean; messages: string[]; facts: Fact[]; elapsedMs: number };
const calls: ToolCall[] = [], requests: ComputerTurnRequest[] = [], extractionOutputs: Array<{ step: string; text: string }> = [], steps: Step[] = [];
const checks: Record<string, boolean> = {};
const clientIds: string[] = [], channelIds: string[] = [];
const report: Record<string, unknown> = { model, reasoning, realMainAgent: true, realExtractor: true, toolAllowlist: [...allowed], steps, calls, checks };
let currentStep = "setup", botId = "", conversationId = "";
let app: AppService | undefined, worker: WakeWorker | undefined, runtime: ComputerRuntime | undefined;
let api: ReturnType<typeof Bun.serve> | undefined, computer: ReturnType<typeof Bun.serve> | undefined;
let transportFailed = false;
const abort = new AbortController();
const deadline = setTimeout(() => abort.abort(new Error("Live journey deadline exceeded")), 12 * 60_000);
const activeFacts = (step: Step) => step.facts.filter(fact => !fact.supersededAt);
const has = (facts: Fact[], player: string) => facts.some(fact => fact.fact.includes(player));

try {
  const pi = join(root, "pi");
  await mkdir(pi, { mode: 0o700 });
  await mkdir(workspace);
  for (const name of ["auth.json", "models.json", "models-store.json"]) {
    try { await copyFile(join(importedPi, name), join(pi, name)); await chmod(join(pi, name), 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  Object.assign(process.env, { DATABASE_URL: databaseUrl, OPENTEAM_PI_AGENT_DIR: pi, OPENTEAM_AGENT_DATA_ROOT: join(root, "data"),
    OPENTEAM_WORKSPACE_ROOT: workspace, OPENTEAM_CONTROL_TOKEN: token, OPENTEAM_AUTH_MODE: "disabled", OPENTEAM_WORKER_CONCURRENCY: "2" });
  api = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 255, async fetch(request) {
    try {
      const url = new URL(request.url);
      // main.ts normalizes the versioned internal route before dispatch too.
      url.pathname = url.pathname.replace(/^\/api\/v0(?=\/)/, "/api");
      if (url.pathname === "/api/internal/tools/call") {
        if (request.headers.get("authorization") !== `Bearer ${token}`) return json({ error: "Unauthorized" }, 401);
        const body = await parseBody(request, DynamicToolCallRequest);
        if (!allowed.has(body.tool) || body.botId !== botId || !channelIds.includes(body.channelId)) return json({ error: "Outside synthetic memory journey allowlist" }, 403);
        const call: ToolCall = { step: currentStep, runId: body.runId, tool: body.tool, args: body.arguments as Record<string, unknown> };
        calls.push(call);
        call.result = await run(app!.handleDynamicTool(body));
        return json(call.result);
      }
      const context = { app: app!, request, url, path: url.pathname, authMode: "disabled" as const, authenticatedSessionId: null };
      for (const route of [botRoutes, channelRoutes, conversationRoutes]) { const response = await route(context); if (response) return response; }
      return json({ error: "Not found" }, 404);
    } catch (error) { return errorResponse(error); }
  } });
  process.env.OPENTEAM_SERVER_URL = api.url.origin;
  runtime = new ComputerRuntime(new ScreenBroker(join(root, "home")));
  // Safety boundary only: keep the shipped tool schemas/descriptions/implementation,
  // production platformPrompt and memory policy. No scripted model/tool decisions.
  const runtimeTools = (runtime as unknown as { tools: RuntimeTools }).tools;
  const originalTools = runtimeTools.customTools.bind(runtimeTools);
  runtimeTools.customTools = active => originalTools(active).filter(tool => allowed.has(tool.name));
  computer = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 255, async fetch(request, server) {
    server.timeout(request, 0);
    const path = new URL(request.url).pathname;
    try {
      if (path === "/health") { await runtime!.start(); return Response.json({ status: "ready", inference: runtime!.diagnostics }); }
      if (path === "/v1/task-capabilities") return Response.json({ desktopAvailable: false, boxAvailable: true });
      if (path === "/v1/agent-stores" && request.method === "GET") return Response.json({ agents: [] });
      if (path === "/v1/directories") { const input = await request.json() as { paths: string[] }; for (const directory of input.paths ?? []) await mkdir(directory, { recursive: true }); return Response.json({ directories: input.paths }); }
      if (path.startsWith("/v1/context-sessions/") && request.method === "GET") return Response.json(await runtime!.contextState(path.split("/").at(-1)!));
      if (path === "/v1/infer") {
        const input = await request.json() as Parameters<ComputerRuntime["infer"]>[0];
        const text = await runtime!.infer({ ...input, cwd: workspace, signal: AbortSignal.any([request.signal, abort.signal]) });
        extractionOutputs.push({ step: currentStep, text });
        return Response.json({ text });
      }
      if (path === "/v1/turns") {
        const input = await request.json() as ComputerTurnRequest;
        requests.push(input);
        const events = await runtime!.run(input, AbortSignal.any([request.signal, abort.signal]));
        return new Response(new ReadableStream({ async start(controller) {
          try { for await (const event of events) controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n")); controller.close(); }
          catch { transportFailed = true; controller.error(new Error("Live runtime stream failed; provider details suppressed")); }
        } }), { headers: { "content-type": "application/x-ndjson" } });
      }
      return Response.json({ ok: true, quarantined: [] });
    } catch {
      transportFailed = true;
      return Response.json({ error: "Live runtime failed; provider details suppressed" }, { status: 500 });
    }
  } });
  process.env.OPENTEAM_COMPUTER_URL = computer.url.origin;
  const http = async (path: string, body?: unknown): Promise<any> => {
    const response = await fetch(new URL(path, api!.url), { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: abort.signal });
    const value = await response.json();
    if (!response.ok) throw new Error(`Synthetic route failed (${response.status})`);
    return value;
  };
  const facts = () => app!.prisma.memoryFact.findMany({ where: { writtenByBotId: botId }, orderBy: { sourceOrdinal: "asc" },
    select: { id: true, fact: true, scope: true, origin: true, turnId: true, supersededAt: true, supersededById: true } });
  const send = async (name: string, content: string): Promise<Step> => {
    currentStep = name;
    const before = new Set(requests.map(request => request.runId)), started = Date.now();
    const clientId = crypto.randomUUID(); clientIds.push(clientId);
    await http(`/api/conversations/${conversationId}/messages`, { content, clientId });
    let input: ComputerTurnRequest | undefined;
    const turnDeadline = Date.now() + 240_000;
    while (Date.now() < turnDeadline) {
      abort.signal.throwIfAborted();
      if (transportFailed) throw new Error("Live runtime transport failed");
      input = requests.find(request => !before.has(request.runId) && request.content.includes(content));
      if (input) {
        const run = await app!.prisma.run.findUniqueOrThrow({ where: { id: input.runId }, include: { inboxEvents: true } });
        if (["failed", "interrupted", "cancelled"].includes(run.status)) throw new Error("Live synthetic turn did not complete");
        if (run.status === "completed" && !run.memoryReviewPending && run.inboxEvents.some(inbox => inbox.status === "completed")) break;
      }
      await Bun.sleep(100);
    }
    if (!input || Date.now() >= turnDeadline) throw new Error("Live synthetic turn timed out");
    const visible = await http(`/api/channels/${channelIds[0]}`);
    const messages = visible.messages.filter((message: any) => message.sourceRunId === input!.runId && message.sender === "agent").map((message: any) => message.content) as string[];
    if (!messages.length) throw new Error("Live synthetic turn published no visible reply");
    const step = { name, runId: input.runId, contextSessionId: input.contextSessionId, coldSession: !input.sessionPath,
      promptHasRonaldo: input.userInfo?.includes("Ronaldo") === true, promptHasMessi: input.userInfo?.includes("Messi") === true, messages, facts: await facts(), elapsedMs: Date.now() - started };
    steps.push(step);
    console.log(JSON.stringify({ step }));
    return step;
  };
  app = new AppService("disabled");
  await run(app.boot());
  await app.agentData.writeInferenceSettings({ ...modelRef, reasoning });
  await run(app.updateTaskSettings({ executorProfiles: [], graphicalAvailable: false }));
  const bot = await app.prisma.bot.create({ data: { name: "Synthetic live memory journey", status: "active", onboardingStatus: "completed", defaultDirectory: workspace, conversation: { create: {} } }, include: { conversation: true } });
  botId = bot.id; conversationId = bot.conversation!.id;
  const home = await app.prisma.channel.create({ data: { kind: "bot_dm", directKey: `bot:${bot.id}`, name: "Synthetic live memory journey", members: { create: { botId: bot.id, ordinal: 0 } } } });
  channelIds.push(home.id);
  await app.agentData.initializeBot(bot.id);
  await runtime.start();
  worker = new WakeWorker(); await worker.start();
  const remember = await send("remember", "My favourite football player is Ronaldo. Please remember that.");
  const correction = await send("correction", "My favourite football player is now Messi.");
  // The product has one private DM per bot. Readdress only the synthetic prior
  // context so the normal worker claim creates a new empty Pi session for that
  // same authorized DM; a group would intentionally use different privacy rules.
  const freshContext = async () => {
    const old = await app!.prisma.contextSession.findUniqueOrThrow({ where: { botId_scope_scopeId: { botId, scope: "channel", scopeId: home.id } } });
    await app!.prisma.contextSession.update({ where: { id: old.id }, data: { scopeId: crypto.randomUUID() } });
  };
  await freshContext();
  const recall = await send("fresh-recall", "Who is my favourite football player?");
  const forget = await send("forget", "Please forget my favourite football player.");
  await freshContext();
  const missing = await send("fresh-missing", "Who is my favourite football player?");
  const decisions = (step: Step, action: string) => calls.filter(call => call.runId === step.runId && call.tool === "UpdateMemory" && call.args.action === action);
  const previousPreferences = correction.facts.filter(fact => fact.fact.includes("Ronaldo"));
  Object.assign(checks, {
    "remember persisted Ronaldo": has(activeFacts(remember), "Ronaldo"),
    "main agent chose memory write": decisions(remember, "write").some(call => String(call.args.fact).includes("Ronaldo")),
    "main agent chose atomic replacement": decisions(correction, "replace").some(call => String(call.args.fact).includes("Messi")),
    "current favourite is Messi": has(activeFacts(correction), "Messi"),
    "Ronaldo excluded from active facts": !has(activeFacts(correction), "Ronaldo"),
    "correction preserves history and provenance": previousPreferences.length > 0 && previousPreferences.every(fact => fact.supersededAt && correction.facts.some(next => next.id === fact.supersededById && next.fact.includes("Messi") && next.origin === "tool" && next.turnId === correction.runId)),
    "question used a fresh DM session": recall.coldSession && recall.contextSessionId !== correction.contextSessionId,
    "fresh prompt contains only current preference": recall.promptHasMessi && !recall.promptHasRonaldo,
    "fresh visible reply answers Messi": recall.messages.some(message => /Messi/.test(message)) && recall.messages.every(message => !/Ronaldo/.test(message)),
    "main agent chose explicit forget": decisions(forget, "forget").length > 0,
    "no active preference remains after forget": !has(activeFacts(forget), "Messi") && !has(activeFacts(forget), "Ronaldo"),
    "forgotten Messi records are deleted": !has(forget.facts, "Messi"),
    "missing question used another fresh DM session": missing.coldSession && missing.contextSessionId !== forget.contextSessionId,
    "missing prompt does not retain stale preference": !missing.promptHasRonaldo && !missing.promptHasMessi,
    "missing recall searched no current facts": calls.some(call => call.runId === missing.runId && call.tool === "RecallMemory" && String(call.result).includes("(0 searched)")),
    "missing answer does not guess": missing.messages.every(message => !/Ronaldo|Messi/.test(message)) && missing.messages.some(message => /don[’']t know|haven[’']t|not saved|not recorded|no saved|not sure|don[’']t have|unsure/i.test(message)),
    "all five real extraction reviews ran": extractionOutputs.length === 5,
    "no pending review intents": await app.prisma.run.count({ where: { botId, memoryReviewPending: true } }) === 0,
    "no memory review lease remains": await app.prisma.memoryReviewLease.count({ where: { botId } }) === 0,
    "no held exchanges remain": JSON.stringify((await app.prisma.bot.findUniqueOrThrow({ where: { id: botId } })).pendingMemoryExchanges) === "[]",
  });
  report.extractions = extractionOutputs;
  report.summary = { steps: steps.length, toolCalls: calls.length, checks: Object.keys(checks).length, failures: Object.values(checks).filter(passed => !passed).length, model, reasoning };
  if (Object.values(checks).some(passed => !passed)) process.exitCode = 1;
} catch {
  // Provider errors may carry request/account metadata. Preserve only synthetic
  // journey state and the stage, never raw transport/authentication errors.
  report.failure = `Live journey failed during ${currentStep}; provider/transport details suppressed.`;
  process.exitCode = 1;
 } finally {
  clearTimeout(deadline); abort.abort();
  try {
    if (runtime) await Promise.allSettled(requests.map(request => runtime!.cancel(request.runId, "stop")));
    await worker?.stop().catch(() => { report.cleanupFailed = true; process.exitCode = 1; });
    if (app) {
      try {
        await app.agentData.stopWatching();
        if (botId) {
          await app.prisma.memoryFact.deleteMany({ where: { writtenByBotId: botId } });
          await app.prisma.idempotencyRecord.deleteMany({ where: { OR: [{ scope: `state:${botId}` }, { key: { in: clientIds } }] } });
          await app.prisma.event.deleteMany({ where: { entityId: { in: [botId, ...channelIds, ...requests.map(request => request.runId)] } } });
          await app.prisma.channel.deleteMany({ where: { id: { in: channelIds } } });
          await app.prisma.bot.deleteMany({ where: { id: botId } });
        }
      } finally { await run(app.close()); }
    }
  } catch {
    report.cleanupFailed = true;
    process.exitCode = 1;
  } finally {
    runtime?.closeIdleProviderConnections(); api?.stop(true); computer?.stop(true);
    for (const key of environmentKeys) { const previous = previousEnvironment.get(key); if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
    await rm(root, { recursive: true, force: true });
    if (resultsPath) await writeFile(resultsPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify(report.summary ?? { failure: report.failure, model, reasoning }));
  }
}
