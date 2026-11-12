import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore, type MemoryInferenceRequest } from "../src/agent-data";
import { memoryLogicalId } from "../src/memory-facts";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

test.skipIf(!databaseUrl)("profile, memory facts, and skills freeze independently per context epoch", async () => {

  const prisma = createPrismaClient(databaseUrl);
  const temporary = await mkdtemp(join(tmpdir(), "openteam-context-snapshots-"));
  const root = join(temporary, "agent-data");
  const workspace = join(temporary, "workspace");
  const botId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const homeContextId = crypto.randomUUID();
  const groupContextId = crypto.randomUUID();
  const groupId = crypto.randomUUID();
  const store = new AgentDataStore(prisma, { root, workspaceRoot: workspace });
  // The facts a conversation sees in <memory_context>: pinned for its compaction epoch.
  const pinned = async (contextSessionId: string) => {
    const prompt = await store.promptContext(botId, contextSessionId);
    return (await store.preparePlatformSections(botId, contextSessionId, prompt.compactionEpoch, {}, prompt.memory)).memory!.facts;
  };

  try {
    await mkdir(workspace, { recursive: true });
    await prisma.bot.create({
      data: {
        id: botId,
        name: "Snapshot Original",
        description: "Original description",
        defaultDirectory: workspace,
        status: "active",
        onboardingStatus: "completed",
        conversation: { create: { id: conversationId } },
        contextSessions: {
          create: [
            { id: homeContextId, scope: "home", scopeId: conversationId },
            { id: groupContextId, scope: "group", scopeId: groupId },
          ],
        },
      },
    });
    await store.initializeBot(botId);

    const originalHome = await store.promptContext(botId, homeContextId);
    const originalGroup = await store.promptContext(botId, groupContextId);
    expect(originalHome.profileSection).toBe(
      'Agent profile:\nTitle: Snapshot Original\nYour agent name is "Snapshot Original". If the user asks for your name, answer with "Snapshot Original".\nDescription: Original description'
    );
    expect(originalGroup.profileSection).toContain("Snapshot Original");
    expect(await pinned(homeContextId)).toBe("No shared facts recorded yet.\n\nNo facts recorded yet.");
    expect(await pinned(groupContextId)).toBe("No shared facts recorded yet.\n\nNo facts recorded yet.");
    expect(originalHome.skillRender).toBe("");

    const botDirectory = join(root, "agents", botId);
    await writeFile(
      join(botDirectory, "profile.json"),
      `${JSON.stringify(
        {
          name: "Snapshot Renamed",
          description: "Changed description",
          title: "",
          avatarShape: "●",
          avatarColor: "#4f7cff",
          namedBy: "user",
        },
        null,
        2
      )}\n`
    );
    await store.writeMemory(botId, {
      scope: "agent",
      tier: "profile",
      fact: "First fact waits for compaction.",
      at: new Date("2026-08-28"),
    });
    await store.writeSkill(botId, {
      name: "Epoch skill",
      description: "appears only after a context summary refresh",
      body: "PRIVATE_SKILL_BODY_SHOULD_NOT_BE_CATALOGUED\n",
    });

    const frozenHome = await store.promptContext(botId, homeContextId);
    const frozenGroup = await store.promptContext(botId, groupContextId);
    expect(frozenHome.profileSection).toContain("Snapshot Original");
    expect(frozenHome.identityAnnouncement).toContain("Snapshot Renamed");
    expect(frozenGroup.identityAnnouncement).toContain("Snapshot Renamed");
    expect(frozenHome.memory.facts).toContain("First fact waits for compaction.");
    expect(await pinned(homeContextId)).not.toContain("First fact waits for compaction.");
    expect(await pinned(groupContextId)).not.toContain("First fact waits for compaction.");
    expect(frozenHome.skillRender).toBe("");
    expect(frozenGroup.skillRender).toBe("");

    await store.writeMemory(botId, {
      scope: "user",
      tier: "profile",
      fact: "A later global fact waits for the next compaction epoch.",
    });
    expect(await pinned(homeContextId)).not.toContain(
      "A later global fact waits for the next compaction epoch."
    );
    expect(await pinned(groupContextId)).not.toContain(
      "A later global fact waits for the next compaction epoch."
    );

    const receipt = frozenHome.identityReceipt!;
    const restarted = new AgentDataStore(prisma, { root, workspaceRoot: workspace });
    await restarted.acknowledgeIdentityAnnouncement(botId, homeContextId, receipt);
    // A delayed acknowledgement cannot overwrite a newer identity announcement.
    const snapshot = await prisma.contextPromptSnapshot.findUniqueOrThrow({ where: { contextSessionId: homeContextId } });
    await prisma.contextPromptSnapshot.update({ where: { contextSessionId: homeContextId }, data: { announcedName: "Newer delivered name" } });
    await restarted.acknowledgeIdentityAnnouncement(botId, homeContextId, receipt);
    expect((await prisma.contextPromptSnapshot.findUniqueOrThrow({ where: { contextSessionId: homeContextId } })).announcedName).toBe("Newer delivered name");
    await prisma.contextPromptSnapshot.update({ where: { contextSessionId: homeContextId }, data: { announcedName: snapshot.announcedName } });
    expect((await store.promptContext(botId, homeContextId)).identityAnnouncement).toBe("");
    expect((await store.promptContext(botId, groupContextId)).identityAnnouncement).toContain(
      "Snapshot Renamed"
    );

    await store.writeMemory(botId, {
      scope: "agent",
      tier: "profile",
      fact: "Second fact waits for compaction.",
      at: new Date("2026-08-28"),
    });
    expect(await pinned(homeContextId)).not.toContain("Second fact waits for compaction.");
    await prisma.contextSession.update({
      where: { id: groupContextId },
      data: { compactionEpoch: 1 },
    });

    const refreshedGroup = await store.promptContext(botId, groupContextId);
    const stillFrozenHome = await store.promptContext(botId, homeContextId);
    expect(refreshedGroup.profileSection).toContain("Snapshot Renamed");
    const refreshedGroupFacts = await pinned(groupContextId);
    expect(refreshedGroupFacts).toContain("First fact waits for compaction.");
    expect(refreshedGroupFacts).toContain("Second fact waits for compaction.");
    expect(refreshedGroupFacts).toContain(
      "A later global fact waits for the next compaction epoch."
    );
    // The catalog lists a skill by its path and description, as the reference does.
    expect(refreshedGroup.skillRender).toContain("/workflows/epoch-skill/SKILL.md\">appears only after a context summary refresh</agent_skill>");
    expect(refreshedGroup.skillRender).not.toContain("PRIVATE_SKILL_BODY_SHOULD_NOT_BE_CATALOGUED");
    expect(stillFrozenHome.profileSection).toContain("Snapshot Original");
    expect(await pinned(homeContextId)).toBe("No shared facts recorded yet.\n\nNo facts recorded yet.");
    expect(stillFrozenHome.skillRender).toBe("");

    await prisma.contextSession.update({
      where: { id: homeContextId },
      data: { compactionEpoch: 1 },
    });
    const refreshedHome = await store.promptContext(botId, homeContextId);
    expect(refreshedHome.profileSection).toContain("Snapshot Renamed");
    expect(await pinned(homeContextId)).toBe(refreshedGroupFacts);
    expect(refreshedHome.skillRender).toContain("/workflows/epoch-skill/SKILL.md");

    const snapshots = await prisma.contextPromptSnapshot.findMany({
      where: { contextSessionId: { in: [homeContextId, groupContextId] } },
      orderBy: { contextSessionId: "asc" },
    });
    expect(snapshots).toHaveLength(2);
    expect(snapshots.every((snapshot) => snapshot.profileEpoch === 1)).toBe(true);
    expect(
      snapshots.every((snapshot) => (snapshot.promptSections as { memory?: { compactionEpoch: number } }).memory?.compactionEpoch === 1)
    ).toBe(true);
    expect(snapshots.every((snapshot) => snapshot.skillEpoch === 1)).toBe(true);

    // Forget and owner deletion unpin immediately so removed facts cannot remain current.
    await store.forgetMemory(botId, {
      scope: "agent",
      fact: "Second fact waits for compaction.",
    });
    expect((await store.promptContext(botId, homeContextId)).memory.facts).not.toContain(
      "Second fact waits for compaction."
    );
    expect(await pinned(homeContextId)).not.toContain("Second fact waits for compaction.");
    await store.deleteBotMemories(botId, memoryLogicalId("First fact waits for compaction."));
    for (const contextId of [homeContextId, groupContextId]) {
      const facts = await pinned(contextId);
      expect(facts).not.toContain("First fact waits for compaction.");
      expect(facts).not.toContain("Second fact waits for compaction.");
      expect(facts).toContain("A later global fact waits for the next compaction epoch.");
    }
    await store.forgetMemory(botId, {
      scope: "user",
      fact: "A later global fact waits for the next compaction epoch.",
    });
  } finally {
    await prisma.bot.deleteMany({ where: { id: botId } });
    await prisma.$disconnect();
    await rm(temporary, { recursive: true, force: true });
  }
});

test.skipIf(!databaseUrl)(
  "memory facts pin per epoch: own changes wait for the summary, other assistants' shared changes are announced once",
  async () => {
    const prisma = createPrismaClient(databaseUrl!);
    const temporary = await mkdtemp(join(tmpdir(), "memory-parity-integration-"));
    const workspace = join(temporary, "workspace");
    const botId = crypto.randomUUID();
    const peerId = crypto.randomUUID();
    const contextId = crypto.randomUUID();
    const groupContextId = crypto.randomUUID();
    let groupId: string | undefined;
    const requests: MemoryInferenceRequest[] = [];
    const store = new AgentDataStore(prisma, {
      root: join(temporary, "agent-data"),
      workspaceRoot: workspace,
      memoryInference: async (request) => {
        requests.push(request);
        if (requests.length === 1) {
          expect(request.prompt).toContain("- Lives in Boston.");
          return "remove: Lives in Boston.\nremove: Invented old fact.\nprofile: Lives in NYC.\nnote: Likes cobalt for this demo.";
        }
        return "NONE";
      },
    });
    const prepare = async (contextSessionId: string, channelId?: string) => {
      const prompt = await store.promptContext(botId, contextSessionId, channelId);
      const sections = await store.preparePlatformSections(botId, contextSessionId, prompt.compactionEpoch, {}, prompt.memory);
      return { prompt, ...sections.memory! };
    };
    try {
      await mkdir(workspace, { recursive: true });
      for (const [id, name] of [[botId, "Memory parity"], [peerId, "Career Bot"]] as const) {
        await prisma.bot.create({
          data: {
            id,
            name,
            status: "active",
            onboardingStatus: "completed",
            defaultDirectory: workspace,
          },
        });
        await store.initializeBot(id);
      }
      const group = await prisma.channel.create({
        data: {
          kind: "group",
          name: "Memory parity room",
          members: { create: [{ botId, ordinal: 0 }, { botId: peerId, ordinal: 1 }] },
        },
      });
      groupId = group.id;
      await prisma.contextSession.createMany({
        data: [
          { id: contextId, botId, scope: "home", scopeId: botId },
          { id: groupContextId, botId, scope: "group", scopeId: group.id },
        ],
      });
      for (const fact of ["Lives in Boston.", "Prefers visual explanations."]) {
        await store.writeMemory(botId, { scope: "agent", tier: "profile", fact, at: new Date("2020-01-01") });
      }
      await store.writeMemory(botId, { scope: "user", tier: "profile", fact: "Own shared PARITY fact.", at: new Date("2020-01-02") });
      await store.writeMemory(peerId, { scope: "user", tier: "log", fact: "Started a new PARITY job.", at: new Date("2020-01-03") });

      const first = await prepare(contextId);
      expect(first.prompt.memory.policy).toStartWith("## Shared user memory\n");
      expect(first.prompt.memory.policy).toContain("\n\n## Memory\n");
      expect(first.prompt.memory.policy).not.toContain("PARITY");
      expect(first.facts).toBe(first.prompt.memory.facts);
      expect(first.facts).toContain("- (learned 2020-01-02) [via Memory parity] Own shared PARITY fact.");
      expect(first.facts).toContain("Recently (shared_journal):\n- (learned 2020-01-03) [via Career Bot] Started a new PARITY job.");
      expect(first.facts).toEndWith(
        "\n\nAbout the user (profile):\n- (learned 2020-01-01) Prefers visual explanations.\n- (learned 2020-01-01) Lives in Boston."
      );
      expect(first.update).toBeNull();

      // A group room sees neither the shared policy nor shared facts.
      const room = await prepare(groupContextId, group.id);
      expect(room.prompt.memory.policy).toStartWith("## Memory\n");
      expect(room.facts).toBe(
        "About the user (profile):\n- (learned 2020-01-01) Prefers visual explanations.\n- (learned 2020-01-01) Lives in Boston."
      );

      // Hidden work and small talk are not reviewed.
      await store.recordTurnMemory(botId, { user: "Thanks...]", assistant: "You're welcome." });
      await store.recordTurnMemory(botId, { user: "A hidden request must not become memory.", assistant: "Done", hidden: true });
      expect(requests).toHaveLength(0);

      await store.recordTurnMemory(botId, {
        user: "I now live in NYC, and cobalt is good for this demo.",
        assistant: "Understood.",
        occurredAt: Date.parse("2026-09-12T10:00:00Z"),
      });
      expect(
        (await prisma.memoryFact.findMany({ where: { namespace: `agent:${botId}` }, orderBy: { sourceOrdinal: "asc" } }))
          .map(({ fact, tier }) => [fact, tier])
      ).toEqual([
        ["Prefers visual explanations.", "profile"],
        ["Lives in NYC.", "profile"],
        ["[note] Likes cobalt for this demo.", "note"],
      ]);
      // The bot's own changes are not announced; the pinned facts wait for the next summary.
      const afterLearning = await prepare(contextId);
      expect(afterLearning.facts).toBe(first.facts);
      expect(afterLearning.update).toBeNull();
      expect(afterLearning.prompt.memory.facts).toContain("Lives in NYC.");
      expect(afterLearning.prompt.memory.facts).not.toContain("Lives in Boston.");
      await store.writeMemory(botId, { scope: "user", tier: "log", fact: "Own shared change stays quiet." });
      expect((await prepare(contextId)).update).toBeNull();

      // Another assistant's shared change is announced until delivered.
      await store.writeMemory(peerId, { scope: "user", tier: "profile", fact: "Lives in Lyon." });
      const peerChange = await prepare(contextId);
      expect(peerChange.facts).toBe(first.facts);
      expect(peerChange.update).toStartWith("<memory_context_update>\n");
      expect(peerChange.update).toContain("[via Career Bot] Lives in Lyon.");
      expect(peerChange.update).not.toContain("Own shared");
      expect(peerChange.update).toEndWith("</memory_context_update>");
      expect((await prepare(contextId)).update).toBe(peerChange.update);
      await store.acknowledgePlatformSections(botId, contextId, [], peerChange.receipt);
      expect((await prepare(contextId)).update).toBeNull();
      expect((await prepare(groupContextId, group.id)).update).toBeNull();

      // A summary re-renders the pinned facts.
      await prisma.contextSession.update({ where: { id: contextId }, data: { compactionEpoch: 1 } });
      const refreshed = await prepare(contextId);
      expect(refreshed.facts).toContain("Lives in NYC.");
      expect(refreshed.facts).toContain("[via Career Bot] Lives in Lyon.");
      expect(refreshed.facts).not.toContain("Lives in Boston.");
      expect(refreshed.update).toBeNull();
      expect(await store.recallMemory(botId, { query: "cobalt" })).toContain("[journal] [note] Likes cobalt");
    } finally {
      await prisma.memoryFact.deleteMany({ where: { writtenByBotId: { in: [botId, peerId] } } });
      if (groupId) await prisma.channel.deleteMany({ where: { id: groupId } });
      await prisma.bot.deleteMany({ where: { id: { in: [botId, peerId] } } });
      await prisma.$disconnect();
      await rm(temporary, { recursive: true, force: true });
    }
  },
  60_000
);
