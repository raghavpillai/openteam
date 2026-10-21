import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "../src/agent-data";
import { memoryLogicalId } from "../src/memory-facts";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

test("profile, memory facts, and skills freeze independently per context epoch", async () => {
  if (!databaseUrl) return;

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
    expect(originalHome.profileSection).toContain("Snapshot Original");
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

    // A forget, like a write, shows after the next summary; the owner's deletion unpins at once.
    await store.forgetMemory(botId, {
      scope: "agent",
      fact: "Second fact waits for compaction.",
    });
    expect((await store.promptContext(botId, homeContextId)).memory.facts).not.toContain(
      "Second fact waits for compaction."
    );
    expect(await pinned(homeContextId)).toContain("Second fact waits for compaction.");
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
