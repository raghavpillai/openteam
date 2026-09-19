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
  "routine → isolated automation → WakeParent → channel delivery, including silent results and delegated continuation",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "wake-parent-worker-"));
    let app: AppService | undefined, worker: WakeWorker | undefined;
    let botId = "",
      channelId = "";
    let releaseAutomation: () => void = () => {};
    let releaseParent: () => void = () => {};
    let releaseManagedChild: () => void = () => {};
    const managedChildGate = new Promise<void>(resolve => { releaseManagedChild = resolve; });
    const automationGate = new Promise<void>(resolve => { releaseAutomation = resolve; });
    const parentGate = new Promise<void>(resolve => { releaseParent = resolve; });
    const turns: ComputerTurnRequest[] = [],
      errors: unknown[] = [];
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
        if (path === "/v1/infer") return Response.json({ text: "NONE" });
        if (path === "/v1/directories") {
          const input = (await request.json()) as { paths: string[] };
          for (const directory of input.paths ?? []) await mkdir(directory, { recursive: true });
          return Response.json({ directories: input.paths });
        }
        if (path.startsWith("/v1/context-sessions/") && request.method === "GET")
          return Response.json({
            type: "context.state",
            contextSessionId: path.split("/").at(-1),
            epoch: 0,
            archives: [],
          });
        if (path !== "/v1/turns") return Response.json({ ok: true, quarantined: [] });
        const input = (await request.json()) as ComputerTurnRequest;
        turns.push(input);
        if (input.content.includes("WP_BLOCK_AUTOMATION")) await automationGate;
        if (input.content.includes("WP_CONCURRENT_PARENT")) await parentGate;
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
        let final = "";
        try {
          if (input.runtimeProfile === "subagent") {
            await expect(call("Task", { description: "Forbidden nested task", prompt: "Never launch" })).rejects.toThrow("parent-agent only");
            if (input.content.includes("WP_MANAGED_CHILD")) await managedChildGate;
            if (input.subagentType === "computerUse") {
              expect(input.taskConfiguration).toMatchObject({ combinedComputerUse: true });
              expect(input.instructions).toContain("Computer and browser_* tools");
              expect(input.model).not.toContain("ignored-model");
            }
            final = input.content.includes("WP_FOREGROUND_CHILD") ? "WP_FOREGROUND_RESULT" : "WP_CHILD_RESULT: checked the fixture successfully.";
          } else if (input.requestSource === "automation") {
            expect(input.instructions).toContain("WakeParent is the only route");
            await expect(
              call("SendToUser", { type: "text", content: "Must never appear" })
            ).rejects.toThrow("Use WakeParent");
            if (input.content.includes("WP_CHILD_RESULT")) {
              expect(input.sessionPath).not.toBeNull();
              await call("WakeParent", {
                message: "WP_DELEGATED_SUCCESS: Tell the user the delegated check completed.",
              });
            } else if (input.content.includes("WP_DELEGATE")) {
              await call("Task", {
                description: "Delegated automation check",
                prompt: "Return WP_CHILD_RESULT.",
                subagent_type: "executor",
              });
              await call("Task", {
                description: "Combined computer fixture",
                prompt: "Verify the combined worker context and return a result.",
                subagent_type: "computerUse",
                model: "ignored-model",
                run_in_background: false,
              });
            } else if (input.content.includes("WP_ALERT")) {
              const first = await call("WakeParent", {
                message: "WP_ALERT_RESULT: Notify the user that the check found a change.",
              });
              expect(
                await call("WakeParent", {
                  message: "WP_ALERT_RESULT: Notify the user that the check found a change.",
                })
              ).toEqual(first);
            } else {
              final = "WP_SILENT_RESULT: no changes; saved for the next normal turn.";
            }
          } else {
            if (input.content.includes("WP_FOREGROUND_PARENT")) {
              // A Settings edit during a run must not change the parent's contract,
              // refreshed prompt, or the model selected for its subsequent Tasks.
              await Effect.runPromise(app!.updateTaskSettings({ combinedComputerUse: false, executorProfiles: [] }));
              const parentContext = await app!.prisma.contextSession.findUniqueOrThrow({ where: { id: input.contextSessionId } });
              const refreshed = await call("RefreshPromptContext", { contextSessionId: input.contextSessionId, epoch: parentContext.compactionEpoch });
              expect((refreshed as any).instructions).toContain("quick: Short fixture tasks");
              expect((refreshed as any).instructions).toContain("computerUse: browser and desktop work");
              const result=await call("Task",{description:"Foreground fixture",prompt:"WP_FOREGROUND_CHILD",subagent_type:"executor",run_in_background:false,model:"quick"});
              expect(String(result)).toContain("WP_FOREGROUND_RESULT");
              const id = /Agent ID: (sand-subagent-[\da-f-]+)/.exec(String(result))?.[1];
              expect(id).toBeDefined();
              const resumed = await call("Task", { description: "Foreground fixture", prompt: "WP_FOREGROUND_CHILD follow-up", resume: id, model: "ignored-on-resume", run_in_background: false });
              expect(String(resumed)).toContain("WP_FOREGROUND_RESULT");
              const launchId = crypto.randomUUID();
              const task = { description: "Managed background fixture", prompt: "WP_MANAGED_CHILD", subagent_type: "executor", model: "quick" };
              const background = await call("Task", task, launchId);
              expect(String(background)).toContain("Subagent is running in the background.");
              expect(await call("Task", task, launchId)).toEqual(background);
              await expect(call("Task", { ...task, prompt: "different task" }, launchId)).rejects.toThrow("reused");
              const backgroundId = /Agent ID: (sand-subagent-[\da-f-]+)/.exec(String(background))![1]!;
              await until(async () => turns.some(turn => turn.content.includes("WP_MANAGED_CHILD")));
              expect(await call("CheckSubagent", { subagent_id: backgroundId })).toMatchObject({ status: "running" });
              await expect(call("Task", { description: "Busy resume", prompt: "continue", resume: backgroundId })).rejects.toThrow("still running");
              expect(await call("MessageSubagent", { subagent_id: backgroundId, message: "Change the current work" })).toMatchObject({ delivered: true });
              expect(await call("StopSubagent", { subagent_id: backgroundId })).toMatchObject({ stopped: true });
              releaseManagedChild();
              await Effect.runPromise(app!.updateTaskSettings(input.taskConfiguration));
              await call("SendToUser",{type:"text",content:"Foreground child finished.",end_turn:true});
            } else {
            if (input.content.includes("WP_READ_SILENT"))
              expect(JSON.stringify(input.prependMessages)).toContain("WP_SILENT_RESULT");
            await call("SendToUser", {
              type: "text",
              content: input.content.includes("WP_DELEGATED_SUCCESS")
                ? "Delegated check complete."
                : input.content.includes("WP_ALERT_RESULT")
                  ? "The check found a change."
                  : "Fixture parent reply.",
              end_turn: true,
            });
            }
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
          ...(final
            ? [
                {
                  type: "item.completed",
                  turnId: input.runId,
                  item: { id: `final-${input.runId}`, type: "agentMessage", text: final },
                },
              ]
            : []),
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
      for (let i = 0; i < 600; i++) {
        if (errors.length) throw errors[0];
        if (await check()) return;
        await Bun.sleep(50);
      }
      throw new Error("WakeParent worker fixture timed out");
    };
    try {
      Object.assign(process.env, {
        DATABASE_URL: databaseUrl,
        OPENTEAM_COMPUTER_URL: fake.url.origin,
        OPENTEAM_CONTROL_TOKEN: "synthetic-wakeparent",
        OPENTEAM_WORKSPACE_ROOT: root,
        OPENTEAM_AGENT_DATA_ROOT: join(root, "data"),
        OPENTEAM_MEMORY_DREAMING: "false",
      });
      app = new AppService();
      await Effect.runPromise(app.boot());
      await Effect.runPromise(app.updateTaskSettings({ combinedComputerUse: true, executorProfiles: [
        { name: "quick", description: "Short fixture tasks", providerId: "openai-codex", modelId: "foreground-fixture-model", reasoning: "low" },
      ] }));
      worker = new WakeWorker();
      await worker.start();
      const bot = await Effect.runPromise(
        app.createBot({ clientRequestId: crypto.randomUUID(), name: "WakeParent fixture" })
      );
      botId = bot.id;
      await until(
        async () =>
          (await app!.prisma.bot.findUnique({ where: { id: botId } }))?.onboardingStatus ===
          "completed"
      );
      channelId = (
        await app.prisma.channel.findFirstOrThrow({
          where: { kind: "bot_dm", members: { some: { botId } } },
        })
      ).id;
      const home = await app.prisma.contextSession.findFirstOrThrow({
        where: { botId, scope: "channel", scopeId: channelId },
      });
      const concurrentRoutine = await Effect.runPromise(app.createRoutine(botId, crypto.randomUUID(), { action: "create", name: "Concurrent fixture", prompt: "WP_BLOCK_AUTOMATION", schedule: "@every 1h" }));
      await Effect.runPromise(app.runRoutineNow(concurrentRoutine.id, crypto.randomUUID()));
      await until(async () => turns.some(turn => turn.content.includes("WP_BLOCK_AUTOMATION")));
      await Effect.runPromise(app.sendMessage(bot.conversationId, { clientId: crypto.randomUUID(), content: "WP_CONCURRENT_PARENT" }));
      await until(async () => turns.some(turn => turn.content.includes("WP_CONCURRENT_PARENT")));
      expect(await app.prisma.botRunLease.count({ where: { botId } })).toBe(2);
      releaseAutomation(); releaseParent();
      await until(async () => (await app!.prisma.botRunLease.count({ where: { botId } })) === 0);
      await Effect.runPromise(app.sendMessage(bot.conversationId, {clientId:crypto.randomUUID(),content:"WP_FOREGROUND_PARENT"}));
      await until(async()=>Boolean(await app!.prisma.channelMessage.findFirst({where:{channelId,content:"Foreground child finished."}})));
      const foreground = await app.prisma.subagent.findFirstOrThrow({where:{parentBotId:botId,description:"Foreground fixture"}});
      expect(foreground.runInBackground).toBe(false);
      expect(foreground.model).toContain("foreground-fixture-model");
      expect(foreground.reasoning).toBe("low");
      const foregroundTurns = turns.filter(turn => turn.botId === foreground.childBotId);
      expect(foregroundTurns).toHaveLength(2);
      expect(foregroundTurns[1]!.sessionPath).not.toBeNull();
      expect(foregroundTurns.every(turn => turn.model === foreground.model && turn.reasoning === "low")).toBe(true);
      const initialVisible = await app.prisma.channelMessage.count({ where: { channelId } });
      const execute = async (marker: string) => {
        const routine = await Effect.runPromise(
          app!.createRoutine(botId, crypto.randomUUID(), {
            action: "create",
            name: marker,
            prompt: marker,
            schedule: "@every 1h",
          })
        );
        await Effect.runPromise(app!.runRoutineNow(routine.id, crypto.randomUUID()));
        await until(
          async () =>
            (await app!.prisma.routineExecution.count({
              where: { routineId: routine.id, status: "completed" },
            })) === 1
        );
        return app!.prisma.routineExecution.findFirstOrThrow({ where: { routineId: routine.id } });
      };
      const silent = await execute("WP_SILENT");
      await until(async () =>
        Boolean(await app!.prisma.automationResult.findUnique({ where: { runId: silent.runId! } }))
      );
      expect(await app.prisma.channelMessage.count({ where: { channelId } })).toBe(initialVisible);
      expect(
        await app.prisma.inboxEvent.count({ where: { botId, type: "automation.wake_parent" } })
      ).toBe(0);
      const silentTurn = turns.find((turn) => turn.runId === silent.runId)!;
      expect(silentTurn.contextSessionId).not.toBe(home.id);
      expect(silentTurn.sessionPath).toBeNull();
      expect(
        (await app.prisma.contextSession.findUniqueOrThrow({ where: { id: home.id } })).runtimeSessionPath
      ).toBe(home.runtimeSessionPath);
      // Restart both service and worker before the parent consumes the silent result.
      await worker.stop();
      await Effect.runPromise(app.close());
      app = new AppService();
      await Effect.runPromise(app.boot());
      worker = new WakeWorker();
      await worker.start();
      await Effect.runPromise(
        app.sendMessage(bot.conversationId, {
          clientId: crypto.randomUUID(),
          content: "WP_READ_SILENT",
        })
      );
      await until(async () =>
        Boolean(
          (await app!.prisma.automationResult.findUnique({ where: { runId: silent.runId! } }))
            ?.acknowledgedAt
        )
      );
      const alert = await execute("WP_ALERT");
      await until(
        async () =>
          (await app!.prisma.channelMessage.count({
            where: { channelId, content: "The check found a change." },
          })) === 1
      );
      const alertTurn = turns.find((turn) => turn.runId === alert.runId)!;
      expect(alertTurn.contextSessionId).not.toBe(silentTurn.contextSessionId);
      const parentWake = turns.find(
        (turn) =>
          turn.requestSource === "background-revival" && turn.content.includes("WP_ALERT_RESULT")
      )!;
      expect(parentWake.contextSessionId).toBe(home.id);
      expect(await app.prisma.channelMessage.count({ where: { sourceRunId: alert.runId! } })).toBe(
        0
      );
      const delegated = await execute("WP_DELEGATE");
      await until(
        async () =>
          (await app!.prisma.channelMessage.count({
            where: { channelId, content: "Delegated check complete." },
          })) === 1
      );
      const launch = turns.find((turn) => turn.runId === delegated.runId)!;
      const continuation = turns.find(
        (turn) => turn.requestSource === "automation" && turn.content.includes("WP_CHILD_RESULT")
      )!;
      expect(continuation.contextSessionId).toBe(launch.contextSessionId);
      expect(continuation.sessionPath).not.toBeNull();
      expect(
        await app.prisma.inboxEvent.count({ where: { botId, type: "automation.wake_parent" } })
      ).toBe(2);
      expect(
        await app.prisma.channelMessage.count({ where: { content: "Must never appear" } })
      ).toBe(0);
      expect(errors).toEqual([]);
      expect(turns.some(turn => turn.subagentType === "computerUse")).toBe(true);
    } finally {
      releaseAutomation(); releaseParent(); releaseManagedChild();
      await worker?.stop();
      if (app) {
        await app.agentData.stopWatching();
        await app.prisma.taskSettings.deleteMany({ where: { id: "global" } });
        const children = await app.prisma.subagent.findMany({
          where: { parentBotId: botId },
          select: { childBotId: true },
        });
        await app.prisma.bot.deleteMany({
          where: { id: { in: [botId, ...children.map((child) => child.childBotId)] } },
        });
        if (channelId) await app.prisma.channel.deleteMany({ where: { id: channelId } });
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
