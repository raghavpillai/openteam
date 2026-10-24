import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { ComputerTurnRequest } from "@openteam/contracts";
import { AppService } from "../../server/src/app-service";
import { WakeWorker } from "../src/worker";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
test.skipIf(!databaseUrl)(
  "mail that arrives while a listener routine runs is delivered together in its next wake",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "routine-coalescing-"));
    let app: AppService | undefined, worker: WakeWorker | undefined;
    let botId = "";
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const turns: ComputerTurnRequest[] = [];
    const fake = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/v1/task-capabilities") return Response.json({ desktopAvailable: true, boxAvailable: true });
        if (path === "/health") return Response.json({ status: "ready", inference: { ready: true, authenticated: true } });
        if (path === "/v1/agent-stores" && request.method === "GET") return Response.json({ agents: [] });
        if (path === "/v1/infer") return Response.json({ text: "NONE" });
        if (path === "/v1/directories") {
          const input = (await request.json()) as { paths: string[] };
          for (const directory of input.paths ?? []) await mkdir(directory, { recursive: true });
          return Response.json({ directories: input.paths });
        }
        if (path.startsWith("/v1/context-sessions/") && request.method === "GET")
          return Response.json({ type: "context.state", contextSessionId: path.split("/").at(-1), epoch: 0, archives: [] });
        if (path !== "/v1/turns") return Response.json({ ok: true, quarantined: [] });
        const input = (await request.json()) as ComputerTurnRequest;
        turns.push(input);
        // The first routine run stays busy while more mail arrives.
        if (input.content.includes("COALESCE_FIXTURE") && turns.filter((turn) => turn.content.includes("COALESCE_FIXTURE")).length === 1)
          await gate;
        const events = [
          { type: "session.attached", runtimeEngine: "pi", inferenceProvider: "openai-codex", contextSessionId: input.contextSessionId,
            sessionPath: input.sessionPath ?? `/var/lib/openteam/pi/${input.contextSessionId}.jsonl`, sessionId: input.contextSessionId, model: "fake" },
          { type: "context.state", contextSessionId: input.contextSessionId, epoch: 0, archives: [] },
          { type: "turn.started", turnId: input.runId },
          { type: "prompt.delivered", turnId: input.runId },
          { type: "item.completed", turnId: input.runId, item: { id: `final-${input.runId}`, type: "agentMessage", text: "Noted the mail." } },
          { type: "turn.completed", turnId: input.runId, status: "completed" },
        ];
        return new Response(events.map((event) => JSON.stringify(event)).join("\n") + "\n", {
          headers: { "content-type": "application/x-ndjson" },
        });
      },
    });
    const keys = ["DATABASE_URL", "OPENTEAM_COMPUTER_URL", "OPENTEAM_CONTROL_TOKEN", "OPENTEAM_WORKSPACE_ROOT", "OPENTEAM_AGENT_DATA_ROOT"] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const until = async (check: () => Promise<boolean>) => {
      for (let i = 0; i < 600; i++) {
        if (await check()) return;
        await Bun.sleep(50);
      }
      throw new Error("Routine coalescing fixture timed out");
    };
    try {
      Object.assign(process.env, {
        DATABASE_URL: databaseUrl,
        OPENTEAM_COMPUTER_URL: fake.url.origin,
        OPENTEAM_CONTROL_TOKEN: "synthetic-coalescing",
        OPENTEAM_WORKSPACE_ROOT: root,
        OPENTEAM_AGENT_DATA_ROOT: join(root, "data"),
      });
      app = new AppService();
      await Effect.runPromise(app.boot());
      await app.agentData.writeInferenceSettings({ providerId: "openai-codex", modelId: "fixture-model", reasoning: "low" });
      worker = new WakeWorker();
      await worker.start();
      const bot = await Effect.runPromise(app.createBot({ clientRequestId: crypto.randomUUID(), name: "Coalescing fixture" }));
      botId = bot.id;
      await until(async () => (await app!.prisma.bot.findUnique({ where: { id: botId } }))?.onboardingStatus === "completed");
      const inbox = `vendor-${crypto.randomUUID().slice(0, 8)}@example.com`;
      const routine = await app.routines.mutate(botId, crypto.randomUUID(), null, {
        action: "create",
        name: "Vendor replies",
        prompt: "COALESCE_FIXTURE: tell me what each vendor reply says.",
        trigger: { type: "email", inbox },
      });
      const mail = (n: number) => ({
        id: `${inbox}:1:${n}`, source: "email", kind: "received", channel: inbox,
        actor: "vendor@partner.com", authenticatedUser: true, text: `From: vendor@partner.com\nSubject: Reply ${n}`,
      });
      const [first] = await app.routines.dispatchEventToAll(mail(1));
      await until(async () => turns.some((turn) => turn.content.includes("COALESCE_FIXTURE")));
      expect((await app.prisma.routineExecution.findUniqueOrThrow({ where: { id: first!.id } })).status).toBe("running");

      // Three more replies land in one mail poll while the first run is still working.
      const later = [];
      for (const n of [2, 3, 4]) later.push(...(await app.routines.dispatchEventToAll(mail(n))));
      expect(new Set(later.map((execution) => execution.id)).size).toBe(1);
      expect(later[0]!.id).not.toBe(first!.id);
      expect(later.every((execution) => execution.status === "queued" && execution.runId === null)).toBe(true);
      // A redelivered message is still recognized once it was folded into the follow-up.
      expect((await app.routines.dispatchEventToAll(mail(3)))[0]!.id).toBe(later[0]!.id);
      const followUp = await app.prisma.routineExecution.findUniqueOrThrow({ where: { id: later[0]!.id } });
      expect((followUp.events as Array<{ id: string }>).map((event) => event.id)).toEqual([2, 3, 4].map((n) => mail(n).id));
      expect(followUp.coalescedKeys).toHaveLength(2);
      expect(await app.prisma.routineExecution.count({ where: { routineId: String(routine.id), status: "skipped" } })).toBe(0);

      release();
      await until(async () => turns.filter((turn) => turn.content.includes("COALESCE_FIXTURE")).length === 2);
      const [firstTurn, nextTurn] = turns.filter((turn) => turn.content.includes("COALESCE_FIXTURE"));
      expect(firstTurn!.content).toContain(mail(1).id);
      expect(nextTurn!.content).toContain("was triggered by 3 events it listens for.");
      expect(nextTurn!.content.match(/<email_received>/g)).toHaveLength(3);
      for (const n of [2, 3, 4]) expect(nextTurn!.content).toContain(`Subject: Reply ${n}`);
      expect(nextTurn!.content).not.toContain("Subject: Reply 1");
      await until(async () =>
        (await app!.prisma.routineExecution.count({ where: { routineId: String(routine.id), status: "completed" } })) === 2
      );
      expect(await app.prisma.routineExecution.count({ where: { routineId: String(routine.id) } })).toBe(2);
    } finally {
      release();
      await worker?.stop();
      if (app) {
        await app.agentData.stopWatching();
        if (botId) {
          await app.prisma.channel.deleteMany({ where: { kind: "bot_dm", members: { some: { botId } } } });
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
  60_000
);
