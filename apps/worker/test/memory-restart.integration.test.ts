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
  content: string;
  instructions: string;
}
databaseTest(
  "a real worker process preserves bot-wide memory and episode buffers across a crash",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-memory-routing-"));
    let app: AppService | undefined,
      worker: { start(): Promise<void>; stop(): Promise<void>; crash(): Promise<void> } | undefined;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    const workerPids: number[] = [];
    const seen: Array<{ input: TurnInput; recall: unknown; saved: unknown }> = [];
    const botIds: string[] = [];
    let groupId: string | undefined;
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
          return Response.json({
            text:
              body.kind === "extraction" && body.prompt.includes("ORBIT-913")
                ? "log: ORBIT-913 background decision uses amber."
                : "NONE",
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
        const call = (tool: string, args: unknown) =>
          Effect.runPromise(
            app!.handleDynamicTool({
              runId: input.runId,
              botId: input.botId,
              conversationId: input.conversationId,
              channelId: input.channelId,
              deliveryId: input.deliveryId,
              callId: crypto.randomUUID(),
              tool,
              arguments: args,
            })
          );
        const roundIndex = input.deliveryId
          ? (
              await app!.prisma.channelDelivery.findUniqueOrThrow({
                where: { id: input.deliveryId },
                include: { round: true },
              })
            ).round.roundIndex
          : 0;
        if (input.channelId === groupId && roundIndex === 0) {
          const saved = await call("update_state", {
            target: "memory",
            action: "write",
            tier: "profile",
            fact: "ORBIT-913 explicit decision uses amber.",
          });
          const recall = await call("RecallMemory", { query: "ORBIT-913" });
          seen.push({ input, saved, recall });
        }
        if (input.channelId !== groupId || roundIndex === 0)
          await call("SendToUser", {
            type: "text",
            content: "Synthetic memory fixture completed.",
          });
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
      "OPENTEAM_MEMORY_DREAMING",
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
        OPENTEAM_MEMORY_DREAMING: "false",
      });
      app = new AppService();
      await Effect.runPromise(app.boot());
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
      for (const name of ["Memory worker", "Memory peer"]) {
        const bot = await Effect.runPromise(
          app.createBot({ clientRequestId: crypto.randomUUID(), name })
        );
        botIds.push(bot.id);
      }
      await until(
        async () =>
          (await app!.prisma.bot.count({ where: { id: { in: botIds }, status: "active" } })) === 2
      );
      const group = await Effect.runPromise(
        app.createGroup({ name: "Synthetic memory room", botIds })
      );
      groupId = group.id;
      await Effect.runPromise(
        app.sendChannelMessage(groupId, {
          content: "For this ORBIT-913 room, we decided to use amber in the launch.",
          clientId: crypto.randomUUID(),
        })
      );
      await until(
        async () =>
          seen.length === 2 &&
          (await app!.prisma.memoryFact.count({
            where: {
              writtenByBotId: { in: botIds },
              scope: "agent",
              fact: { contains: "background decision" },
            },
          })) === 2
      );
      for (const { input, recall, saved } of seen) {
        const run = await app.prisma.run.findUniqueOrThrow({
          where: { id: input.runId },
          include: { memoryConversation: true },
        });
        expect(run.memoryConversation?.address).toBe(groupId);
        expect(run.memoryConversation?.defaultScope).toBe("agent");
        expect(input.instructions).toContain(
          'scope "user" is the owner\'s memory across their agents and cannot be written'
        );
        expect(saved).toBe("Remembered in your memory (profile): ORBIT-913 explicit decision uses amber.");
        expect(recall).toContain("[profile]");
        expect(input.instructions).not.toContain('scope "conversation"');
      }
      await until(
        async () =>
          (await app!.prisma.run.count({
            where: { botId: { in: botIds }, status: { in: ["queued", "running"] } },
          })) === 0
      );
      await until(
        async () =>
          (await app!.prisma.channelRound.count({
            where: { channelId: groupId, status: { in: ["queued", "running"] } },
          })) === 0
      );
      const beforeRestart = await app.prisma.bot.findMany({
        where: { id: { in: botIds } },
        select: { id: true, episodeTurns: true },
      });
      await worker.crash();
      await worker.start();
      expect(workerPids[0]).not.toBe(workerPids[1]);
      await Effect.runPromise(
        app.sendChannelMessage(groupId, {
          content: "For this ORBIT-913 room, continue the amber launch after the worker restart.",
          clientId: crypto.randomUUID(),
        })
      );
      await until(
        async () =>
          seen.length >= 4 &&
          (
            await app!.prisma.bot.findMany({ where: { id: { in: botIds } } })
          ).filter((c) => Array.isArray(c.episodeTurns) && c.episodeTurns.length >= 2).length === 2
      );
      const afterRestart = await app.prisma.bot.findMany({
        where: { id: { in: botIds } },
        select: { id: true, episodeTurns: true },
      });
      for (const original of seen.slice(0, 2)) {
        const next = seen.slice(2).find((x) => x.input.botId === original.input.botId)!;
        expect(next.input.contextSessionId).toBe(original.input.contextSessionId);
        expect(next.recall).toContain("ORBIT-913 background decision uses amber.");
      }
      expect(
        beforeRestart.filter((c) => Array.isArray(c.episodeTurns) && c.episodeTurns.length === 1)
      ).toHaveLength(2);
      expect(
        afterRestart.filter((c) => Array.isArray(c.episodeTurns) && c.episodeTurns.length >= 2)
      ).toHaveLength(2);
      expect(
        await app.prisma.memoryFact.count({
          where: {
            writtenByBotId: { in: botIds },
            scope: "agent",
            fact: { contains: "ORBIT-913" },
          },
        })
      ).toBe(4);
    } finally {
      await worker?.stop();
      if (app) {
        await app.prisma.memoryFact.deleteMany({ where: { writtenByBotId: { in: botIds } } });
        if (groupId) await app.prisma.channel.deleteMany({ where: { id: groupId } });
        await app.prisma.bot.deleteMany({ where: { id: { in: botIds } } });
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
