import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore, AgentMessaging, saveSilentAutomationResult } from "@openteam/messaging";
import { AUTOMATION_PARENT_ONLY_TOOLS } from "@openteam/contracts";
import { InternalToolService } from "../src/services/internal-tool-service";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
test.skipIf(!databaseUrl)(
  "WakeParent atomically queues once; silent results survive restart and acknowledge only delivered audience receipts",
  async () => {
    const prisma = createPrismaClient(databaseUrl!);
    const root = await mkdtemp(join(tmpdir(), "wake-parent-db-"));
    const botId = crypto.randomUUID(),
      conversationId = crypto.randomUUID();
    const store = new AgentDataStore(prisma, { root: join(root, "data"), workspaceRoot: root });
    const scheduled: unknown[] = [];
    const messaging = new AgentMessaging(
      prisma,
      {
        send: async (...args: unknown[]) => {
          scheduled.push(args);
        },
      } as never,
      store
    );
    const makeService = (host = messaging) =>
      new InternalToolService(
        prisma,
        host,
        {} as never,
        async () => {},
        {} as never,
        {} as never,
        {} as never,
        {} as never
      );
    const channels: string[] = [];
    try {
      await prisma.bot.create({
        data: {
          id: botId,
          name: "Automation parent",
          status: "active",
          onboardingStatus: "completed",
          defaultDirectory: root,
          conversation: { create: { id: conversationId } },
        },
      });
      await store.initializeBot(botId);
      await store.writeRootSettings({});
      for (const name of ["Parent DM", "Different room"]) {
        const channel = await prisma.channel.create({
          data: {
            kind: name === "Parent DM" ? "bot_dm" : "group",
            name,
            members: { create: { botId, ordinal: 0 } },
          },
        });
        channels.push(channel.id);
      }
      const channelId = channels[0]!;
      const audience = await store.resolveMemoryConversation(botId, channelId);
      const otherAudience = await store.resolveMemoryConversation(botId, channels[1]!);
      const createRun = async (origin: "routine" | "user" = "routine") =>
        prisma.run.create({
          data: {
            botId,
            conversationId,
            channelId,
            origin,
            userMessageId: crypto.randomUUID(),
            status: "running",
            memoryConversationId: audience.id,
          },
        });
      const run = await createRun();
      const call = (runId: string, tool: string, args: unknown, service = makeService()) =>
        Effect.runPromise(
          service.execute({
            botId,
            conversationId,
            channelId,
            deliveryId: null,
            runId,
            tool,
            arguments: args,
            callId: crypto.randomUUID(),
          })
        );
      for (const tool of AUTOMATION_PARENT_ONLY_TOOLS)
        await expect(call(run.id, tool, {})).rejects.toThrow("Use WakeParent");
      const ordinary = await createRun("user");
      await expect(call(ordinary.id, "WakeParent", { message: "Wrong mode" })).rejects.toThrow(
        "active automation"
      );
      for (const message of ["", "  ", "x".repeat(200_001)])
        await expect(call(run.id, "WakeParent", { message })).rejects.toThrow();
      expect(await prisma.automationResult.count({ where: { run: { botId } } })).toBe(0);
      const handoff =
        "Deployment failed in staging. Tell the user that tests failed; do not deploy.";
      const receipts = await Promise.all(
        Array.from({ length: 4 }, () => call(run.id, "WakeParent", { message: handoff }))
      );
      for (const receipt of receipts) expect(receipt).toEqual(receipts[0]);
      expect(receipts[0]).toMatchObject({ woken: true });
      expect(scheduled).toHaveLength(1);
      expect(
        await prisma.inboxEvent.count({ where: { type: "automation.wake_parent", botId } })
      ).toBe(1);
      const result = await prisma.automationResult.findUniqueOrThrow({ where: { runId: run.id } });
      expect(result.message).toBe(handoff);
      const wake = await prisma.run.findUniqueOrThrow({
        where: { id: result.wakeRunId! },
        include: { inboxEvents: true },
      });
      expect(wake).toMatchObject({
        botId,
        channelId,
        origin: "background_revival",
        status: "queued",
      });
      expect(JSON.stringify(wake.inboxEvents[0]?.payload)).toContain(handoff);
      expect(await prisma.channelMessage.count({ where: { sourceRunId: run.id } })).toBe(0);
      // A new service instance and a changed call id/body must not redeliver or rewrite the committed handoff.
      expect(
        await call(
          run.id,
          "WakeParent",
          { message: "Do not replace the original" },
          makeService(new AgentMessaging(prisma, messaging.boss, store))
        )
      ).toEqual(receipts[0]);
      expect(
        (await prisma.automationResult.findUniqueOrThrow({ where: { runId: run.id } })).message
      ).toBe(handoff);
      await expect(call(run.id, "TodoWrite", { todos: [] })).rejects.toThrow(
        "already handed control"
      );
      const addFinal = async (runId: string, content: string) => {
        const message = await prisma.message.create({
          data: {
            botId,
            conversationId,
            runId,
            role: "assistant",
            status: "completed",
            content,
            createdAt: new Date("2026-09-14T12:00:00Z"),
            updatedAt: new Date("2026-09-14T12:00:00Z"),
          },
        });
        await prisma.event.create({
          data: {
            topic: "run_item.completed",
            entityId: runId,
            payload: { runId, item: { id: message.id, type: "agentMessage", text: content } },
          },
        });
        return message;
      };
      await addFinal(run.id, "Do not overwrite the explicit handoff");
      await prisma.$transaction((tx) => saveSilentAutomationResult(tx, run.id));
      expect(
        (await prisma.automationResult.findUniqueOrThrow({ where: { runId: run.id } })).message
      ).toBe(handoff);

      const silent = await createRun();
      await addFinal(silent.id, "Earlier progress is private scratch space.");
      await addFinal(silent.id, "All systems unchanged; record the check silently.");
      await prisma.$transaction((tx) => saveSilentAutomationResult(tx, silent.id));
      expect(scheduled).toHaveLength(1);
      const home = await prisma.contextSession.create({
        data: { botId, scope: "home", scopeId: conversationId },
      });
      const automation = await prisma.contextSession.create({
        data: { botId, scope: "automation", scopeId: silent.id },
      });
      const restarted = new AgentMessaging(prisma, messaging.boss, store);
      const prompt = await restarted.platformPrompt(botId, home.id, "", audience.id);
      expect(prompt.ambientContext).toContain("All systems unchanged");
      expect(prompt.ambientContext).not.toContain("Earlier progress");
      expect(prompt.ambientContext).not.toContain(handoff);
      expect(
        (await restarted.platformPrompt(botId, home.id, "", otherAudience.id)).ambientContext ?? ""
      ).not.toContain("All systems unchanged");
      const routinePrompt = await restarted.platformPrompt(botId, automation.id, "", audience.id);
      expect(routinePrompt.instructions).toContain("WakeParent is the only route");
      expect(routinePrompt.ambientContext).toBeNull();
      await restarted.acknowledgePlatformPrompt(botId, automation.id, routinePrompt);
      expect(
        (await prisma.automationResult.findUniqueOrThrow({ where: { runId: silent.id } }))
          .acknowledgedAt
      ).toBeNull();
      const later = await createRun();
      await addFinal(later.id, "A newer silent result arrived after the prompt was built.");
      await prisma.$transaction((tx) => saveSilentAutomationResult(tx, later.id));
      await restarted.acknowledgePlatformPrompt(botId, home.id, prompt);
      const refreshed = await restarted.platformPrompt(botId, home.id, "", audience.id);
      expect(refreshed.ambientContext).not.toContain("All systems unchanged");
      expect(refreshed.ambientContext).toContain("A newer silent result");
      // A scheduling failure rolls back both result and parent inbox, allowing a safe retry.
      const failed = await createRun();
      const failing = new AgentMessaging(
        prisma,
        {
          send: async () => {
            throw new Error("queue fixture failed");
          },
        } as never,
        store
      );
      await expect(
        call(
          failed.id,
          "WakeParent",
          { message: "Retry after storage recovers" },
          makeService(failing)
        )
      ).rejects.toThrow("queue fixture failed");
      expect(await prisma.automationResult.findUnique({ where: { runId: failed.id } })).toBeNull();
      expect(
        await prisma.inboxEvent.findUnique({
          where: { idempotencyKey: `automation:${failed.id}:wake-parent` },
        })
      ).toBeNull();
      expect(
        await call(failed.id, "WakeParent", { message: "Retry after storage recovers" })
      ).toMatchObject({ woken: true });
      // Background shells resume the original automation context, including after restart.
      const shellRun = await createRun();
      const completion = {
        id: "shell-fixture",
        scope: botId,
        automationRunId: shellRun.id,
        channelId,
        outputPath: "/tmp/fixture.log",
        exitCode: 0,
      };
      await restarted.completeShell(completion);
      const shellWake = await prisma.inboxEvent.findUniqueOrThrow({
        where: { idempotencyKey: `shell-completion:${botId}:shell-fixture` },
        include: { run: true },
      });
      expect(shellWake.run.origin).toBe("routine");
      expect(shellWake.payload).toMatchObject({ automationContextRunId: shellRun.id });
      expect(await restarted.completeShell(completion)).toMatchObject({ duplicate: true });
      // A continuation hands off once for the whole automation, not once per callback.
      await prisma.run.update({ where: { id: shellWake.runId }, data: { status: "running" } });
      const continued = await call(shellWake.runId, "WakeParent", {
        message: "Shell completed; notify the user.",
      });
      expect(continued).toMatchObject({ woken: true });
      expect(
        (await prisma.automationResult.findUniqueOrThrow({ where: { runId: shellRun.id } })).message
      ).toBe("Shell completed; notify the user.");
      expect(
        await call(shellRun.id, "WakeParent", { message: "Duplicate from original turn" })
      ).toEqual(continued);
      await expect(call(shellWake.runId, "TodoWrite", { todos: [] })).rejects.toThrow(
        "already handed control"
      );
      await restarted.completeShell({ ...completion, id: "shell-after-handoff" });
      expect(
        (
          await prisma.inboxEvent.findUniqueOrThrow({
            where: { idempotencyKey: `shell-completion:${botId}:shell-after-handoff` },
            include: { run: true },
          })
        ).run.origin
      ).toBe("background_revival");
    } finally {
      await prisma.bot.deleteMany({ where: { id: botId } });
      await prisma.channel.deleteMany({ where: { id: { in: channels } } });
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000
);
