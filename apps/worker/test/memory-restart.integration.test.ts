import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { AppService } from "../../server/src/app-service";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const databaseTest = databaseUrl ? test : test.skip;
interface TurnInput {
  runId: string;
  botId: string;
  conversationId: string;
  channelId: string;
  deliveryId: string | null;
  contextSessionId: string;
  sessionPath: string | null;
}
databaseTest(
  "an exchange whose extraction a worker crash interrupted is reviewed with the next turn",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-memory-restart-"));
    let app: AppService | undefined,
      worker: { start(): Promise<void>; stop(): Promise<void>; crash(): Promise<void> } | undefined;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    const workerPids: number[] = [];
    const extractions: string[] = [];
    let botId: string | undefined;
    const fake = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/v1/task-capabilities") return Response.json({ desktopAvailable: true, boxAvailable: true });
        if (path === "/health")
          return Response.json({
            status: "ready",
            inference: { ready: true, authenticated: true },
          });
        if (path === "/v1/agent-stores" && request.method === "GET")
          return Response.json({ agents: [] });
        if (path === "/v1/infer") {
          const body = (await request.json()) as { kind: string; prompt: string };
          if (body.kind !== "extraction") return Response.json({ text: "NONE" });
          extractions.push(body.prompt);
          // The first review never answers: the worker is killed while it waits.
          if (extractions.length === 1) return new Promise<Response>(() => {});
          return Response.json({
            text: "profile: The user lives in Lyon.\nprofile: The user starts at Acme on Monday.",
          });
        }
        if (path === "/v1/directories") {
          const body = (await request.json()) as { paths: string[] };
          for (const directory of body.paths ?? []) await mkdir(directory, { recursive: true });
          return Response.json({ directories: body.paths });
        }
        if (path.startsWith("/v1/context-sessions/") && request.method === "GET")
          return Response.json({
            type: "context.state",
            contextSessionId: path.split("/").at(-1),
            epoch: 0,
            archives: [],
          });
        if (path !== "/v1/turns") return Response.json({ ok: true, quarantined: [] });
        const input = (await request.json()) as TurnInput;
        await Effect.runPromise(
          app!.handleDynamicTool({
            runId: input.runId,
            botId: input.botId,
            conversationId: input.conversationId,
            channelId: input.channelId,
            deliveryId: input.deliveryId,
            callId: crypto.randomUUID(),
            tool: "SendToUser",
            arguments: { type: "text", content: "Noted." },
          })
        );
        const events = [
          {
            type: "session.attached",
            runtimeEngine: "pi",
            inferenceProvider: "openai-codex",
            contextSessionId: input.contextSessionId,
            sessionPath:
              input.sessionPath ?? `/var/lib/openteam/pi/${input.contextSessionId}.jsonl`,
            sessionId: input.contextSessionId,
            model: "fake",
          },
          {
            type: "context.state",
            contextSessionId: input.contextSessionId,
            epoch: 0,
            archives: [],
          },
          { type: "turn.started", turnId: input.runId },
          { type: "prompt.delivered", turnId: input.runId },
          { type: "turn.completed", turnId: input.runId, status: "completed" },
        ];
        return new Response(events.map((event) => JSON.stringify(event)).join("\n") + "\n", {
          headers: { "content-type": "application/x-ndjson" },
        });
      },
    });
    const keys = [
      "DATABASE_URL",
      "OPENTEAM_COMPUTER_URL",
      "OPENTEAM_CONTROL_TOKEN",
      "OPENTEAM_WORKSPACE_ROOT",
      "OPENTEAM_AGENT_DATA_ROOT",
      "OPENTEAM_TIME_ZONE",
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const until = async (check: () => Promise<boolean>) => {
      for (let i = 0; i < 1200; i++) {
        if (await check()) return;
        await Bun.sleep(50);
      }
      throw new Error("Memory worker fixture timed out");
    };
    try {
      Object.assign(process.env, {
        DATABASE_URL: databaseUrl,
        OPENTEAM_COMPUTER_URL: fake.url.origin,
        OPENTEAM_CONTROL_TOKEN: "synthetic-control",
        OPENTEAM_WORKSPACE_ROOT: root,
        OPENTEAM_AGENT_DATA_ROOT: join(root, "data"),
        OPENTEAM_TIME_ZONE: "Europe/Paris",
      });
      app = new AppService();
      await Effect.runPromise(app.boot());
      await app.agentData.writeInferenceSettings({ providerId: "openai-codex", modelId: "gpt-5.6-sol", reasoning: "medium" });
      worker = {
        async start() {
          const ready = join(root, "worker-ready");
          await rm(ready, { force: true });
          child = Bun.spawn(
            ["bun", join(import.meta.dir, "fixtures", "memory-restart-worker.ts")],
            {
              env: { ...process.env, MEMORY_WORKER_READY: ready },
              stdout: Bun.file(join(root, "worker-out.log")),
              stderr: Bun.file(join(root, "worker-error.log")),
            }
          );
          await until(async () => await Bun.file(ready).exists());
          workerPids.push(child.pid);
        },
        async stop() {
          if (child && child.exitCode === null) {
            child.kill("SIGTERM");
            await child.exited;
          }
        },
        async crash() {
          if (child) {
            child.kill("SIGKILL");
            await child.exited;
          }
        },
      };
      await worker.start();
      const bot = await Effect.runPromise(
        app.createBot({ clientRequestId: crypto.randomUUID(), name: "Memory worker" })
      );
      botId = bot.id;
      await until(
        async () => (await app!.prisma.bot.count({ where: { id: botId, status: "active" } })) === 1
      );
      await app.prisma.bot.update({ where: { id: botId }, data: { onboardingStatus: "completed" } });
      await Effect.runPromise(
        app.sendMessage(bot.conversationId, {
          content: "I moved to Lyon last month, so plan around that.",
          clientId: crypto.randomUUID(),
        })
      );
      await until(async () => extractions.length === 1);
      const held = await app.prisma.bot.findUniqueOrThrow({ where: { id: botId } });
      expect(held.pendingMemoryExchanges).toMatchObject([
        { user: "I moved to Lyon last month, so plan around that.", agent: "Noted." },
      ]);
      await worker.crash();
      await worker.start();
      expect(workerPids[0]).not.toBe(workerPids[1]);

      const second = (await Effect.runPromise(
        app.sendMessage(bot.conversationId, {
          content: "I also start at Acme on Monday.",
          clientId: crypto.randomUUID(),
        })
      )) as { run: { id: string } };
      await until(
        async () => (await app!.prisma.memoryFact.count({ where: { namespace: `agent:${botId}` } })) === 2
      );
      expect(extractions).toHaveLength(2);
      expect(extractions[1]).toMatch(/\nToday's date: \w+ \w+ \d+, \d{4} \(Europe\/Paris\)\n/);
      expect(extractions[1]).toContain(
        [
          "Earlier exchange (not yet reviewed):",
          "User: I moved to Lyon last month, so plan around that.",
          "Assistant: Noted.",
          "",
          "Latest exchange:",
          "User: I also start at Acme on Monday.",
          "Assistant: Noted.",
        ].join("\n")
      );
      expect(
        await app.prisma.memoryFact.findMany({
          where: { namespace: `agent:${botId}` },
          orderBy: { sourceOrdinal: "asc" },
          select: { fact: true, tier: true, origin: true, turnId: true },
        })
      ).toEqual([
        { fact: "The user lives in Lyon.", tier: "profile", origin: "extract", turnId: second.run.id },
        { fact: "The user starts at Acme on Monday.", tier: "profile", origin: "extract", turnId: second.run.id },
      ]);
      expect((await app.prisma.bot.findUniqueOrThrow({ where: { id: botId } })).pendingMemoryExchanges).toEqual([]);
    } finally {
      await worker?.stop();
      if (app) {
        if (botId) {
          await app.prisma.memoryFact.deleteMany({ where: { writtenByBotId: botId } });
          await app.prisma.channel.deleteMany({ where: { directKey: `bot:${botId}` } });
          await app.prisma.bot.deleteMany({ where: { id: botId } });
        }
        await Effect.runPromise(app.close());
      }
      fake.stop(true);
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  180_000
);
