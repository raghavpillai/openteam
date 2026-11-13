// A real AppService and WakeWorker on the test database, against a scripted fake computer.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { ComputerTurnRequest } from "@openteam/contracts";
import { AppService } from "../../../server/src/app-service";
import { WakeWorker } from "../../src/worker";

export const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
export type Turn = ComputerTurnRequest;
export type Call = (tool: string, args: unknown, callId?: string) => Promise<unknown>;
/** Events emitted after prompt delivery, and whether the turn reports completion. */
export type TurnScript = { events?: unknown[]; complete?: boolean } | Response | void;

const ENV = ["DATABASE_URL", "OPENTEAM_COMPUTER_URL", "OPENTEAM_CONTROL_TOKEN", "OPENTEAM_WORKSPACE_ROOT", "OPENTEAM_AGENT_DATA_ROOT"] as const;
const ndjson = (events: unknown[]) =>
  new Response(events.map((event) => JSON.stringify(event)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });

/** Match the real computer's NDJSON contract: accepting a turn exposes response headers
 * before model/tool work finishes. Otherwise a tool callback waits on the worker's
 * dispatch transaction while that transaction waits for the fixture to return its headers. */
function streamed(response: Promise<Response>): Response {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("\n")); // a protocol keepalive
      void (async () => {
        const settled = await response;
        if (!settled.ok || !settled.body) throw new Error(`Computer fixture rejected turn: ${settled.status}`);
        if (cancelled) return void (await settled.body.cancel());
        reader = settled.body.getReader();
        try {
          for (let chunk = await reader.read(); !chunk.done && !cancelled; chunk = await reader.read()) controller.enqueue(chunk.value);
          if (!cancelled) controller.close();
        } finally { reader.releaseLock(); }
      })().catch((error) => { if (!cancelled) controller.error(error); });
    },
    async cancel() { cancelled = true; await reader?.cancel(); },
  });
  return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
}

export async function startStack(options: {
  turn?: (input: Turn, call: Call) => Promise<TurnScript>;
  infer?: (body: { kind: string; prompt: string }) => string;
  streaming?: boolean;
  truncate?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "worker-stack-"));
  const previous = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
  const turns: Turn[] = [];
  const contextReads: string[] = [];
  const errors: unknown[] = [];
  const stack = {
    root, turns, contextReads, errors,
    app: undefined as unknown as AppService,
    worker: undefined as WakeWorker | undefined,
    call: (input: Turn, tool: string, args: unknown, callId: string = crypto.randomUUID()) =>
      Effect.runPromise(stack.app.handleDynamicTool({
        runId: input.runId, botId: input.botId, conversationId: input.conversationId, channelId: input.channelId,
        deliveryId: input.deliveryId, callId, tool, arguments: args,
      } as never)),
    async until(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 60_000) {
      for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await Bun.sleep(50)) {
        if (errors.length) throw errors[0];
        if (await check()) return;
      }
      throw new Error(`Timed out waiting for ${label}`);
    },
    async startWorker() { stack.worker = new WakeWorker(); await stack.worker.start(); },
    async stopWorker() { await stack.worker?.stop(); stack.worker = undefined; },
    async boot(before?: (app: AppService) => Promise<void>) {
      stack.app = new AppService();
      await before?.(stack.app);
      await Effect.runPromise(stack.app.boot());
      await stack.app.agentData.writeInferenceSettings({ providerId: "openai-codex", modelId: "fake", reasoning: "medium" });
      await stack.startWorker();
    },
    async shutdown() {
      await stack.stopWorker();
      await stack.app.agentData.stopWatching();
      await Effect.runPromise(stack.app.close());
    },
    async close() {
      try {
        if (stack.app) {
          await stack.stopWorker();
          const db = stack.app.prisma;
          const bots = (await db.bot.findMany({ where: { defaultDirectory: { startsWith: root } }, select: { id: true } })).map((bot) => bot.id);
          await db.memoryFact.deleteMany({ where: { writtenByBotId: { in: bots } } });
          await db.bot.deleteMany({ where: { id: { in: bots } } });
          await db.channel.deleteMany({ where: { kind: "group", workingDirectory: { startsWith: root } } });
          await db.userTimeZoneSettings.deleteMany({ where: { id: "global" } });
          if (zone) await db.userTimeZoneSettings.create({ data: zone as never });
          await stack.shutdown();
        }
      } finally {
        computer.stop(true);
        for (const key of ENV) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
        await rm(root, { recursive: true, force: true });
      }
    },
  };
  const runTurn = async (input: Turn) => {
    let script: TurnScript;
    try { script = await options.turn?.(input, (tool, args, callId) => stack.call(input, tool, args, callId)); }
    catch (error) { errors.push(error); return Response.json({ error: String(error) }, { status: 500 }); }
    if (script instanceof Response) return script;
    return ndjson([
      { type: "session.attached", runtimeEngine: "pi", inferenceProvider: "openai-codex", contextSessionId: input.contextSessionId,
        sessionPath: input.sessionPath ?? `/var/lib/openteam/pi/${input.contextSessionId}.jsonl`, sessionId: input.contextSessionId, model: "fake" },
      { type: "context.state", contextSessionId: input.contextSessionId, epoch: 0, archives: [] },
      { type: "turn.started", turnId: input.runId },
      { type: "prompt.delivered", turnId: input.runId },
      ...(script?.events ?? []),
      ...(script?.complete === false ? [] : [{ type: "turn.completed", turnId: input.runId, status: "completed" }]),
    ]);
  };
  const computer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/health") return Response.json({ status: "ready", inference: { ready: true, authenticated: true } });
      if (path === "/v1/task-capabilities") return Response.json({ desktopAvailable: true, boxAvailable: true });
      if (path === "/v1/agent-stores" && request.method === "GET") return Response.json({ agents: [] });
      if (path === "/v1/infer") return Response.json({ text: options.infer?.(await request.json() as never) ?? "NONE" });
      if (path === "/v1/directories") {
        const body = (await request.json()) as { paths: string[] };
        for (const directory of body.paths ?? []) await mkdir(directory, { recursive: true });
        return Response.json({ directories: body.paths });
      }
      if (path.startsWith("/v1/workspaces/") && request.method === "PUT") {
        const body = (await request.json()) as { path: string };
        await mkdir(body.path, { recursive: true });
        return Response.json({ path: body.path });
      }
      const context = path.match(/^\/v1\/context-sessions\/([^/]+)$/)?.[1];
      if (context && request.method === "GET") {
        contextReads.push(context);
        return Response.json({ type: "context.state", contextSessionId: context, epoch: 0, archives: [] });
      }
      if (/\/background-shells\/stop$/.test(path)) return Response.json({ stopped: 0 });
      if (path !== "/v1/turns") return Response.json({ ok: true, quarantined: [] });
      const input = (await request.json()) as Turn;
      turns.push(input);
      return options.streaming ? streamed(runTurn(input)) : runTurn(input);
    },
  });
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl, OPENTEAM_COMPUTER_URL: computer.url.origin, OPENTEAM_CONTROL_TOKEN: "stack-control",
    OPENTEAM_WORKSPACE_ROOT: root, OPENTEAM_AGENT_DATA_ROOT: join(root, "data"),
  });
  let zone: unknown = null;
  try {
    await stack.boot(async (app) => {
      zone = await app.prisma.userTimeZoneSettings.findUnique({ where: { id: "global" } });
      if (options.truncate) await app.prisma.$executeRawUnsafe('TRUNCATE TABLE "Computer", "Bot", "OutboxDelivery", "Event", "IdempotencyRecord" CASCADE');
    });
  } catch (error) {
    await stack.close();
    throw error;
  }
  return stack;
}
export type Stack = Awaited<ReturnType<typeof startStack>>;
