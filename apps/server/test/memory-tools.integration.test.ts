import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "@openteam/messaging";
import { InternalToolService } from "../src/services/internal-tool-service";
import { DurableStateService } from "../src/update-state";
import { UPDATE_MEMORY_TOOL } from "@openteam/contracts";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const databaseTest = databaseUrl ? test : test.skip;

databaseTest(
  "real memory tool dispatch uses the run audience, persists, recalls, forgets, and enforces restrictions",
  async () => {
    const prisma = createPrismaClient(databaseUrl!);
    const root = await mkdtemp(join(tmpdir(), "memory-tool-route-"));
    const botId = crypto.randomUUID();
    const peerId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    let channelId = "";
    let personalChannelId = "";
    const store = new AgentDataStore(prisma, { root: join(root, "data"), workspaceRoot: root });
    try {
      await prisma.bot.create({
        data: {
          id: botId,
          name: "Memory tool route",
          status: "active",
          onboardingStatus: "completed",
          defaultDirectory: root,
          conversation: { create: { id: conversationId } },
        },
      });
      await prisma.bot.create({
        data: { id: peerId, name: "Peer", status: "active", defaultDirectory: root },
      });
      const channel = await prisma.channel.create({
        data: {
          kind: "group",
          name: "Tool room",
          members: {
            create: [
              { botId, ordinal: 0 },
              { botId: peerId, ordinal: 1 },
            ],
          },
        },
      });
      channelId = channel.id;
      await store.initializeBot(botId);
      const context = await store.resolveMemoryConversation(botId, channelId);
      await prisma.run.create({
        data: {
          id: runId,
          botId,
          conversationId,
          channelId,
          userMessageId: crypto.randomUUID(),
          status: "running",
          memoryConversationId: context.id,
        },
      });
      const state = new DurableStateService(
        prisma,
        {} as never,
        store,
        {} as never
      );
      const service = new InternalToolService(
        prisma,
        { agentData: store } as never,
        state,
        async () => {},
        {} as never,
        {} as never,
        {} as never,
        {} as never
      );
      const call = (tool: string, args: unknown, callId = crypto.randomUUID()) =>
        Effect.runPromise(
          service.execute({
            runId,
            botId,
            conversationId,
            channelId,
            deliveryId: null,
            tool,
            arguments: args,
            callId,
          })
        );
      const request = {
        action: "write",
        tier: "profile",
        fact: "COBALT delivery uses amber.",
      };
      const callId = crypto.randomUUID();
      const saved = await call("UpdateMemory", request, callId);
      expect(saved).toBe(`Remembered in your memory (profile): ${request.fact}`);
      expect(await call("UpdateMemory", request, callId)).toEqual(saved);
      expect(await prisma.memoryFact.count({ where: { memoryConversationId: context.id } })).toBe(
        0
      );
      expect(await call("RecallMemory", { query: "COBALT", scope: "agent" })).toContain(
        "[profile]"
      );
      expect(await call("UpdateMemory", request)).toBe("Not saved — nothing was saved to your memory — the fact was empty or already recorded. Call RecallMemory to see what is already there.");
      expect(await prisma.memoryFact.count({ where: { namespace: `agent:${botId}`, fact: request.fact } })).toBe(1);
      const cached = await prisma.idempotencyRecord.findUniqueOrThrow({ where: { scope_key: { scope: `state:${botId}`, key: callId } } });
      expect(cached.response).toMatchObject({ saved: true, scope: "agent", fact: request.fact });
      await expect(call("UpdateMemory", { ...request, scope: "conversation", fact: "ORBIT914V relay key is COPPER-8357." })).rejects.toThrow();
      expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId, fact: { contains: "ORBIT914V" } } })).toBe(0);
      // Tool arguments cannot substitute their own audience or memory owner.
      const personal = await store.resolveMemoryConversation(botId);
      await store.writeMemory(botId, {
        scope: "user",
        tier: "profile",
        fact: "Personal heliotrope choice.",
      });
      expect(
        await call("RecallMemory", {
          query: "heliotrope",
          scope: "user",
          memoryConversationId: personal.id,
        })
      ).not.toContain("Personal heliotrope choice.");
      await expect(call("UpdateMemory", { ...request, scope: "user" })).rejects.toThrow(
        "cannot be written"
      );
      const shared = await call("UpdateMemory", {
        ...request,
        scope: "agent",
        fact: "Team COBALT policy.",
      });
      expect(shared).toBe("Remembered in your memory (profile): Team COBALT policy.");
      // Simulate a room copy created by the pre-parity automatic learner.
      await store.writeMemory(botId, { scope: "conversation", memoryConversationId: context.id, tier: "profile", fact: request.fact });
      expect(
        await call("UpdateMemory", { action: "forget", fact: request.fact })
      ).toBe(`Forgot from your memory: ${request.fact}`);
      expect(await call("RecallMemory", { query: "delivery" })).not.toContain("uses amber");
      expect(await prisma.memoryFact.count({ where: { writtenByBotId: botId, scope: { in: ["agent", "conversation"] }, fact: request.fact } })).toBe(0);
      expect(await call("UpdateMemory", { action: "forget", fact: request.fact })).toBe("Not saved — no fact with exactly that text is recorded in your memory. Call RecallMemory for the exact wording first.");
      const forgotten = await call("UpdateMemory", {
        action: "forget",
        scope: "agent",
        fact: "Team COBALT policy.",
      });
      expect(forgotten).toBe("Forgot from your memory: Team COBALT policy.");
      const multiline = "Normalized\n  spacing\t" + "x".repeat(520);
      expect(await call("UpdateMemory", { ...request, fact: multiline })).toBe(`Remembered in your memory (profile): ${("Normalized spacing " + "x".repeat(520)).slice(0, 500)}`);
      expect(await call("UpdateMemory", { ...request, tier: "note", fact: "Ephemeral choice." })).toBe("Remembered in your memory (note): [note] Ephemeral choice.");
      const personalChannel = await prisma.channel.create({ data: { name: "Personal memory fixture", kind: "bot_dm", directKey: `bot:${botId}`, members: { create: { botId, ordinal: 0 } } } });
      personalChannelId = personalChannel.id;
      const personalContext = await store.resolveMemoryConversation(botId, personalChannel.id);
      const personalRun = await prisma.run.create({ data: {
        botId, conversationId, channelId: personalChannel.id, userMessageId: crypto.randomUUID(), status: "running", memoryConversationId: personalContext.id,
      } });
      const personalCall = (args: unknown) => Effect.runPromise(service.execute({
        runId: personalRun.id, botId, conversationId, channelId: personalChannel.id, deliveryId: null,
        tool: "UpdateMemory", arguments: args, callId: crypto.randomUUID(),
      }));
      expect(await personalCall({ ...request, scope: "user" })).toBe(`Remembered in shared user memory (profile): ${request.fact}`);
      expect(await personalCall({ ...request, scope: "user" })).toBe("Not saved — nothing was saved to shared user memory — the fact was empty or already recorded. Call RecallMemory to see what is already there.");
      expect(await personalCall({ action: "forget", scope: "user", fact: request.fact })).toBe(`Forgot from shared user memory: ${request.fact}`);
      expect(await personalCall({ action: "forget", scope: "user", fact: request.fact })).toBe("Not saved — no fact with exactly that text is recorded in shared user memory. Call RecallMemory for the exact wording first.");
      await expect(call("RecallMemory", { query: " " })).rejects.toThrow("String must contain at least 1 character");
      await expect(call("RequestMemory", { query: "COBALT" })).rejects.toThrow("Unknown tool");
      await expect(call("update_state", { target: "memory", ...request })).rejects.toThrow("Unknown tool update_state");
      await prisma.run.update({ where: { id: runId }, data: { status: "completed" } });
      await expect(call("RecallMemory", { query: "COBALT" })).rejects.toThrow("not active");
      const schema = UPDATE_MEMORY_TOOL.inputSchema as { properties: { scope: { enum: string[] } } };
      expect(schema.properties.scope.enum).toEqual(["agent", "user"]);
    } finally {
      await prisma.idempotencyRecord.deleteMany({ where: { scope: `state:${botId}` } });
      await prisma.memoryFact.deleteMany({ where: { writtenByBotId: { in: [botId, peerId] } } });
      if (channelId) await prisma.channel.deleteMany({ where: { id: channelId } });
      if (personalChannelId) await prisma.channel.deleteMany({ where: { id: personalChannelId } });
      await prisma.bot.deleteMany({ where: { id: { in: [botId, peerId] } } });
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  }
);
