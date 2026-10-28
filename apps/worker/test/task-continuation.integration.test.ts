import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { ComputerTurnRequest } from "@openteam/contracts";
import { dispatchTaskContinuations } from "@openteam/messaging";
import { AppService } from "../../server/src/app-service";
import { WakeWorker } from "../src/worker";

const db = process.env.OPENTEAM_TEST_DATABASE_URL;
const realTimeSoak = process.env.OPENTEAM_TASK_SOAK === "1";
test.skipIf(!db)(
  "real queue preserves delayed work across host recreation and reconciles an accepted action after lost completion",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "task-continuation-worker-"));
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
      parentId = "";
    const paths: string[] = [];
    const errors: unknown[] = [],
      turns: ComputerTurnRequest[] = [];
    let exportActions = 0,
      documentActions = 0,
      documentReady = false,
      lostCompletion = false;
    const fake = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        paths.push(`${req.method} ${path}`);
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
        const input = (await req.json()) as ComputerTurnRequest;
        turns.push(input);
        const call = (tool: string, args: unknown, callId = crypto.randomUUID()) =>
          Effect.runPromise(
            app!.handleDynamicTool({
              runId: input.runId,
              botId: input.botId,
              conversationId: input.conversationId,
              channelId: input.channelId,
              deliveryId: input.deliveryId,
              callId,
              tool,
              arguments: args,
            })
          );
        let final = "",
          omitCompletion = false;
        try {
          if (input.runtimeProfile === "subagent") {
            if (input.content.includes("EXPORT_WORKFLOW")) {
              if (!lostCompletion) {
                // The external service accepted the action, but the host never got
                // an authoritative completion or an explicit progress checkpoint.
                exportActions++;
                lostCompletion = true;
                omitCompletion = true;
              } else {
                expect(input.instructions).toContain("reconciliationRequired");
                expect(input.content).toContain("before repeating");
                // Re-read the independent service receipt instead of submitting again.
                expect(exportActions).toBe(1);
                await call("ReportTaskProgress", {
                  key: "export-confirmed",
                  state: "complete",
                  summary: "Export receipt independently verified",
                  evidence: ["/exports/receipt"],
                  remaining: [],
                });
                final =
                  "Status: done\nEXPORT_FINISHED: service receipt verified; no duplicate submission.";
              }
            } else if (input.content.includes("PARTIAL_RESOLVED")) {
              await call("ReportTaskProgress", { key: "outside-decision-verified", state: "complete",
                summary: "The authorized outside decision is verified", evidence: ["/requests/decision"], remaining: [] });
              final = "Status: done\nPARTIAL_FINISHED: the outside decision is verified.";
            } else if (input.content.includes("PARTIAL_WORKFLOW")) {
              final = "Status: partial\nPARTIAL_PENDING: an outside decision remains pending. Inspect it when its result is supplied.";
            } else if (input.content.includes("DOCUMENT_WORKFLOW")) {
              if (!documentReady) {
                documentActions++;
                const wait = {
                  key: "document-pending",
                  state: "waiting",
                  summary: "Submission accepted; required document pending",
                  evidence: ["/requests/receipt"],
                  remaining: ["Supply the requested document and verify final acceptance"],
                  nextAction:
                    "Read the request and provide the authorized document, with no additional fee",
                  checkAt: new Date(Date.now() + 3600_000).toISOString(),
                  deadline: new Date(Date.now() + 7200_000).toISOString(),
                };
                await call("ReportTaskProgress", wait);
                await call("ReportTaskProgress", wait);
              } else {
                expect(input.instructions).toContain("Supply the requested document");
                expect(input.content).toContain("no additional fee");
                expect(documentActions).toBe(1);
                await call("ReportTaskProgress", {
                  key: "document-confirmed",
                  state: "complete",
                  summary: "Required document accepted and final outcome verified",
                  evidence: ["/requests/final-receipt"],
                  remaining: [],
                });
                final = "Status: done\nDOCUMENT_FINISHED: final acceptance verified.";
              }
            }
          } else if (input.content.includes("START_EXPORT")) {
            await call("Task", {
              description: "Export reconciliation",
              prompt:
                "EXPORT_WORKFLOW: Generate the approved export once. Verify its receipt; do not publish it elsewhere or incur fees.",
              subagent_type: "executor",
            });
          } else if (input.content.includes("RESOLVE_PARTIAL")) {
            const pending = await app!.prisma.subagent.findFirstOrThrow({ where: { parentBotId: parentId, description: "Unfinished request" } });
            await call("Task", { description: "Verify the supplied decision", subagent_type: "computerUse",
              resume: `sand-subagent-${pending.id}`, prompt: "PARTIAL_RESOLVED: The user supplied the new outside decision. Verify it within the original scope; do not add fees." });
          } else if (input.content.includes("START_PARTIAL")) {
            await call("Task", {
              description: "Unfinished request",
              prompt: "PARTIAL_WORKFLOW: Complete the approved request and its outside decision without adding fees.",
              subagent_type: "computerUse",
            });
          } else if (input.content.includes("START_DOCUMENT")) {
            await call("Task", {
              description: "Document acceptance",
              prompt:
                "DOCUMENT_WORKFLOW: Finish the approved request, including its later document question. Do not accept any additional fee.",
              subagent_type: "executor",
            });
          } else {
            await call("SendToUser", {
              content: input.content.includes("EXPORT_FINISHED")
                ? "Export workflow finished."
                : input.content.includes("DOCUMENT_FINISHED")
                  ? "Document workflow finished."
                  : input.content.includes("PARTIAL_FINISHED")
                    ? "Partial work resolved."
                  : input.content.includes("PARTIAL_PENDING")
                    ? "Partial work stays owned."
                  : input.content.includes("UNRELATED")
                    ? "Unrelated question answered."
                    : input.content.includes("Delegated task progress")
                      ? "Verified milestone received; remaining work stays owned."
                      : "Fixture ready.",
              end_turn: true,
            });
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
            contextSessionId: input.contextSessionId,
            sessionPath:
              input.sessionPath ?? `/var/lib/openteam/pi/${input.contextSessionId}.jsonl`,
            sessionId: input.contextSessionId,
            model: "fixture",
          },
          {
            type: "context.state",
            contextSessionId: input.contextSessionId,
            epoch: 0,
            archives: [],
          },
          { type: "turn.started", turnId: input.runId },
          { type: "prompt.delivered", turnId: input.runId },
          ...(final
            ? [
                {
                  type: "item.completed",
                  turnId: input.runId,
                  item: { id: `final-${input.runId}`, type: "agentMessage", text: final },
                },
              ]
            : []),
          ...(omitCompletion
            ? []
            : [{ type: "turn.completed", turnId: input.runId, status: "completed" }]),
        ];
        return new Response(events.map((e) => JSON.stringify(e)).join("\n") + "\n", {
          headers: { "content-type": "application/x-ndjson" },
        });
      },
    });
    const until = async (condition: () => Promise<boolean>) => {
      for (let i = 0; i < 900; i++) {
        if (errors.length) throw errors[0];
        if (await condition()) return;
        await Bun.sleep(50);
      }
      const runs = await app!.prisma.run.findMany({
        select: { origin: true, status: true, error: true },
      });
      throw new Error(
        `Durable task integration fixture timed out: ${JSON.stringify({ paths: paths.slice(-25), turns: turns.map((t) => ({ origin: t.requestSource, profile: t.runtimeProfile })), runs })}`
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
        OPENTEAM_CONTROL_TOKEN: "task-fixture",
        OPENTEAM_WORKSPACE_ROOT: root,
        OPENTEAM_AGENT_DATA_ROOT: join(root, "data"),
      });
      await boot();
      const bot = await Effect.runPromise(
        app!.createBot({ clientRequestId: crypto.randomUUID(), name: "Durable work fixture" })
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
          content: "START_EXPORT",
        })
      );
      await until(
        async () =>
          (await app!.prisma.subagent.count({
            where: {
              parentBotId: parentId,
              description: "Export reconciliation",
              status: "waiting",
            },
          })) === 1
      );
      const interrupted = await app!.prisma.subagent.findFirstOrThrow({
        where: { parentBotId: parentId, description: "Export reconciliation" },
      });
      // A late callback cannot close a task already fenced for reconciliation.
      await app!.prisma.$transaction((tx) =>
        (worker as any).completeSubagent(tx, {
          botId: interrupted.childBotId,
          runId: interrupted.currentRunId,
        })
      );
      expect(
        (await app!.prisma.subagent.findUniqueOrThrow({ where: { id: interrupted.id } })).status
      ).toBe("waiting");
      await until(
        async () =>
          (await app!.prisma.channelMessage.count({
            where: { senderBotId: parentId, content: "Export workflow finished." },
          })) === 1
      );
      expect(exportActions).toBe(1);
      const exported = await app!.prisma.subagent.findFirstOrThrow({
        where: { parentBotId: parentId, description: "Export reconciliation" },
      });
      expect(exported).toMatchObject({ status: "completed", recoveryAttempts: 1 });
      await Effect.runPromise(
        app!.sendMessage(bot.conversationId, {
          clientId: crypto.randomUUID(),
          content: "START_DOCUMENT",
        })
      );
      await until(
        async () =>
          (await app!.prisma.subagent.count({
            where: { parentBotId: parentId, status: "waiting" },
          })) === 1
      );
      const waiting = await app!.prisma.subagent.findFirstOrThrow({
        where: { parentBotId: parentId, status: "waiting" },
      });
      expect(waiting.nextCheckAt).not.toBeNull();
      await Effect.runPromise(
        app!.sendMessage(bot.conversationId, {
          clientId: crypto.randomUUID(),
          content: "UNRELATED question while the document is pending",
        })
      );
      await until(
        async () =>
          (await app!.prisma.channelMessage.count({
            where: { senderBotId: parentId, content: "Unrelated question answered." },
          })) === 1
      );
      expect(
        (await app!.prisma.subagent.findUniqueOrThrow({ where: { id: waiting.id } })).status
      ).toBe("waiting");
      await worker!.stop();
      worker = undefined;
      await Effect.runPromise(app!.close());
      app = undefined;
      if (realTimeSoak) {
        // Restart midway through an actual one-hour dependency. The normal host
        // dispatcher, not a virtual clock, must own and deliver the continuation.
        console.log(
          `TASK_SOAK parked ${new Date().toISOString()} next=${waiting.nextCheckAt!.toISOString()}`
        );
        documentReady = true;
        await boot();
        const midpoint = Math.max(0, waiting.nextCheckAt!.getTime() - Date.now() - 1800_000);
        for (let left = midpoint; left > 0; left -= 30_000) await Bun.sleep(Math.min(left, 30_000));
        await worker!.stop();
        worker = undefined;
        await Effect.runPromise(app!.close());
        app = undefined;
        await boot();
        console.log(`TASK_SOAK midpoint restart ${new Date().toISOString()}`);
        await Effect.runPromise(
          app!.sendMessage(bot.conversationId, {
            clientId: crypto.randomUUID(),
            content: "UNRELATED question after the midpoint restart",
          })
        );
        await until(
          async () =>
            (await app!.prisma.channelMessage.count({
              where: { senderBotId: parentId, content: "Unrelated question answered." },
            })) === 2
        );
        const pause = Math.max(0, waiting.nextCheckAt!.getTime() - Date.now() - 30_000);
        for (let left = pause; left > 0; left -= 30_000) await Bun.sleep(Math.min(left, 30_000));
        expect(
          (await app!.prisma.subagent.findUniqueOrThrow({ where: { id: waiting.id } })).status
        ).toBe("waiting");
        console.log(`TASK_SOAK waiting retained ${new Date().toISOString()}`);
      } else {
        documentReady = true;
        await boot();
        expect(
          await dispatchTaskContinuations(
            app!.prisma,
            app!.messaging,
            new Date(Date.now() + 3600_000)
          )
        ).toBe(1);
      }
      await until(
        async () =>
          (await app!.prisma.channelMessage.count({
            where: { senderBotId: parentId, content: "Document workflow finished." },
          })) === 1
      );
      expect(documentActions).toBe(1);
      expect(
        (await app!.prisma.subagent.findUniqueOrThrow({ where: { id: waiting.id } })).status
      ).toBe("completed");
      expect(await app!.prisma.subagentAttempt.count({ where: { subagentId: waiting.id } })).toBe(
        2
      );
      await Effect.runPromise(app!.sendMessage(bot.conversationId, {
        clientId: crypto.randomUUID(), content: "START_PARTIAL",
      }));
      await until(async () => (await app!.prisma.channelMessage.count({
        where: { senderBotId: parentId, content: "Partial work stays owned." },
      })) === 1);
      const partial = await app!.prisma.subagent.findFirstOrThrow({
        where: { parentBotId: parentId, description: "Unfinished request" },
      });
      expect(partial.status).toBe("waiting");
      expect(partial.nextCheckAt).toBeNull();
      expect(partial.result).toStartWith("Status: partial");
      expect(partial.progress).toMatchObject({ state: "blocked", blockSource: "runtime" });
      expect((partial.progress as any).remaining.length).toBeGreaterThan(0);
      expect(await dispatchTaskContinuations(app!.prisma, app!.messaging, new Date(Date.now() + 3600_000))).toBe(0);
      await app!.prisma.$transaction(tx => (worker as any).completeSubagent(tx, {
        botId: partial.childBotId, runId: partial.currentRunId,
      }));
      expect(await app!.prisma.subagentAttempt.count({ where: { subagentId: partial.id } })).toBe(1);
      expect(await app!.prisma.channelMessage.count({ where: { senderBotId: parentId, content: "Partial work stays owned." } })).toBe(1);
      await Effect.runPromise(app!.sendMessage(bot.conversationId, { clientId: crypto.randomUUID(), content: "RESOLVE_PARTIAL with new information" }));
      await until(async () => (await app!.prisma.channelMessage.count({ where: { senderBotId: parentId, content: "Partial work resolved." } })) === 1);
      expect((await app!.prisma.subagent.findUniqueOrThrow({ where: { id: partial.id } })).status).toBe("completed");
      expect(await app!.prisma.subagentAttempt.count({ where: { subagentId: partial.id } })).toBe(2);
      expect(errors).toEqual([]);
    } finally {
      await worker?.stop();
      if (app) {
        await app.agentData.stopWatching();
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
      for (const k of keys) {
        if (previous[k] === undefined) delete process.env[k];
        else process.env[k] = previous[k];
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  realTimeSoak ? 3_750_000 : 120_000
);
