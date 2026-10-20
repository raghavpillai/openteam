import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "../src/agent-data";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const databaseTest = databaseUrl ? test : test.skip;
async function fixture(options: NonNullable<ConstructorParameters<typeof AgentDataStore>[1]> = {}) {
  const prisma = createPrismaClient(databaseUrl!);
  const root = await mkdtemp(join(tmpdir(), "memory-scopes-"));
  const bots = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const botId = bots[0]!;
  const store = new AgentDataStore(prisma, {
    root: join(root, "data"),
    workspaceRoot: root,
    ...options,
  });
  for (const [index, id] of bots.entries()) {
    await prisma.bot.create({
      data: {
        id,
        name: `Memory scope ${index}`,
        status: "active",
        onboardingStatus: "completed",
        defaultDirectory: root,
      },
    });
    await store.initializeBot(id);
  }
  const channels: string[] = [];
  for (const members of [
    [bots[0]!, bots[1]!],
    [bots[1]!, bots[0]!],
    [bots[0]!, bots[2]!],
  ]) {
    const channel = await prisma.channel.create({
      data: {
        kind: "group",
        name: "Memory test room",
        members: { create: members.map((id, ordinal) => ({ botId: id, ordinal })) },
      },
    });
    channels.push(channel.id);
  }
  const personal = await store.resolveMemoryConversation(botId);
  const rooms = await Promise.all(channels.map((id) => store.resolveMemoryConversation(botId, id)));
  const session = await prisma.contextSession.create({
    data: { botId, scope: "home", scopeId: botId },
  });
  return {
    prisma,
    root,
    bots,
    botId,
    channels,
    personal,
    rooms,
    session,
    store,
    async cleanup() {
      await prisma.channel.deleteMany({ where: { id: { in: channels } } });
      await prisma.memoryFact.deleteMany({ where: { writtenByBotId: { in: bots } } });
      await prisma.bot.deleteMany({ where: { id: { in: bots } } });
      await prisma.$disconnect();
      await rm(root, { recursive: true, force: true });
    },
  };
}

databaseTest(
  "legacy conversation memory keeps its bot and audience boundaries, with exact source tags",
  async () => {
    const f = await fixture();
    try {
      const [room, sibling, different] = f.rooms;
      expect(room!.defaultScope).toBe("agent");
      expect(f.personal.defaultScope).toBe("agent");
      expect(sibling!.audienceKey).toBe(room!.audienceKey);
      await f.store.writeMemory(f.botId, {
        scope: "conversation",
        memoryConversationId: room!.id,
        tier: "profile",
        fact: "COBALT launch uses amber.",
      });
      expect(
        await f.store.recallMemory(f.botId, { query: "COBALT", scope: "agent" }, room!.id)
      ).toContain("[profile, this conversation]");
      expect(await f.store.recallMemory(f.botId, { query: "COBALT" }, sibling!.id)).toContain(
        `[profile, via session ${room!.id}]`
      );
      expect(await f.store.recallMemory(f.botId, { query: "COBALT" }, different!.id)).not.toContain(
        "uses amber"
      );
      expect(await f.store.recallMemory(f.botId, { query: "COBALT" }, f.personal.id)).not.toContain(
        "uses amber"
      );
      const peerContext = await f.store.resolveMemoryConversation(f.bots[1]!, f.channels[0]);
      expect(
        await f.store.recallMemory(f.bots[1]!, { query: "COBALT" }, peerContext.id)
      ).not.toContain("uses amber");
      expect(
        (
          await f.store.forgetMemory(f.botId, {
            scope: "conversation",
            memoryConversationId: sibling!.id,
            fact: "COBALT launch uses amber.",
          })
        ).forgotten
      ).toBe(false);
      const reopened = new AgentDataStore(f.prisma, { root: f.store.root, workspaceRoot: f.root });
      expect(await reopened.recallMemory(f.botId, { query: "COBALT" }, sibling!.id)).toContain(
        "uses amber"
      );
      await f.store.forgetMemory(f.botId, {
        scope: "conversation",
        memoryConversationId: room!.id,
        fact: "COBALT launch uses amber.",
      });
      expect(await reopened.recallMemory(f.botId, { query: "COBALT" }, sibling!.id)).not.toContain(
        "uses amber"
      );
    } finally {
      await f.cleanup();
    }
  }
);

databaseTest(
  "personal memory is refused in group tools and removed from a reused frozen prompt",
  async () => {
    const f = await fixture();
    try {
      await f.store.writeMemory(f.botId, {
        scope: "user",
        tier: "profile",
        fact: "Personal heliotrope preference.",
        memoryConversationId: f.personal.id,
      });
      const own = await f.store.promptContext(f.botId, f.session.id, f.personal.id);
      await f.store.preparePlatformSections(f.botId, f.session.id, 0, {
        memory: own.liveMemoryRender!,
      });
      expect(own.memoryRender).toContain("heliotrope");
      const room = f.rooms[0]!;
      await expect(
        f.store.writeMemory(f.botId, {
          scope: "user",
          tier: "profile",
          fact: "Group override",
          memoryConversationId: room.id,
        })
      ).rejects.toThrow("cannot be written");
      await expect(
        f.store.forgetMemory(f.botId, {
          scope: "user",
          fact: "Personal heliotrope preference.",
          memoryConversationId: room.id,
        })
      ).rejects.toThrow("cannot be written");
      expect(
        await f.store.recallMemory(f.botId, { query: "heliotrope", scope: "user" }, room.id)
      ).not.toContain("Personal heliotrope preference.");
      const group = await f.store.promptContext(f.botId, f.session.id, room.id);
      expect(group.memoryRender).not.toContain("heliotrope");
      const sections = await f.store.preparePlatformSections(f.botId, f.session.id, 0, {
        memory: group.liveMemoryRender!,
      });
      expect(sections.sections.memory).not.toContain("heliotrope");
      expect(group.liveMemoryRender).toContain('scope "agent" is team-wide');
      await expect(
        f.store.writeMemory(f.botId, {
          scope: "conversation",
          tier: "log",
          fact: "Missing context",
        })
      ).rejects.toThrow("active conversation");
      await expect(
        f.store.writeMemory(f.bots[1]!, {
          scope: "conversation",
          memoryConversationId: room.id,
          tier: "log",
          fact: "Wrong bot",
        })
      ).rejects.toThrow("does not belong");
    } finally {
      await f.cleanup();
    }
  }
);

databaseTest(
  "membership changes partition room memory and revoke old sibling visibility",
  async () => {
    const f = await fixture();
    try {
      const room = f.rooms[0]!,
        sibling = f.rooms[1]!;
      await f.store.writeMemory(f.botId, {
        scope: "conversation",
        memoryConversationId: room.id,
        tier: "log",
        fact: "COBALT before membership change.",
      });
      await f.prisma.channelMember.create({
        data: { channelId: f.channels[0]!, botId: f.bots[2]!, ordinal: 2 },
      });
      await f.store.writeGroupFilesForBot(f.botId);
      const changed = await f.store.resolveMemoryConversation(f.botId, f.channels[0]);
      expect(changed.id).not.toBe(room.id);
      expect(await f.store.recallMemory(f.botId, { query: "COBALT" }, changed.id)).not.toContain(
        "before membership"
      );
      expect(await f.store.recallMemory(f.botId, { query: "COBALT" }, sibling.id)).not.toContain(
        "before membership"
      );
      await expect(f.store.recallMemory(f.botId, { query: "COBALT" }, room.id)).rejects.toThrow(
        "audience changed"
      );
      await f.prisma.channelMember.delete({
        where: { channelId_botId: { channelId: f.channels[1]!, botId: f.botId } },
      });
      await expect(f.store.resolveMemoryConversation(f.botId, f.channels[1])).rejects.toThrow(
        "not a member"
      );
    } finally {
      await f.cleanup();
    }
  }
);

databaseTest(
  "RecallMemory scans archived files, refreshes manual edits, and merges shared writer duplicates",
  async () => {
    const f = await fixture();
    try {
      const room = f.rooms[0]!;
      const root = f.store.memoryDirectory(f.botId, "conversation", room.id);
      await mkdir(join(root, "log"), { recursive: true });
      await appendFile(join(root, "log", "2001-01.md"), "- (2001-01-01) Archived ZX-8 launch.\n");
      expect(await f.store.recallMemory(f.botId, { query: "ZX-8" }, room.id)).toContain(
        "2001-01-01"
      );
      await appendFile(join(root, "log", "2001-01.md"), "- (2001-01-02) Manually added AB-7.\n");
      expect(await f.store.recallMemory(f.botId, { query: "AB-7" }, room.id)).toContain(
        "Manually added"
      );
      await f.store.writeMemory(f.botId, {
        scope: "user",
        tier: "profile",
        fact: "Prefers amber diagrams.",
        at: new Date("2001-01-01"),
      });
      await f.store.writeMemory(f.bots[1]!, {
        scope: "user",
        tier: "profile",
        fact: "PREFERS AMBER DIAGRAMS.",
        at: new Date("2002-01-01"),
      });
      const shared = await f.store.recallMemory(
        f.botId,
        { query: "amber", scope: "user" },
        f.personal.id
      );
      expect(shared).toContain("Top 1 match");
      expect(shared).toContain("shared via Memory scope 1");
    } finally {
      await f.cleanup();
    }
  }
);

databaseTest(
  "bot-wide forget removes exact legacy copies and refreshes cached prompts",
  async () => {
    const f = await fixture();
    try {
      const fact = "ZEPHYR914Q calibration key is VIOLET-4628.";
      const episode = `[episode] Earlier we saved ${fact}`;
      await f.store.writeMemory(f.botId, { scope: "agent", tier: "profile", fact });
      for (const room of f.rooms) await f.store.writeMemory(f.botId, { scope: "conversation", memoryConversationId: room.id, tier: "profile", fact });
      await f.store.writeMemory(f.botId, { scope: "conversation", memoryConversationId: f.rooms[2]!.id, tier: "profile", fact: "Private unrelated room decision." });
      await f.store.writeMemory(f.botId, { scope: "agent", tier: "log", fact: episode });
      await f.store.writeMemory(f.botId, { scope: "user", tier: "profile", fact });
      await f.store.writeMemory(f.bots[1]!, { scope: "agent", tier: "profile", fact });
      const peerRoom = await f.store.resolveMemoryConversation(f.bots[1]!, f.channels[0]);
      await f.store.writeMemory(f.bots[1]!, { scope: "conversation", memoryConversationId: peerRoom.id, tier: "profile", fact });

      // Simulate an old database row and a prompt frozen by the old room policy.
      const room = f.rooms[0]!;
      await f.prisma.memoryConversation.update({ where: { id: room.id }, data: { defaultScope: "conversation" } });
      await f.store.promptContext(f.botId, f.session.id, room.id);
      await f.prisma.contextPromptSnapshot.update({ where: { contextSessionId: f.session.id }, data: {
        memoryAudienceKey: `${room.id}:${room.audienceKey}`, memoryEpoch: 0, memoryHasFacts: true,
        memoryRender: 'Stale guidance: scope "conversation" is the default.',
        promptSections: { memory: { compactionEpoch: 0, render: 'Stale guidance: scope "conversation" is the default.' } },
      } });
      expect((await f.store.getMemoryConversation(f.botId, room.id)).defaultScope).toBe("agent");
      const fresh = await f.store.promptContext(f.botId, f.session.id, room.id);
      expect(fresh.memoryRender).not.toContain('scope "conversation"');
      expect(fresh.memoryRender).toContain('[this conversation]');
      expect(fresh.memoryRender).not.toContain("Private unrelated");
      const sections = await f.store.preparePlatformSections(f.botId, f.session.id, 0, { memory: fresh.liveMemoryRender! });
      expect(sections.sections.memory).not.toContain("Stale guidance");

      const removed = await f.store.forgetMemory(f.botId, { scope: "agent", fact });
      expect(removed.forgotten).toBe(true);
      expect(await f.prisma.memoryFact.count({ where: { writtenByBotId: f.botId, scope: { in: ["agent", "conversation"] }, fact } })).toBe(0);
      expect(await f.prisma.memoryFact.count({ where: { writtenByBotId: f.bots[1]!, fact } })).toBe(2);
      expect(await f.prisma.memoryFact.count({ where: { writtenByBotId: f.botId, scope: "user", fact } })).toBe(1);
      expect(await f.store.recallMemory(f.botId, { query: "ZEPHYR914Q", scope: "agent" }, room.id)).toContain(episode);
      expect(await f.store.recallMemory(f.botId, { query: "Private unrelated", scope: "agent" }, f.personal.id)).not.toContain("room decision");
      expect(await f.store.recallMemory(f.botId, { query: "Private unrelated", scope: "agent" }, f.rooms[2]!.id)).toContain("room decision");
      const snapshot = await f.prisma.contextPromptSnapshot.findUniqueOrThrow({ where: { contextSessionId: f.session.id } });
      expect(snapshot.memoryEpoch).toBe(-1);
      expect(snapshot.memoryRender).toBe("");
      expect((await f.store.forgetMemory(f.botId, { scope: "agent", fact })).forgotten).toBe(false);
      // A legacy-only fact is also forgettable from the bot-wide tool.
      expect((await f.store.forgetMemory(f.botId, { scope: "agent", fact: "Private unrelated room decision." })).forgotten).toBe(true);
    } finally { await f.cleanup(); }
  }
);

databaseTest(
  "automatic extraction and episode buffers belong to the bot across rooms",
  async () => {
    const requests: Array<{ kind: string; prompt: string }> = [];
    const f = await fixture({
      memoryEpisodeInterval: 2,
      memoryInference: async (request) => {
        requests.push(request);
        return request.kind === "episode"
          ? "Worked on the COBALT launch."
          : "log: COBALT launch uses amber.";
      },
    });
    try {
      const [room, sibling, different] = f.rooms;
      await f.store.recordTurnMemory(f.botId, {
        memoryConversationId: room!.id,
        user: "For this room we chose amber for the COBALT launch.",
        assistant: "Recorded.",
      });
      await f.store.recordTurnMemory(f.botId, {
        memoryConversationId: different!.id,
        user: "For this other room we chose a separate launch plan.",
        assistant: "Recorded.",
      });
      expect(requests.filter((r) => r.kind === "episode")).toHaveLength(1);
      await f.store.recordTurnMemory(f.botId, {
        memoryConversationId: room!.id,
        user: "Continue developing the COBALT launch with the same amber palette.",
        assistant: "Done.",
      });
      const episode = requests.find((r) => r.kind === "episode")!;
      expect(episode.prompt).toContain("other room");
      expect(
        (await f.prisma.memoryConversation.findUniqueOrThrow({ where: { id: different!.id } }))
          .episodeTurns
      ).toHaveLength(0);
      expect(
        (await f.prisma.bot.findUniqueOrThrow({ where: { id: f.botId } })).episodePending
      ).toBe(1);
      expect(await f.store.recallMemory(f.botId, { query: "COBALT" }, sibling!.id)).toContain(
        "[episode]"
      );
      expect(await f.store.recallMemory(f.botId, { query: "COBALT" }, f.personal.id)).toContain(
        "launch uses amber"
      );
      expect(await f.prisma.memoryFact.count({ where: { writtenByBotId: f.botId, scope: "conversation" } })).toBe(0);
      expect(await f.prisma.memoryFact.count({ where: { namespace: `agent:${f.botId}`, fact: "COBALT launch uses amber." } })).toBe(1);
    } finally {
      await f.cleanup();
    }
  }
);

databaseTest(
  "the complete archive stays readable and writable beyond old file and row ceilings",
  async () => {
    const f = await fixture();
    try {
      const root = f.store.memoryDirectory(f.botId, "agent");
      await mkdir(join(root, "log"), { recursive: true });
      const padding = "reference archive material ".repeat(5);
      const lines = Array.from(
        { length: 21_001 },
        (_, i) =>
          `- (2001-01-01) Record ${i}: ${padding}${i === 21_000 ? "ARCHIVE21K final fact." : ""}`
      );
      await appendFile(join(root, "log", "2001-01.md"), lines.join("\n") + "\n");
      expect(Buffer.byteLength(lines.join("\n"))).toBeGreaterThan(2_000_000);
      expect(
        await f.store.recallMemory(f.botId, { query: "ARCHIVE21K", scope: "agent" })
      ).toContain("ARCHIVE21K final fact.");
      await f.store.writeMemory(f.botId, {
        scope: "agent",
        tier: "log",
        fact: "APPEND21K after the full archive.",
        at: new Date("2001-01-01"),
      });
      expect(await f.store.recallMemory(f.botId, { query: "APPEND21K" })).toContain(
        "after the full archive"
      );
      const target = lines.at(-1)!.replace(/^- \(2001-01-01\) /, "");
      expect(
        (await f.store.forgetMemory(f.botId, { scope: "agent", fact: target })).forgotten
      ).toBe(true);
      expect(
        (await f.store.recallMemory(f.botId, { query: "ARCHIVE21K" })).startsWith("No facts")
      ).toBe(true);
      expect(await f.prisma.memoryFact.count({ where: { namespace: `agent:${f.botId}` } })).toBe(
        21_001
      );
    } finally {
      await f.cleanup();
    }
  },
  45_000
);
