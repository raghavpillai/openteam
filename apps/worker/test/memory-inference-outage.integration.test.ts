/** Real worker, queue, persistence and tool service; only the computer/model HTTP peer is controlled. */
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { AppService } from "../../server/src/app-service";
import { WakeWorker } from "../src/worker";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const databaseTest = databaseUrl ? test : test.skip;
for (const fault of ["unavailable", "malformed-json"] as const) databaseTest(
  `a real ${fault} inference outage retains review intent and cannot replay an older turn over a newer correction`,
  async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-inference-outage-"));
    let app: AppService | undefined, worker: WakeWorker | undefined, botId: string | undefined;
    let failures = 0, recovered = false, staleCalls = 0, healthyCalls = 0;
    const source = "My favourite football player is Ronaldo.";
    const current = "My favourite football player is Messi.";
    const oldUser = "Remember my favourite football player is Ronaldo.";
    const newUser = "My favourite football player is now Messi. Correct my memory.";
    const events: string[] = [];
    const computer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/health") return Response.json({ status: "ready", inference: { ready: true, authenticated: true } });
      if (path === "/v1/task-capabilities") return Response.json({ desktopAvailable: true, boxAvailable: true });
      if (path === "/v1/agent-stores" && request.method === "GET") return Response.json({ agents: [] });
      if (path === "/v1/directories") {
        const body = await request.json() as { paths?: string[] };
        for (const directory of body.paths ?? []) await mkdir(directory, { recursive: true });
        return Response.json({ directories: body.paths });
      }
      if (path.startsWith("/v1/context-sessions/") && request.method === "GET") return Response.json({ type: "context.state", contextSessionId: path.split("/").at(-1), epoch: 0, archives: [] });
      if (path === "/v1/infer") {
        const input = await request.json() as { kind: string; prompt: string };
        if (input.kind !== "extraction") return Response.json({ text: "NONE" });
        if (!recovered) {
          failures++;
          return fault === "unavailable"
            ? Response.json({ error: "Injected model outage" }, { status: 503 })
            : new Response("{invalid JSON", { headers: { "content-type": "application/json" } });
        }
        healthyCalls++;
        if (input.prompt.includes(oldUser)) {
          staleCalls++;
          return Response.json({ text: `replace: ${JSON.stringify({ old: current, fact: source })}` });
        }
        return Response.json({ text: "NONE" });
      }
      if (path !== "/v1/turns") return Response.json({ ok: true, quarantined: [] });
      const input = await request.json() as { runId: string; botId: string; conversationId: string; channelId: string; deliveryId: string | null; content: string };
      const call = (tool: string, args: unknown) => Effect.runPromise(app!.handleDynamicTool({
        runId: input.runId, botId: input.botId, conversationId: input.conversationId,
        channelId: input.channelId, deliveryId: input.deliveryId, callId: crypto.randomUUID(), tool, arguments: args,
      }));
      if (input.content.includes(oldUser)) {
        await call("UpdateMemory", { action: "write", type: "profile", fact: source });
        await call("SendToUser", { type: "text", content: "Remembered Ronaldo." });
        events.push("remembered");
      } else if (input.content.includes(newUser)) {
        const recall = await call("RecallMemory", { query: "favourite football player" }) as string;
        const id = recall.match(/\[id: ([0-9a-f-]+)[;\]]/i)?.[1];
        expect(id).toBeDefined();
        await call("UpdateMemory", { action: "replace", type: "profile", id, fact: current });
        await call("SendToUser", { type: "text", content: "Corrected to Messi." });
        events.push("corrected");
        recovered = true;
      }
      return new Response([
        { type: "turn.started", turnId: input.runId }, { type: "prompt.delivered", turnId: input.runId },
        { type: "turn.completed", turnId: input.runId, status: "completed" },
      ].map(event => JSON.stringify(event)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });
    } });
    const keys = ["DATABASE_URL", "OPENTEAM_COMPUTER_URL", "OPENTEAM_CONTROL_TOKEN", "OPENTEAM_WORKSPACE_ROOT", "OPENTEAM_AGENT_DATA_ROOT"] as const;
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const until = async (check: () => Promise<boolean>) => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(50); }
      throw new Error("Memory outage journey timed out");
    };
    try {
      Object.assign(process.env, { DATABASE_URL: databaseUrl, OPENTEAM_COMPUTER_URL: computer.url.origin,
        OPENTEAM_CONTROL_TOKEN: "isolated-memory-outage", OPENTEAM_WORKSPACE_ROOT: root, OPENTEAM_AGENT_DATA_ROOT: join(root, "data") });
      app = new AppService();
      await Effect.runPromise(app.boot());
      await app.agentData.writeInferenceSettings({ providerId: "openai-codex", modelId: "synthetic-outage-fixture", reasoning: "low" });
      worker = new WakeWorker();
      await worker.start();
      const bot = await Effect.runPromise(app.createBot({ clientRequestId: crypto.randomUUID(), name: "Outage journey" }));
      botId = bot.id;
      await until(async () => Boolean(await app!.prisma.bot.count({ where: { id: bot.id, status: "active", onboardingStatus: "completed" } })));
      await Effect.runPromise(app.sendMessage(bot.conversationId, { content: oldUser, clientId: crypto.randomUUID() }));
      await until(async () => failures >= 3 && (await app!.prisma.memoryReviewLease.count({ where: { botId } })) === 0);
      const pending = await app.prisma.run.findFirstOrThrow({ where: { botId, memoryReviewPending: true } });
      expect(pending.status).toBe("completed");
      expect((await app.prisma.bot.findUniqueOrThrow({ where: { id: botId } })).pendingMemoryExchanges).toEqual([expect.objectContaining({ id: pending.id, user: oldUser })]);
      expect(await app.prisma.memoryFact.findMany({ where: { writtenByBotId: botId, supersededAt: null }, select: { fact: true } })).toEqual([{ fact: source }]);
      await Effect.runPromise(app.sendMessage(bot.conversationId, { content: newUser, clientId: crypto.randomUUID() }));
      await until(async () => recovered && healthyCalls > 0 && (await app!.prisma.run.count({ where: { botId, memoryReviewPending: true } })) === 0);
      expect(staleCalls).toBe(0);
      expect(events).toEqual(["remembered", "corrected"]);
      const facts = await app.prisma.memoryFact.findMany({ where: { writtenByBotId: botId } });
      expect(facts).toHaveLength(2);
      const active = facts.find(fact => fact.supersededAt === null)!;
      expect(active.fact).toBe(current);
      expect(facts.find(fact => fact.fact === source)!.supersededById).toBe(active.id);
      expect((await app.prisma.bot.findUniqueOrThrow({ where: { id: botId } })).pendingMemoryExchanges).toEqual([]);
      expect(await app.prisma.botRunLease.count({ where: { botId } })).toBe(0);
    } finally {
      await worker?.stop();
      if (app) {
        // Stop background importers before deleting their owners.
        await Effect.runPromise(app.close());
        const { createPrismaClient } = await import("@openteam/db");
        const cleanup = createPrismaClient(databaseUrl!);
        await cleanup.memoryFact.deleteMany({ where: { writtenByBotId: botId ?? "00000000-0000-4000-8000-000000000000" } });
        if (botId) await cleanup.bot.deleteMany({ where: { id: botId } });
        await cleanup.$disconnect();
      }
      computer.stop(true);
      for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000
);
