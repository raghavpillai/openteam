/** Real Pi session → RuntimeTools → loopback HTTP → AppService → PostgreSQL.
 * Only the model's HTTP inference transport is scripted; tool arguments and
 * results pass through the production provider serializer and dynamic gateway.
 */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { DynamicToolCallRequest, type ComputerEvent } from "@openteam/contracts";
import { ComputerRuntime } from "../src/runtime";
import { AppService } from "../../server/src/app-service";
import { errorResponse, parseBody } from "../../server/src/http";

const databaseUrl = process.env.OPENTEAM_RUNTIME_TEST_DATABASE_URL ?? process.env.OPENTEAM_TEST_DATABASE_URL;
const dbTest = databaseUrl ? test : test.skip;
const oldFact = "My favourite football player is Ronaldo.";
const newFact = "My favourite player is now Messi.";

for (const type of ["profile", "journal", "shared_profile", "shared_journal"] as const) {
  dbTest(`real computer/Pi memory tools serialize write, correction and history for ${type}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-runtime-"));
    const token = "memory-runtime-test-control";
    const env: Record<string, string> = {
      DATABASE_URL: databaseUrl!,
      OPENTEAM_WORKSPACE_ROOT: root,
      OPENTEAM_AGENT_DATA_ROOT: join(root, "data"),
      OPENTEAM_PI_AGENT_DIR: join(root, "pi"),
      OPENTEAM_CONTROL_TOKEN: token,
    };
    const previous = new Map<string, string | undefined>();
    const setEnv = (key: string, value: string) => {
      if (!previous.has(key)) previous.set(key, process.env[key]);
      process.env[key] = value;
    };
    for (const [key, value] of Object.entries(env)) setEnv(key, value);
    const app = new AppService("disabled");
    const botId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    const contextSessionId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const httpCalls: any[] = [];
    // The production main.ts route consists of this authentication/parse/dispatch
    // boundary. Use a real listening socket, not an injected fetch or tool stub.
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${token}`)
        return Response.json({ error: { code: "unauthorized", message: "Unauthorized" } }, { status: 401 });
      const path = new URL(request.url).pathname;
      try {
        if (path === "/api/v0/internal/machines" && request.method === "GET")
          return Response.json(await app.machines.list());
        if (path !== "/api/v0/internal/tools/call" || request.method !== "POST")
          return new Response("Not found", { status: 404 });
        const input = await parseBody(request, DynamicToolCallRequest);
        httpCalls.push(input);
        return Response.json(await Effect.runPromise(app.handleDynamicTool(input), { signal: request.signal }));
      } catch (error) { return errorResponse(error); }
    } });
    setEnv("OPENTEAM_SERVER_URL", `http://127.0.0.1:${server.port}`);
    let runtime: any;
    try {
      await app.prisma.bot.create({ data: {
        id: botId, name: "Runtime memory fixture", status: "active", onboardingStatus: "completed",
        defaultDirectory: root, conversation: { create: { id: conversationId } },
      } });
      await app.agentData.initializeBot(botId);
      await app.prisma.channel.create({ data: {
        id: channelId, kind: "bot_dm", name: "Runtime memory fixture", directKey: `bot:${botId}`,
        members: { create: { botId, ordinal: 0 } },
      } });
      await app.prisma.run.create({ data: {
        id: runId, botId, conversationId, channelId, userMessageId: crypto.randomUUID(), status: "running",
      } });
      const requests: any[] = [];
      const model: any = {
        id: "openai/memory-runtime-fixture", name: "Memory runtime fixture", provider: "openrouter",
        api: "openai-completions", baseUrl: "https://offline.invalid/v1", reasoning: false,
        input: ["text"], contextWindow: 100000, maxTokens: 1000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      const provider = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
      });
      provider.checkAuth = async () => ({ type: "api_key" });
      let recalledId = "";
      const callIds = new Map<string, string>();
      const callId = (label: string) => {
        if (!callIds.has(label)) callIds.set(label, crypto.randomUUID());
        return callIds.get(label)!;
      };
      const resultFor = (request: any, id: string): string => {
        const result = request.messages.findLast((message: any) => message.role === "tool" && message.tool_call_id === callId(id));
        expect(result).toBeDefined();
        return typeof result.content === "string" ? result.content : JSON.stringify(result.content);
      };
      provider.streamSimple = (_model, context, options) => streamSimple(model, context, {
        ...options, apiKey: "synthetic", maxRetries: 0,
        fetch: (async (_url: unknown, init: RequestInit) => {
          const request = JSON.parse(await new Response(init.body).text());
          requests.push(request);
          const step = requests.length - 1;
          let call: { id: string; name: string; args: unknown } | undefined;
          const dynamic = (id: string, args: unknown) => ({ id, name: "CallDynamicTool", args: {
            namespace: "cursor", toolName: "UpdateMemory", arguments: args,
          } });
          if (step === 0) {
            const recall = request.tools.find((tool: any) => tool.function.name === "RecallMemory").function;
            expect(recall.parameters.properties.includeHistory.type).toBe("boolean");
            expect(recall.description).toContain("superseded");
            const update = request.tools.find((tool: any) => tool.function.name === "UpdateMemory").function;
            expect(update.parameters.properties.action.enum).toContain("replace");
            expect(update.parameters.properties.id.type).toBe("string");
            expect(update.description).toContain("RecallMemory");
            call = { id: "discover", name: "GetDynamicTools", args: { namespace: "cursor", toolName: "UpdateMemory" } };
          } else if (step === 1) {
            const discovery = resultFor(request, "discover");
            expect(discovery).toContain("already available directly");
            call = dynamic("write", { action: "write", type, fact: oldFact });
          } else if (step === 2) {
            expect(resultFor(request, "write")).toContain("Remembered");
            call = { id: "recallold", name: "RecallMemory", args: { query: "favourite football player" } };
          } else if (step === 3) {
            const recalled = resultFor(request, "recallold");
            expect(recalled).toContain("Ronaldo");
            recalledId = recalled.match(/id: ([0-9a-f-]{36}); active/)?.[1] ?? "";
            expect(recalledId).toHaveLength(36);
            call = { id: "replace", name: "UpdateMemory", args: { action: "replace", type, id: recalledId, fact: newFact } };
          } else if (step === 4) {
            expect(resultFor(request, "replace")).toContain("Corrected");
            call = { id: "recallactive", name: "RecallMemory", args: { query: "favourite football player", limit: 1 } };
          } else if (step === 5) {
            const active = resultFor(request, "recallactive");
            expect(active).toContain("Messi");
            expect(active).not.toContain("Ronaldo");
            call = { id: "recallhistory", name: "RecallMemory", args: { query: "favourite player", includeHistory: true } };
          } else {
            expect(step).toBe(6);
            const history = resultFor(request, "recallhistory");
            expect(history).toContain("Ronaldo");
            expect(history).toContain("Messi");
            expect(history).toContain(`id: ${recalledId}; superseded`);
          }
          const delta = call ? {
            role: "assistant", tool_calls: [{ index: 0, id: callId(call.id), type: "function", function: {
              name: call.name, arguments: JSON.stringify(call.args),
            } }],
          } : { role: "assistant", content: "Memory correction verified." };
          const chunk = { id: `reply-${step}`, object: "chat.completion.chunk", created: 1, model: model.id,
            choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
          };
          return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          });
        }) as typeof fetch,
      });
      runtime = new ComputerRuntime() as any;
      // Boot normally provisions machine/provider infrastructure. The session,
      // runtime tools, compaction hooks, dynamic lookup and serializers stay real.
      runtime.start = async () => {};
      runtime.modelRuntime = provider;
      runtime.resolveModel = () => model;
      const events: AsyncIterable<ComputerEvent> = await runtime.run({
        runId, botId, contextSessionId, conversationId, channelId, deliveryId: null,
        clientMessageId: crypto.randomUUID(), sessionPath: null, cwd: root,
        model: `${model.provider}/${model.id}`, reasoning: "off", runtimeProfile: "agent", requestSource: "agent",
        content: "Remember Ronaldo, then correct that memory to Messi and inspect current facts and history.",
        instructions: "Use the memory tools to complete this task.",
      });
      let sessionPath: string | undefined;
      let completed = false;
      for await (const event of events) {
        if (event.type === "session.attached") sessionPath = event.sessionPath;
        if (event.type === "turn.completed") {
          expect(event.status).toBe("completed");
          completed = true;
        }
      }
      expect(completed).toBe(true);
      expect(requests).toHaveLength(7);
      const calls = httpCalls.filter(call => ["UpdateMemory", "RecallMemory"].includes(call.tool));
      expect(calls.map(call => call.tool)).toEqual(["UpdateMemory", "RecallMemory", "UpdateMemory", "RecallMemory", "RecallMemory"]);
      expect(calls[2].arguments).toEqual({ action: "replace", type, id: recalledId, fact: newFact });
      expect(calls[4].arguments.includeHistory).toBe(true);
      const facts = await app.prisma.memoryFact.findMany({ where: { writtenByBotId: botId } });
      expect(facts).toHaveLength(2);
      const current = facts.find(fact => !fact.supersededAt)!;
      expect(current.fact).toBe(newFact);
      expect(current.scope).toBe(type.startsWith("shared_") ? "user" : "agent");
      expect(current.tier).toBe(type.endsWith("profile") ? "profile" : "log");
      expect(facts.find(fact => fact.id === recalledId)!.supersededById).toBe(current.id);
      const persisted = SessionManager.open(sessionPath!, join(root, "pi", "sessions", "openteam"), root).buildSessionContext().messages;
      const persistedResults = persisted.filter((message: any) => message.role === "toolResult");
      expect(persistedResults).toHaveLength(6);
      expect(JSON.stringify(persistedResults)).toContain("superseded");
      expect(persistedResults.filter((message: any) => message.isError).map((message: any) => message.toolName)).toEqual(["GetDynamicTools"]);
    } finally {
      runtime?.closeIdleProviderConnections();
      server.stop(true);
      await app.agentData.stopWatching();
      await app.eventWakeup.stop();
      await app.prisma.idempotencyRecord.deleteMany({ where: { scope: `state:${botId}` } });
      await app.prisma.memoryFact.deleteMany({ where: { writtenByBotId: botId } });
      await app.prisma.event.deleteMany({ where: { entityId: botId } });
      await app.prisma.channel.deleteMany({ where: { id: channelId } });
      await app.prisma.bot.deleteMany({ where: { id: botId } });
      await app.prisma.$disconnect();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
}
