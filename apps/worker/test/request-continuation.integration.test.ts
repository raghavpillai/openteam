import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { ComputerTurnRequest } from "@openteam/contracts";
import { dispatchRequestChecks } from "@openteam/messaging";
import { AppService } from "../../server/src/app-service";
import { WakeWorker } from "../src/worker";

const db = process.env.OPENTEAM_TEST_DATABASE_URL;
test.skipIf(!db)(
  "real queue retains the broader request after a scoped done, parks privately and verifies once after host recreation",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "parent-request-queue-"));
    const keys = [
      "DATABASE_URL",
      "OPENTEAM_COMPUTER_URL",
      "OPENTEAM_CONTROL_TOKEN",
      "OPENTEAM_WORKSPACE_ROOT",
      "OPENTEAM_AGENT_DATA_ROOT",
    ] as const;
    const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    let app: AppService | undefined,
      worker: WakeWorker | undefined,
      parentId = "",
      requestId = "";
    let acceptedMessages = 0,
      confirmationReady = false,
      finished = false,
      droppedOwnershipOnce = false;
    const errors: unknown[] = [],
      turns: ComputerTurnRequest[] = [];
    const fake = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/health")
          return Response.json({
            status: "ready",
            inference: { ready: true, authenticated: true },
          });
        if (path === "/v1/task-capabilities")
          return Response.json({ desktopAvailable: true, boxAvailable: true });
        if (path === "/v1/agent-stores" && req.method === "GET")
          return Response.json({ agents: [] });
        if (path === "/v1/infer") return Response.json({ text: "NONE" });
        if (path === "/v1/directories") {
          const input = (await req.json()) as { paths: string[] };
          for (const p of input.paths) await mkdir(p, { recursive: true });
          return Response.json({ directories: input.paths });
        }
        if (path.startsWith("/v1/context-sessions/") && req.method === "GET")
          return Response.json({
            type: "context.state",
            contextSessionId: path.split("/").at(-1),
            epoch: 0,
            archives: [],
          });
        if (path !== "/v1/turns") return Response.json({ ok: true });
        const turn = (await req.json()) as ComputerTurnRequest;
        turns.push(turn);
        const call = (tool: string, args: unknown) =>
          Effect.runPromise(
            app!.handleDynamicTool({
              runId: turn.runId,
              botId: turn.botId,
              conversationId: turn.conversationId,
              channelId: turn.channelId,
              deliveryId: turn.deliveryId,
              callId: crypto.randomUUID(),
              tool,
              arguments: args,
            })
          );
        let final = "";
        try {
          if (turn.runtimeProfile === "subagent") {
            await expect(call("ReportRequestProgress", {
              key: "child-cannot-close-parent", state: "complete", summary: "Only the scoped step ended",
              evidence: ["/appointments/receipt"], remaining: [],
            })).rejects.toThrow("user-facing parent");
            // This worker is allowed one approved message, not the larger workflow.
            acceptedMessages++;
            expect(acceptedMessages).toBe(1);
            final =
              "Status: done\nThe exact approved appointment message was sent once. Confirmation is pending. This worker's approved step is complete. The parent must monitor the confirmation; another send needs approval.";
          } else if (turn.content.includes("START_PARENT_REQUEST")) {
            requestId = turn.runId;
            await call("Task", {
              description: "Approved appointment message",
              subagent_type: "computerUse",
              prompt:
                "Send this exact approved appointment message once, then read its receipt. No further messages, fees or changed terms are authorized.",
            });
          } else if (turn.content.includes("[Unfinished user request:")) {
            expect(droppedOwnershipOnce).toBe(true);
            expect(turn.instructions).toContain(requestId);
            expect(acceptedMessages).toBe(1);
            if (!confirmationReady) {
              await call("ReportRequestProgress", {
                request_run_id: requestId,
                key: "confirmation-pending",
                state: "waiting",
                summary: "The single approved message has a receipt; confirmation is pending.",
                evidence: ["/appointments/receipt"],
                remaining: ["Verify appointment confirmation and report it"],
                nextAction:
                  "Read confirmation status only; request fresh approval before any outgoing action.",
                checkAt: new Date(Date.now() + 3600_000).toISOString(),
              });
            } else {
              await call("SendToUser", {
                content: "Appointment confirmed; the written confirmation was verified.",
              });
              await call("ReportRequestProgress", {
                request_run_id: requestId,
                key: "confirmation-verified-and-delivered",
                state: "complete",
                summary: "The written appointment confirmation was verified and delivered.",
                evidence: ["/appointments/confirmation", "message:confirmation-delivered"],
                remaining: [],
              });
              finished = true;
            }
          } else if (turn.content.includes("approved appointment message was sent once")) {
            // Reproduce the observed model lapse. The host must keep this unfinished
            // user request owned, even though the child's scoped result is done.
            droppedOwnershipOnce = true;
          }
        } catch (error) {
          errors.push(error);
          return Response.json({ error: String(error) }, { status: 500 });
        }
        const events = [
          {
            type: "session.attached",
            runtimeEngine: "pi",
            inferenceProvider: "openai-codex",
            contextSessionId: turn.contextSessionId,
            sessionPath: turn.sessionPath ?? `/var/lib/openteam/pi/${turn.contextSessionId}.jsonl`,
            sessionId: turn.contextSessionId,
            model: "fixture",
          },
          {
            type: "context.state",
            contextSessionId: turn.contextSessionId,
            epoch: 0,
            archives: [],
          },
          { type: "turn.started", turnId: turn.runId },
          { type: "prompt.delivered", turnId: turn.runId },
          ...(final
            ? [
                {
                  type: "item.completed",
                  turnId: turn.runId,
                  item: { id: `final-${turn.runId}`, type: "agentMessage", text: final },
                },
              ]
            : []),
          { type: "turn.completed", turnId: turn.runId, status: "completed" },
        ];
        return new Response(events.map((e) => JSON.stringify(e)).join("\n") + "\n", {
          headers: { "content-type": "application/x-ndjson" },
        });
      },
    });
    const until = async (condition: () => Promise<boolean>) => {
      for (let i = 0; i < 800; i++) {
        if (errors.length) throw errors[0];
        if (await condition()) return;
        await Bun.sleep(50);
      }
      throw new Error(
        `Request queue timed out: ${JSON.stringify(turns.map((t) => ({ profile: t.runtimeProfile, source: t.requestSource, content: t.content.slice(0, 90) })))}`
      );
    };
    const boot = async () => {
      app = new AppService();
      await Effect.runPromise(app.boot());
      await app.agentData.writeInferenceSettings({
        providerId: "openai-codex",
        modelId: "fixture-model",
        reasoning: "low",
      });
      worker = new WakeWorker();
      await worker.start();
    };
    try {
      Object.assign(process.env, {
        DATABASE_URL: db,
        OPENTEAM_COMPUTER_URL: fake.url.origin,
        OPENTEAM_CONTROL_TOKEN: "fixture",
        OPENTEAM_WORKSPACE_ROOT: root,
        OPENTEAM_AGENT_DATA_ROOT: join(root, "data"),
      });
      await boot();
      const bot = await Effect.runPromise(
        app!.createBot({ clientRequestId: crypto.randomUUID(), name: "Parent request fixture" })
      );
      parentId = bot.id;
      await until(
        async () =>
          (await app!.prisma.bot.findUnique({ where: { id: parentId } }))?.onboardingStatus ===
          "completed"
      );
      await Effect.runPromise(
        app!.sendMessage(bot.conversationId, {
          clientId: crypto.randomUUID(),
          content:
            "START_PARENT_REQUEST: arrange the appointment and verify confirmation. Only one approved message may be sent.",
        })
      );
      await until(
        async () =>
          !!requestId &&
          (await app!.prisma.run.findUnique({ where: { id: requestId } }))?.requestNextCheckAt !=
            null
      );
      const saved = await app!.prisma.run.findUniqueOrThrow({ where: { id: requestId } });
      expect(saved.requestProgress).toMatchObject({
        state: "waiting",
        remaining: ["Verify appointment confirmation and report it"],
      });
      const child = await app!.prisma.subagent.findFirstOrThrow({
        where: { parentBotId: parentId },
      });
      expect(child.status).toBe("completed");
      expect(child.requestRunId).toBe(requestId);
      expect(acceptedMessages).toBe(1);
      await until(
        async () => !(await app!.prisma.botRunLease.count({ where: { botId: parentId } }))
      );
      await worker!.stop();
      worker = undefined;
      await Effect.runPromise(app!.close());
      app = undefined;
      confirmationReady = true;
      await boot();
      expect(
        await dispatchRequestChecks(
          app!.prisma,
          app!.messaging,
          new Date(saved.requestNextCheckAt!.getTime() + 1)
        )
      ).toBe(1);
      await until(
        async () =>
          finished && !(await app!.prisma.botRunLease.count({ where: { botId: parentId } }))
      );
      const completed = await app!.prisma.run.findUniqueOrThrow({ where: { id: requestId } });
      expect(completed.requestProgress).toMatchObject({ state: "complete", remaining: [] });
      expect(completed.requestNextCheckAt).toBeNull();
      expect(acceptedMessages).toBe(1);
      expect(await app!.prisma.subagent.count({ where: { parentBotId: parentId } })).toBe(1);
      expect(
        await app!.prisma.channelMessage.count({
          where: {
            senderBotId: parentId,
            content: "Appointment confirmed; the written confirmation was verified.",
          },
        })
      ).toBe(1);
      expect(
        await dispatchRequestChecks(app!.prisma, app!.messaging, new Date(Date.now() + 86400_000))
      ).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await worker?.stop();
      if (app) {
        const children = await app.prisma.subagent.findMany({
          where: { parentBotId: parentId },
          select: { childBotId: true },
        });
        await app.prisma.bot.deleteMany({
          where: { id: { in: [parentId, ...children.map((c) => c.childBotId)] } },
        });
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
  90_000
);
