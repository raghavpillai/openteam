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
for (const crashAt of ["before-memory", "inference", "inference-natural-expiry", "before-publication", "before-ack"] as const) databaseTest(
  `a worker killed at ${crashAt} recovers the settled exchange without another turn`,
  async () => {
    const inferenceCrash = crashAt === "inference" || crashAt === "inference-natural-expiry";
    const expectedExtractions = inferenceCrash ? 2 : 1;
    const root = await mkdtemp(join(tmpdir(), "worker-memory-restart-"));
    let app: AppService | undefined,
      worker: { start(): Promise<void>; stop(): Promise<void>; crash(): Promise<void> } | undefined;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    const workerPids: number[] = [];
    const extractions: string[] = [];
    let botId: string | undefined;
    let groupId: string | undefined;
    let starts = 0;
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
          if (inferenceCrash && extractions.length === 1) return new Promise<Response>(() => {});
          return Response.json({
            text: "profile: The user lives in Lyon.",
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
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const until = async (check: () => Promise<boolean>) => {
      for (let i = 0; i < 1200; i++) {
        if (await check()) return;
        await Bun.sleep(50);
      }
      throw new Error(`Memory worker fixture timed out:\n${await Bun.file(join(root, "worker-error.log")).text().catch(() => "")}`);
    };
    try {
      Object.assign(process.env, {
        DATABASE_URL: databaseUrl,
        OPENTEAM_COMPUTER_URL: fake.url.origin,
        OPENTEAM_CONTROL_TOKEN: "synthetic-control",
        OPENTEAM_WORKSPACE_ROOT: root,
        OPENTEAM_AGENT_DATA_ROOT: join(root, "data"),
      });
      app = new AppService();
      await Effect.runPromise(app.boot());
      await app.updateUserTimeZone({ detectedTimeZone: "Europe/Paris" });
      await app.agentData.writeInferenceSettings({ providerId: "openai-codex", modelId: "gpt-5.6-sol", reasoning: "medium" });
      worker = {
        async start() {
          const ready = join(root, "worker-ready");
          await rm(ready, { force: true });
          child = Bun.spawn(
            ["bun", join(import.meta.dir, "fixtures", "memory-restart-worker.ts")],
            {
              env: {
                ...process.env,
                MEMORY_WORKER_READY: ready,
                MEMORY_WORKER_PAUSED: join(root, "worker-paused"),
                ...(starts++ === 0 && !inferenceCrash ? { MEMORY_WORKER_PAUSE_AT: crashAt } : {}),
              },
              stdout: Bun.file(join(root, "worker-out.log")),
              stderr: Bun.file(join(root, "worker-error.log")),
            }
          );
          await until(async () => {
            if (child!.exitCode !== null) throw new Error(`Memory worker exited: ${await Bun.file(join(root, "worker-error.log")).text()}`);
            return Bun.file(ready).exists();
          });
          workerPids.push(child.pid);
        },
        async stop() {
          if (child && child.exitCode === null) {
            child.kill("SIGTERM");
            await Promise.race([child.exited, Bun.sleep(5_000)]);
            if (child.exitCode === null) child.kill("SIGKILL");
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
      const content = "I moved to Lyon last month, so plan around that.";
      if (crashAt === "before-publication") {
        const group = await Effect.runPromise(app.createGroup({ name: "Memory recovery", botIds: [bot.id] }));
        groupId = group.id;
        await Effect.runPromise(app.sendChannelMessage(group.id, { content, clientId: crypto.randomUUID() }));
      } else {
        await Effect.runPromise(app.sendMessage(bot.conversationId, { content, clientId: crypto.randomUUID() }));
      }
      if (inferenceCrash) await until(async () => extractions.length === 1);
      else await until(async () => Bun.file(join(root, "worker-paused")).exists());
      const pending = await app.prisma.run.findFirstOrThrow({
        where: { botId, memoryReviewPending: true },
        include: { inboxEvents: true, delivery: true },
      });
      expect(pending.status).toBe("completed");
      expect(pending.inboxEvents[0]?.status).toBe("completed");
      expect(await app.prisma.botRunLease.count({ where: { runId: pending.id } })).toBe(0);
      if (crashAt === "before-publication") {
        expect(pending.delivery?.status).toBe("processing");
        expect(await app.prisma.channelMessage.count({ where: { sourceRunId: pending.id } })).toBe(0);
      }
      const held = (await app.prisma.bot.findUniqueOrThrow({ where: { id: botId } })).pendingMemoryExchanges;
      if (inferenceCrash || crashAt === "before-ack") expect(held).toMatchObject([{ user: content, agent: "Noted." }]);
      else expect(held).toEqual([]);
      const committed = crashAt === "before-ack"
        ? await app.prisma.memoryFact.findFirstOrThrow({ where: { namespace: `agent:${botId}`, supersededAt: null } })
        : null;
      if (committed) {
        expect(committed).toMatchObject({ fact: "The user lives in Lyon.", origin: "extract", turnId: pending.id });
        expect(pending.memoryReviewRevision).toBeNumber();
      }
      await worker.crash();
      if (crashAt === "inference" || crashAt === "before-ack") {
        // Expire only the dead owner's lease; recovery need not wait for the TTL.
        expect((await app.prisma.memoryReviewLease.updateMany({ where: { botId }, data: { expiresAt: new Date(0) } })).count).toBe(1);
      }
      if (committed) await app.agentData.replaceMemory(bot.id, {
        scope: "agent", tier: "profile", id: committed.id, fact: "The user lives in Paris.",
      }, { source: "tool", turnId: "post-crash-correction" });
      let naturalLease: { ownerId: string; expiresAt: Date; remainingMs: number } | undefined;
      if (crashAt === "inference-natural-expiry") {
        [naturalLease] = await app.prisma.$queryRaw<Array<NonNullable<typeof naturalLease>>>`
          SELECT "ownerId", "expiresAt",
            (EXTRACT(EPOCH FROM ("expiresAt" - clock_timestamp())) * 1000)::float8 AS "remainingMs"
          FROM "MemoryReviewLease" WHERE "botId" = ${bot.id}::uuid`;
        expect(naturalLease).toBeDefined();
        expect(naturalLease!.remainingMs).toBeGreaterThan(10_000);
      }
      const recoveryStartedAt = Date.now();
      await worker.start();
      expect(workerPids[0]).not.toBe(workerPids[1]);
      if (naturalLease) {
        // The replacement must respect the dead owner's still-live lease. No test
        // updates it: startup and the safety timer must wait for PostgreSQL expiry.
        await Bun.sleep(5_000);
        expect(extractions).toHaveLength(1);
        expect(await app.prisma.memoryReviewLease.findUniqueOrThrow({ where: { botId: bot.id } }))
          .toMatchObject({ ownerId: naturalLease.ownerId, expiresAt: naturalLease.expiresAt });
        expect((await app.prisma.run.findUniqueOrThrow({ where: { id: pending.id } })).memoryReviewPending).toBe(true);
      }
      await until(async () =>
        (await app!.prisma.memoryFact.count({ where: { namespace: `agent:${botId}`, supersededAt: null } })) === 1 &&
        (await app!.prisma.run.count({ where: { id: pending.id, memoryReviewPending: false } })) === 1
      );
      if (naturalLease) {
        expect(Date.now() - recoveryStartedAt).toBeGreaterThanOrEqual(naturalLease.remainingMs - 1_000);
        expect(await app.prisma.memoryFact.count({ where: { namespace: `agent:${botId}` } })).toBe(1);
      }
      expect(extractions).toHaveLength(expectedExtractions);
      const recovered = extractions.at(-1)!;
      expect(recovered).toMatch(/\nToday's date: \w+ \w+ \d+, \d{4} \(Europe\/Paris\)\n/);
      expect(recovered).toContain(`User: ${content}`);
      expect(recovered).toContain("Assistant: Noted.");
      expect(await app.prisma.memoryFact.findMany({
        where: { namespace: `agent:${botId}`, supersededAt: null },
        select: { fact: true, tier: true, origin: true, turnId: true },
      })).toEqual([committed
        ? { fact: "The user lives in Paris.", tier: "profile", origin: "tool", turnId: "post-crash-correction" }
        : { fact: "The user lives in Lyon.", tier: "profile", origin: "extract", turnId: pending.id }]);
      if (committed) {
        expect(await app.prisma.memoryFact.count({ where: { namespace: `agent:${botId}` } })).toBe(2);
        expect((await app.prisma.memoryFact.findUniqueOrThrow({ where: { id: committed.id } })).supersededAt).not.toBeNull();
      }
      expect((await app.prisma.bot.findUniqueOrThrow({ where: { id: botId } })).pendingMemoryExchanges).toEqual([]);
      expect(await app.prisma.memoryReviewLease.count({ where: { botId: bot.id } })).toBe(0);
      if (crashAt === "before-publication") {
        expect(await app.prisma.channelMessage.count({ where: { sourceRunId: pending.id, content: "Noted." } })).toBe(1);
        expect((await app.prisma.channelDelivery.findUniqueOrThrow({ where: { id: pending.deliveryId! } })).status).toBe("completed");
      }
      await worker.stop();
      await worker.start();
      expect(extractions).toHaveLength(expectedExtractions);
    } finally {
      await worker?.stop();
      if (app) {
        if (botId) {
          await app.prisma.memoryFact.deleteMany({ where: { writtenByBotId: botId } });
          if (groupId) await app.prisma.channel.deleteMany({ where: { id: groupId } });
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
