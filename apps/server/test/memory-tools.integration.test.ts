import { expect } from "bun:test";
import { join } from "node:path";
import { Effect } from "effect";
import { UPDATE_MEMORY_TOOL } from "@openteam/contracts";
import { AgentDataStore } from "@openteam/messaging";
import { InternalToolService } from "../src/services/internal-tool-service";
import { DurableStateService } from "../src/update-state";
import { dbIt, gate, type Db } from "./harness";

const SHARED_REFUSAL = "Not saved: shared_profile and shared_journal are the owner's memory across their assistants and are not written from a shared conversation.";

dbIt("memory tools save by type, report the reference outcomes, and keep shared memory out of group rooms", async h => {
  const { db: prisma, store } = h;
  const bot = await h.bot("Memory tool route"), peer = await h.bot("Peer", {}, { dm: false });
  const botId = bot.id, conversationId = bot.conversationId;
  h.onClose(() => prisma.memoryFact.deleteMany({ where: { writtenByBotId: { in: [botId, peer.id] } } }));
  const group = await h.channel({ kind: "group", name: "Tool room", members: { create: [{ botId, ordinal: 0 }, { botId: peer.id, ordinal: 1 }] } });
  const service = new InternalToolService(prisma, { agentData: store } as never, new DurableStateService(prisma, {} as never, store, {} as never), async () => {}, {} as never, {} as never, {} as never, {} as never);
  const runIn = async (channelId: string) => {
    const run = await h.run(bot, { channelId });
    return { id: run.id, call: (tool: string, args: unknown, callId: string = crypto.randomUUID()) =>
      Effect.runPromise(service.execute({ runId: run.id, botId, conversationId, channelId, deliveryId: null, tool, arguments: args, callId })) };
  };
  {
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
      expect((await room.call("RecallMemory", { query: "COBALT" }) as string).replace(/ \[id: [^\]]+\]/g, "")).toBe(
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
      const home = await runIn(bot.channelId!);
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

      // Corrections are atomic tool operations; recall supplies the stable revision id.
      await home.call("UpdateMemory", { action: "write", type: "profile", fact: "My favourite football player is Ronaldo." });
      const old = await prisma.memoryFact.findFirstOrThrow({ where: { namespace: `agent:${botId}`, fact: "My favourite football player is Ronaldo." } });
      const corrected = { action: "replace", type: "profile", id: old.id, fact: "My favourite player is now Messi." };
      const correctionCallId = crypto.randomUUID();
      const result = await home.call("UpdateMemory", corrected, correctionCallId);
      expect(result).toContain("Corrected in your memory (profile)");
      expect(await home.call("UpdateMemory", corrected, correctionCallId)).toBe(result);
      const recalled = await home.call("RecallMemory", { query: "favourite football player", limit: 1 });
      expect(recalled).toContain("Messi");
      expect(recalled).not.toContain("Ronaldo");
      expect(await home.call("RecallMemory", { query: "favourite", includeHistory: true })).toContain("superseded");
      await expect(home.call("UpdateMemory", { ...corrected, id: undefined })).rejects.toThrow("id");
      expect(await room.call("UpdateMemory", { ...corrected, type: "shared_profile" })).toBe(SHARED_REFUSAL);
      expect(await room.call("RecallMemory", { query: "Lyon", includeHistory: true })).not.toContain("shared_profile");

      await expect(room.call("RecallMemory", { query: " " })).rejects.toThrow("String must contain at least 1 character");
      await expect(room.call("RequestMemory", { query: "COBALT" })).rejects.toThrow("Unknown tool");
      await expect(room.call("update_state", { target: "memory", ...request })).rejects.toThrow("Unknown tool update_state");
      await prisma.run.update({ where: { id: room.id }, data: { status: "completed" } });
      await expect(room.call("RecallMemory", { query: "COBALT" })).rejects.toThrow("not active");
      const schema = UPDATE_MEMORY_TOOL.inputSchema as { properties: { type: { enum: string[] } } };
      expect(schema.properties.type.enum).toEqual(["profile", "journal", "shared_profile", "shared_journal"]);
  }
});

const receiptStatus = async (db: Db, botId: string, callId: string) =>
  (await db.idempotencyRecord.findUniqueOrThrow({ where: { scope_key: { scope: `state:${botId}`, key: callId } } })).status;

dbIt("retrying a correction after a lost tool receipt reuses the committed revision", async h => {
  const { db, store } = h;
  const { id: botId } = await h.bot("Receipt recovery", {}, { dm: false });
  h.onClose(() => db.idempotencyRecord.deleteMany({ where: { scope: `state:${botId}` } }));
  h.onClose(() => db.memoryFact.deleteMany({ where: { writtenByBotId: botId } }));
  const old = await store.writeMemory(botId, { scope: "agent", tier: "profile", fact: "Preferred editor is Vim." });
  const args = { action: "replace", type: "profile", id: old.id!, fact: "Preferred editor is Emacs." };
  const callId = crypto.randomUUID();
  const interrupted = new AgentDataStore(db, { root: join(h.dir, "data"), workspaceRoot: h.dir });
  interrupted.projectBot = async () => { throw new Error("simulated interruption before receipt commit"); };
  await expect(new DurableStateService(db, {} as never, interrupted, {} as never).executeTool(botId, callId, "UpdateMemory", args)).rejects.toThrow("simulated interruption");
  const active = await db.memoryFact.findFirstOrThrow({ where: { namespace: `agent:${botId}`, supersededAt: null } });
  expect(active.fact).toBe(args.fact);
  const revision = (await db.bot.findUniqueOrThrow({ where: { id: botId } })).memoryRevision;
  const events = await db.event.count({ where: { topic: "memory.changed", entityId: botId } });
  const recovered = new DurableStateService(db, {} as never, store, {} as never);
  const result = await recovered.executeTool(botId, callId, "UpdateMemory", args);
  expect(result).toMatchObject({ id: active.id, saved: true });
  expect(await recovered.executeTool(botId, callId, "UpdateMemory", args)).toEqual(result);
  expect(await db.memoryFact.count({ where: { writtenByBotId: botId } })).toBe(2);
  expect((await db.bot.findUniqueOrThrow({ where: { id: botId } })).memoryRevision).toBe(revision);
  expect(await db.event.count({ where: { topic: "memory.changed", entityId: botId } })).toBe(events);
  expect(await receiptStatus(db, botId, callId)).toBe("completed");
});

dbIt("simultaneous identical memory tool calls do not expose database uniqueness failures", async h => {
  const { db } = h;
  const { id: botId } = await h.bot("Concurrent receipt", {}, { dm: false });
  h.onClose(() => db.idempotencyRecord.deleteMany({ where: { scope: `state:${botId}` } }));
  h.onClose(() => db.memoryFact.deleteMany({ where: { writtenByBotId: botId } }));
  const callId = crypto.randomUUID(), contenders = 4, allRead = gate();
  let reads = 0;
  // Hold every contender after it finds no receipt, so all of them race to create one.
  const racing = new Proxy(db, { get(owner, key) {
    if (key !== "idempotencyRecord") return Reflect.get(owner, key);
    return { ...owner.idempotencyRecord, findUnique: async (args: any) => {
      const result = await owner.idempotencyRecord.findUnique(args);
      if (args.where?.scope_key?.key === callId && result === null) {
        if (++reads === contenders) allRead.resolve();
        await allRead.promise;
      }
      return result;
    } };
  } }) as Db;
  const store = new AgentDataStore(racing, { root: join(h.dir, "data"), workspaceRoot: h.dir });
  const args = { action: "write", type: "profile", fact: "Prefers tea with breakfast." };
  try {
    const attempts = await Promise.allSettled(Array.from({ length: contenders }, () =>
      new DurableStateService(racing, {} as never, store, {} as never).executeTool(botId, callId, "UpdateMemory", args)));
    expect(reads).toBe(contenders);
    expect(attempts.flatMap(result => result.status === "rejected" && result.reason?.status !== 409 ? [String(result.reason?.code ?? result.reason)] : [])).toEqual([]);
  } finally { allRead.resolve(); }
  expect(await db.memoryFact.count({ where: { writtenByBotId: botId } })).toBe(1);
  expect(await receiptStatus(db, botId, callId)).toBe("completed");
  const record = await db.idempotencyRecord.findUniqueOrThrow({ where: { scope_key: { scope: `state:${botId}`, key: callId } } });
  expect(await new DurableStateService(db, {} as never, h.store, {} as never).executeTool(botId, callId, "UpdateMemory", args) as unknown).toEqual(record.response);
});
