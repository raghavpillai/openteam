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
const SHARED_REFUSAL =
  "Not saved: shared_profile and shared_journal are the owner's memory across their assistants and are not written from a shared conversation.";

databaseTest(
  "memory tools save by type, report the reference outcomes, and keep shared memory out of group rooms",
  async () => {
    const prisma = createPrismaClient(databaseUrl!);
    const root = await mkdtemp(join(tmpdir(), "memory-tool-route-"));
    const botId = crypto.randomUUID();
    const peerId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const channelIds: string[] = [];
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
      const group = await prisma.channel.create({
        data: {
          kind: "group",
          name: "Tool room",
          members: { create: [{ botId, ordinal: 0 }, { botId: peerId, ordinal: 1 }] },
        },
      });
      const personal = await prisma.channel.create({
        data: { name: "Personal memory fixture", kind: "bot_dm", directKey: `bot:${botId}`, members: { create: { botId, ordinal: 0 } } },
      });
      channelIds.push(group.id, personal.id);
      await store.initializeBot(botId);
      const state = new DurableStateService(prisma, {} as never, store, {} as never);
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
      const runIn = async (channelId: string) => {
        const run = await prisma.run.create({
          data: { botId, conversationId, channelId, userMessageId: crypto.randomUUID(), status: "running" },
        });
        return {
          id: run.id,
          call: (tool: string, args: unknown, callId = crypto.randomUUID()) =>
            Effect.runPromise(
              service.execute({ runId: run.id, botId, conversationId, channelId, deliveryId: null, tool, arguments: args, callId })
            ),
        };
      };

      // A group room: the bot's own memory works; the owner's shared memory is off limits.
      const room = await runIn(group.id);
      const request = { action: "write", type: "profile", fact: "COBALT delivery uses amber." };
      const callId = crypto.randomUUID();
      const saved = await room.call("UpdateMemory", request, callId);
      expect(saved).toBe(`Remembered in your memory (profile): ${request.fact}`);
      expect(await room.call("UpdateMemory", request, callId)).toEqual(saved);
      expect(
        await prisma.memoryFact.findMany({
          where: { namespace: `agent:${botId}` },
          select: { fact: true, scope: true, tier: true, origin: true, turnId: true },
        })
      ).toEqual([{ fact: request.fact, scope: "agent", tier: "profile", origin: "tool", turnId: room.id }]);
      expect(await room.call("UpdateMemory", request)).toBe(
        "Not saved: nothing was saved to your memory. The fact was empty or already recorded. Call RecallMemory to see what is already there."
      );
      expect(await room.call("UpdateMemory", { action: "write", type: "journal", fact: "Shipped the COBALT beta." })).toBe(
        "Remembered in your memory (journal): Shipped the COBALT beta."
      );
      expect(await room.call("UpdateMemory", { ...request, type: "shared_profile", fact: "Lives in Lyon." })).toBe(SHARED_REFUSAL);
      expect(await room.call("UpdateMemory", { action: "forget", type: "shared_journal", fact: "Lives in Lyon." })).toBe(SHARED_REFUSAL);
      await store.writeMemory(botId, { scope: "user", tier: "profile", fact: "Personal heliotrope choice." });
      expect(await room.call("RecallMemory", { query: "COBALT" })).toBe(
        [
          'Top 2 matches for "COBALT" in your memory and the shared user memory (2 facts searched):',
          `- (${new Date().toISOString().slice(0, 10)}) [journal] Shipped the COBALT beta.`,
          `- (${new Date().toISOString().slice(0, 10)}) [profile] COBALT delivery uses amber.`,
        ].join("\n")
      );
      expect(await room.call("RecallMemory", { query: "heliotrope" })).toStartWith("No facts in your memory");
      expect(await room.call("UpdateMemory", { action: "forget", type: "profile", fact: request.fact })).toBe(
        `Forgot from your memory: ${request.fact}`
      );
      expect(await room.call("UpdateMemory", { action: "forget", type: "profile", fact: request.fact })).toBe(
        "Not saved: no fact with exactly that text is recorded in your memory. Call RecallMemory for the exact wording first."
      );
      const multiline = "Normalized\n  spacing\t" + "x".repeat(520);
      expect(await room.call("UpdateMemory", { ...request, fact: multiline })).toBe(
        `Remembered in your memory (profile): ${("Normalized spacing " + "x".repeat(520)).slice(0, 500)}`
      );
      await expect(room.call("UpdateMemory", { ...request, type: "note" })).rejects.toThrow(
        "UpdateMemory: pick the memory type it belongs in: profile, journal, shared_profile, shared_journal."
      );
      await expect(room.call("UpdateMemory", { action: "write", fact: "No type." })).rejects.toThrow("pick the memory type");

      // The owner's own chat writes the bot's shard of shared user memory.
      const home = await runIn(personal.id);
      const shared = { action: "write", type: "shared_profile", fact: "Lives in Lyon." };
      expect(await home.call("UpdateMemory", shared)).toBe("Remembered in shared user memory (shared_profile): Lives in Lyon.");
      expect(await home.call("UpdateMemory", shared)).toBe(
        "Not saved: nothing was saved to shared user memory. The fact was empty or already recorded. Call RecallMemory to see what is already there."
      );
      expect(await home.call("UpdateMemory", { action: "write", type: "shared_journal", fact: "Started at Acme." })).toBe(
        "Remembered in shared user memory (shared_journal): Started at Acme."
      );
      expect(
        await prisma.memoryFact.findMany({
          where: { namespace: `user:agent:${botId}`, fact: { in: ["Lives in Lyon.", "Started at Acme."] } },
          orderBy: { sourceOrdinal: "asc" },
          select: { fact: true, scope: true, tier: true },
        })
      ).toEqual([
        { fact: "Lives in Lyon.", scope: "user", tier: "profile" },
        { fact: "Started at Acme.", scope: "user", tier: "log" },
      ]);
      expect(await home.call("RecallMemory", { query: "Lyon Acme" })).toContain("[shared_profile via Memory tool route] Lives in Lyon.");
      expect(await home.call("RecallMemory", { query: "Acme" })).toContain("[shared_journal via Memory tool route] Started at Acme.");
      expect(await home.call("RecallMemory", { query: "heliotrope" })).toContain("[shared_profile via Memory tool route] Personal heliotrope choice.");
      expect(await home.call("UpdateMemory", { action: "forget", type: "shared_profile", fact: "lives in  LYON." })).toBe(
        "Forgot from shared user memory: lives in LYON."
      );
      expect(await home.call("UpdateMemory", { action: "forget", type: "shared_profile", fact: "Lives in Lyon." })).toBe(
        "Not saved: no fact with exactly that text is recorded in shared user memory. Call RecallMemory for the exact wording first."
      );

      await expect(room.call("RecallMemory", { query: " " })).rejects.toThrow("String must contain at least 1 character");
      await expect(room.call("RequestMemory", { query: "COBALT" })).rejects.toThrow("Unknown tool");
      await expect(room.call("update_state", { target: "memory", ...request })).rejects.toThrow("Unknown tool update_state");
      await prisma.run.update({ where: { id: room.id }, data: { status: "completed" } });
      await expect(room.call("RecallMemory", { query: "COBALT" })).rejects.toThrow("not active");
      const schema = UPDATE_MEMORY_TOOL.inputSchema as { properties: { type: { enum: string[] } } };
      expect(schema.properties.type.enum).toEqual(["profile", "journal", "shared_profile", "shared_journal"]);
    } finally {
      await prisma.idempotencyRecord.deleteMany({ where: { scope: `state:${botId}` } });
      await prisma.memoryFact.deleteMany({ where: { writtenByBotId: { in: [botId, peerId] } } });
      await prisma.channel.deleteMany({ where: { id: { in: channelIds } } });
      await prisma.bot.deleteMany({ where: { id: { in: [botId, peerId] } } });
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  }
);
