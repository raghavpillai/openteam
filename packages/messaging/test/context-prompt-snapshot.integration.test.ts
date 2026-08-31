import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openbot/db";
import { AgentDataStore } from "../src/agent-data";

const databaseUrl = process.env.OPENBOT_TEST_DATABASE_URL;

test("profile, first-fact memory, and skills freeze independently per context epoch", async () => {
  if (!databaseUrl) return;

  const prisma = createPrismaClient(databaseUrl);
  const temporary = await mkdtemp(join(tmpdir(), "openbot-context-snapshots-"));
  const root = join(temporary, "agent-data");
  const workspace = join(temporary, "workspace");
  const botId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const homeContextId = crypto.randomUUID();
  const groupContextId = crypto.randomUUID();
  const groupId = crypto.randomUUID();
  const store = new AgentDataStore(prisma, { root, workspaceRoot: workspace });

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
    expect(originalHome.memoryRender).toBe("");
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
    await mkdir(join(botDirectory, "memory"), { recursive: true });
    await writeFile(
      join(botDirectory, "memory", "profile.md"),
      "# About the user\n\n- (2026-08-28) First fact is visible immediately.\n"
    );
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
    expect(frozenHome.memoryRender).toContain("First fact is visible immediately.");
    expect(frozenGroup.memoryRender).toContain("First fact is visible immediately.");
    expect(frozenHome.skillRender).toBe("");
    expect(frozenGroup.skillRender).toBe("");

    await store.writeMemory(botId, {
      scope: "user",
      tier: "profile",
      fact: "A later global fact waits for the next compaction epoch.",
    });
    expect((await store.promptContext(botId, homeContextId)).memoryRender).not.toContain(
      "A later global fact waits for the next compaction epoch."
    );
    expect((await store.promptContext(botId, groupContextId)).memoryRender).not.toContain(
      "A later global fact waits for the next compaction epoch."
    );

    await store.acknowledgeIdentityAnnouncement(botId, homeContextId);
    expect((await store.promptContext(botId, homeContextId)).identityAnnouncement).toBe("");
    expect((await store.promptContext(botId, groupContextId)).identityAnnouncement).toContain(
      "Snapshot Renamed"
    );

    // Raw file removal does not bypass the epoch freeze once a fact-bearing
    // snapshot exists. Official forgetMemory deliberately invalidates it below.
    await writeFile(join(botDirectory, "memory", "profile.md"), "# About the user\n");
    expect((await store.promptContext(botId, homeContextId)).memoryRender).toContain(
      "First fact is visible immediately."
    );

    await writeFile(
      join(botDirectory, "memory", "profile.md"),
      [
        "# About the user",
        "",
        "- (2026-08-28) First fact is visible immediately.",
        "- (2026-08-28) Second fact waits for compaction.",
        "",
      ].join("\n")
    );
    await prisma.contextSession.update({
      where: { id: groupContextId },
      data: { compactionEpoch: 1 },
    });

    const refreshedGroup = await store.promptContext(botId, groupContextId);
    const stillFrozenHome = await store.promptContext(botId, homeContextId);
    expect(refreshedGroup.profileSection).toContain("Snapshot Renamed");
    expect(refreshedGroup.memoryRender).toContain("Second fact waits for compaction.");
    expect(refreshedGroup.memoryRender).toContain(
      "A later global fact waits for the next compaction epoch."
    );
    expect(refreshedGroup.skillRender).toContain("Epoch skill");
    expect(refreshedGroup.skillRender).not.toContain("PRIVATE_SKILL_BODY_SHOULD_NOT_BE_CATALOGUED");
    expect(stillFrozenHome.profileSection).toContain("Snapshot Original");
    expect(stillFrozenHome.memoryRender).not.toContain("Second fact waits for compaction.");
    expect(stillFrozenHome.memoryRender).not.toContain(
      "A later global fact waits for the next compaction epoch."
    );
    expect(stillFrozenHome.skillRender).toBe("");

    await prisma.contextSession.update({
      where: { id: homeContextId },
      data: { compactionEpoch: 1 },
    });
    const refreshedHome = await store.promptContext(botId, homeContextId);
    expect(refreshedHome.profileSection).toContain("Snapshot Renamed");
    expect(refreshedHome.memoryRender).toContain("Second fact waits for compaction.");
    expect(refreshedHome.memoryRender).toContain(
      "A later global fact waits for the next compaction epoch."
    );
    expect(refreshedHome.skillRender).toContain("Epoch skill");

    const snapshots = await prisma.contextPromptSnapshot.findMany({
      where: { contextSessionId: { in: [homeContextId, groupContextId] } },
      orderBy: { contextSessionId: "asc" },
    });
    expect(snapshots).toHaveLength(2);
    expect(snapshots.every((snapshot) => snapshot.profileEpoch === 1)).toBe(true);
    expect(snapshots.every((snapshot) => snapshot.memoryEpoch === 1)).toBe(true);
    expect(snapshots.every((snapshot) => snapshot.skillEpoch === 1)).toBe(true);

    await store.forgetMemory(botId, {
      scope: "agent",
      fact: "Second fact waits for compaction.",
    });
    expect((await store.promptContext(botId, homeContextId)).memoryRender).not.toContain(
      "Second fact waits for compaction."
    );
    expect((await store.promptContext(botId, groupContextId)).memoryRender).not.toContain(
      "Second fact waits for compaction."
    );
    await store.forgetMemory(botId, {
      scope: "user",
      fact: "A later global fact waits for the next compaction epoch.",
    });
  } finally {
    await store.stopMemoryLifecycle();
    await prisma.bot.deleteMany({ where: { id: botId } });
    await prisma.$disconnect();
    await rm(temporary, { recursive: true, force: true });
  }
});
