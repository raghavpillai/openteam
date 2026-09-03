import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore, type MemoryInferenceRequest } from "../src/agent-data";
import { readMemoryTree } from "../src/memory-files";
import { parseSkillFile } from "../src/skill-files";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("plugin and managed skill caches use the Grok filesystem contract", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "openteam-skill-caches-"));
  const root = join(temporary, "agent-data");
  const store = new AgentDataStore({} as never, {
    root,
    workspaceRoot: join(temporary, "workspace"),
  });
  try {
    await store.syncPluginSkillCache([
      {
        id: "research-playbook",
        name: "Research Playbook",
        version: "1.0.0",
        publisher: "OpenTeam",
        skills: [
          {
            name: "Source-led research",
            description: "Verify changing claims against primary sources.",
            body: "Separate sourced facts from inference.",
          },
        ],
      },
    ]);
    const managed = JSON.parse(
      await readFile(join(root, "managed-skills", "cache.json"), "utf8")
    ) as { fetchedAt: number; skills: unknown[] };
    expect(managed.fetchedAt).toBeNumber();
    expect(managed.skills).toEqual([]);

    const plugin = JSON.parse(
      await readFile(join(root, "plugin-skills", "cache.json"), "utf8")
    ) as {
      currentUserId: string;
      authBlocked: unknown[];
      skills: Array<{ id: string; filePath: string; installPath: string }>;
    };
    expect(plugin.currentUserId).toBe("openteam");
    expect(plugin.authBlocked).toEqual([]);
    expect(plugin.skills).toHaveLength(1);
    expect(plugin.skills[0]?.id).toBe("research-playbook-source-led-research");
    expect(plugin.skills[0]?.filePath.startsWith(plugin.skills[0]?.installPath ?? "!")).toBe(true);
    expect(
      parseSkillFile(await readFile(plugin.skills[0]!.filePath, "utf8"), "plugin skill")
    ).toMatchObject({
      name: "Source-led research",
      description: "Verify changing claims against primary sources.",
      body: "Separate sourced facts from inference.",
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("turn memory extracts, summarizes episodes, and synthesizes dreaming evidence", async () => {
  if (!databaseUrl) return;

  const prisma = createPrismaClient(databaseUrl);
  const temporary = await mkdtemp(join(tmpdir(), "openteam-memory-lifecycle-"));
  const root = join(temporary, "agent-data");
  const workspace = join(temporary, "workspace");
  const botId = crypto.randomUUID();
  const requests: MemoryInferenceRequest[] = [];
  let synthesisAttempts = 0;
  const memoryInference = async (request: MemoryInferenceRequest) => {
    requests.push(request);
    if (request.kind === "extraction") {
      return JSON.stringify({
        facts: [{ content: "Prefers lifecycle tests.", kind: "profile" }],
      });
    }
    if (request.kind === "episode") {
      return JSON.stringify({ narrative: "Validated memory behavior over six turns." });
    }
    if (request.kind === "synthesis") {
      synthesisAttempts += 1;
      const prompt = JSON.parse(request.prompt) as {
        evidence: Array<{ id: string }>;
      };
      if (synthesisAttempts === 1) {
        return JSON.stringify({
          changes: [
            {
              action: "create",
              content: "This first proposal intentionally omits citations.",
              kind: "log",
            },
          ],
        });
      }
      return JSON.stringify({
        changes: [
          {
            action: "create",
            content: "Dreaming captured a verified preference.",
            kind: "log",
            sourceEvidenceIds: [prompt.evidence[0]?.id],
          },
        ],
      });
    }
    return JSON.stringify({ approved: true });
  };
  const store = new AgentDataStore(prisma, {
    root,
    workspaceRoot: workspace,
    memorySynthesisDebounceMs: 60_000,
    memoryInference,
  });
  const dreamingStore = new AgentDataStore(prisma, {
    root,
    workspaceRoot: workspace,
    memoryDreamingEnabled: true,
    memorySynthesisDebounceMs: 60_000,
    memoryInference,
  });

  try {
    await mkdir(workspace, { recursive: true });
    await prisma.bot.create({
      data: {
        id: botId,
        name: "Memory lifecycle",
        defaultDirectory: join(workspace, botId),
        status: "active",
        onboardingStatus: "completed",
      },
    });
    await store.initializeBot(botId);
    for (let turn = 0; turn < 6; turn += 1) {
      await store.recordTurnMemory(botId, {
        user: `Remember lifecycle detail ${turn}.`,
        assistant: `Recorded detail ${turn}.`,
        occurredAt: Date.parse(`2026-08-${String(20 + turn).padStart(2, "0")}T12:00:00Z`),
      });
    }
    const afterEpisode = await prisma.bot.findUniqueOrThrow({ where: { id: botId } });
    expect(afterEpisode.episodePending).toBe(0);
    expect(afterEpisode.episodeTurns).toEqual([]);
    expect(
      (await readMemoryTree(store.memoryDirectory(botId, "agent"))).map((fact) => fact.content)
    ).toEqual(
      expect.arrayContaining([
        "Prefers lifecycle tests.",
        "[episode] Validated memory behavior over six turns.",
      ])
    );

    await dreamingStore.recordTurnMemory(botId, {
      user: "A dreaming turn should be synthesized.",
      assistant: "This is evidence for the synthesizer.",
    });
    await dreamingStore.runMemorySynthesisNow();
    expect(
      (await readMemoryTree(store.memoryDirectory(botId, "agent"))).map((fact) => fact.content)
    ).toContain("Dreaming captured a verified preference.");
    expect(requests.filter((request) => request.kind === "extraction")).toHaveLength(6);
    expect(requests.filter((request) => request.kind === "episode")).toHaveLength(1);
    expect(requests.filter((request) => request.kind === "synthesis")).toHaveLength(2);
    expect(requests.filter((request) => request.kind === "verification")).toHaveLength(1);
  } finally {
    await store.stopMemoryLifecycle();
    await dreamingStore.stopMemoryLifecycle();
    await prisma.bot.deleteMany({ where: { id: botId } });
    await prisma.$disconnect();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("agent-data files are authoritative and preserve malformed settings", async () => {
  if (!databaseUrl) return;

  const prisma = createPrismaClient(databaseUrl);
  const temporary = await mkdtemp(join(tmpdir(), "openteam-agent-data-"));
  const root = join(temporary, "agent-data");
  const workspace = join(temporary, "workspace");
  await mkdir(workspace, { recursive: true });
  const store = new AgentDataStore(prisma, { root, workspaceRoot: workspace });
  const botId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const channelId = crypto.randomUUID();
  const groupId = crypto.randomUUID();
  const skillId = crypto.randomUUID();
  const routineId = crypto.randomUUID();

  try {
    await prisma.memoryFact.deleteMany({
      where: { namespace: { in: ["user", `user:agent:${botId}`] } },
    });
    await prisma.project.deleteMany({ where: { slug: "file-parity" } });
    await prisma.bot.create({
      data: {
        id: botId,
        name: "Filesystem Bot",
        title: "Research",
        description: "Initial description",
        instructions: "",
        icon: "●",
        color: "#4f7cff",
        namedBy: "user",
        defaultDirectory: join(workspace, "bots", botId),
        status: "active",
        onboardingStatus: "completed",
        notificationsEnabled: false,
        hiddenFromSidebar: true,
        conversation: { create: { id: conversationId } },
      },
    });
    await prisma.channel.create({
      data: {
        id: channelId,
        kind: "bot_dm",
        name: "Filesystem Bot",
        directKey: `bot:${botId}`,
        members: { create: { botId, ordinal: 0 } },
      },
    });
    await prisma.channel.create({
      data: {
        id: groupId,
        kind: "group",
        name: "Filesystem room",
        description: "Coordinates filesystem parity.",
        workingDirectory: join(workspace, "projects", "filesystem-room"),
        members: { create: { botId, ordinal: 0 } },
      },
    });
    await prisma.project.create({
      data: {
        slug: "file-parity",
        name: "File parity",
        workingDirectory: join(workspace, "projects", "file-parity"),
        members: { create: { botId } },
      },
    });
    await prisma.savedSkill.create({
      data: {
        id: skillId,
        botId,
        slug: skillId,
        name: "Existing skill",
        description: "use this when checking projections",
        body: "# Original",
      },
    });
    await prisma.memoryFact.create({
      data: {
        namespace: "user",
        scope: "user",
        tier: "profile",
        fact: "The user likes generated files.",
        factHash: hash("The user likes generated files."),
        writtenByBotId: botId,
      },
    });

    await store.projectBot(botId);
    await store.writeGroupFilesForBot(botId);
    const botDirectory = join(root, "agents", botId);
    expect(JSON.parse(await readFile(join(botDirectory, "profile.json"), "utf8"))).toMatchObject({
      name: "Filesystem Bot",
      title: "Research",
      namedBy: "user",
    });
    expect(JSON.parse(await readFile(join(botDirectory, "settings.json"), "utf8"))).toEqual({
      notifyOnAgentUpdates: true,
    });
    expect(JSON.parse(await readFile(join(root, "agents", groupId, "group.json"), "utf8"))).toEqual(
      { version: 1, memberIds: [botId] }
    );
    expect(
      JSON.parse(await readFile(join(root, "agents", groupId, "profile.json"), "utf8"))
    ).toEqual({ name: "Filesystem room", description: "Coordinates filesystem parity." });
    await mkdir(join(botDirectory, "memory", "log"), { recursive: true });
    await mkdir(join(botDirectory, "skills", skillId), { recursive: true });
    const avatarPath = join(workspace, "avatar.png");
    const avatarBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    await writeFile(avatarPath, avatarBytes);

    await writeFile(
      join(botDirectory, "profile.json"),
      JSON.stringify(
        {
          name: "Hand Edited Bot",
          description: "Edited on disk",
          title: "Operations",
          avatarShape: "◆",
          avatarColor: "#123456",
          namedBy: "user",
          avatar: avatarPath,
        },
        null,
        2
      )
    );
    await writeFile(
      join(botDirectory, "settings.json"),
      JSON.stringify(
        {
          hiddenFromSidebar: true,
          notifyOnAgentUpdates: false,
        },
        null,
        2
      )
    );
    await writeFile(
      join(botDirectory, "memory", "profile.md"),
      [
        "# About the user",
        "<!-- Safe to read, grep, and edit. -->",
        "- (2026-08-27) The bot remembers hand-edited Markdown.",
        "",
      ].join("\n")
    );
    await writeFile(
      join(botDirectory, "skills", skillId, "SKILL.md"),
      [
        "---",
        `id: ${JSON.stringify(skillId)}`,
        'name: "Edited skill"',
        'description: "use this when verifying a hand-edited skill"',
        "---",
        "",
        "# Edited body",
        "",
      ].join("\n")
    );
    await mkdir(join(botDirectory, "automations", routineId), {
      recursive: true,
    });
    await writeFile(
      join(botDirectory, "automations", routineId, "automation.json"),
      JSON.stringify(
        {
          id: routineId,
          name: "Filesystem routine",
          prompt: "Report the current filesystem projection state.",
          schedule: "@daily",
          enabled: false,
        },
        null,
        2
      )
    );
    await writeFile(
      join(root, "agents", groupId, "profile.json"),
      JSON.stringify({ name: "Hand-edited room", description: "" }, null, 2)
    );
    await mkdir(join(root, "user-memory", "by-agent", botId), {
      recursive: true,
    });
    await writeFile(
      join(root, "user-memory", "by-agent", botId, "profile.md"),
      [
        "# About the user",
        "- (2026-08-27) The user likes generated files.",
        "- (2026-08-27) Shared user memory is one global namespace.",
        "",
      ].join("\n")
    );
    const projectProfile = join(
      root,
      "projects",
      "file-parity",
      "memory",
      "by-agent",
      botId,
      "profile.md"
    );
    await mkdir(join(projectProfile, ".."), { recursive: true });
    await writeFile(
      projectProfile,
      ["# Project memory", "- (2026-08-27) Project memory remains sharded by bot.", ""].join("\n")
    );

    const reconciled = await store.reconcileBot(botId);
    expect(reconciled.warnings).toEqual([]);
    const bot = await prisma.bot.findUniqueOrThrow({ where: { id: botId } });
    expect(bot).toMatchObject({
      name: "Hand Edited Bot",
      title: "Operations",
      description: "Edited on disk",
      icon: "◆",
      color: "#123456",
      hiddenFromSidebar: true,
      notificationsEnabled: false,
      avatarPath: await realpath(join(botDirectory, "avatar.png")),
    });
    expect(await readFile(join(botDirectory, "avatar.png"))).toEqual(Buffer.from(avatarBytes));
    await expect(access(join(botDirectory, "avatar.json"))).rejects.toThrow();
    expect(await prisma.channel.findUniqueOrThrow({ where: { id: groupId } })).toMatchObject({
      name: "Hand-edited room",
    });
    expect(
      await prisma.memoryFact.findFirst({
        where: {
          namespace: `agent:${botId}`,
          fact: "The bot remembers hand-edited Markdown.",
        },
      })
    ).not.toBeNull();
    expect(
      await prisma.memoryFact.findFirst({
        where: {
          namespace: `user:agent:${botId}`,
          fact: "Shared user memory is one global namespace.",
        },
      })
    ).not.toBeNull();
    expect(
      await prisma.memoryFact.findFirst({
        where: {
          namespace: `project:file-parity:agent:${botId}`,
          fact: "Project memory remains sharded by bot.",
        },
      })
    ).not.toBeNull();
    expect(await prisma.savedSkill.findUniqueOrThrow({ where: { id: skillId } })).toMatchObject({
      name: "Edited skill",
      body: "# Edited body",
    });
    expect(
      await prisma.routine.findUniqueOrThrow({
        where: { botId_slug: { botId, slug: routineId } },
      })
    ).toMatchObject({
      name: "Filesystem routine",
      scheduleText: "@daily",
      enabled: false,
    });

    const projectDocument = join(root, "projects", "file-parity", "project.md");
    expect(await readFile(projectDocument, "utf8")).toContain('name: "File parity"');
    await writeFile(
      projectDocument,
      [
        "---",
        'name: "Edited project name"',
        'description: "Edited from project.md"',
        "---",
        "",
      ].join("\n")
    );
    await store.reconcileBot(botId);
    expect(
      await prisma.project.findUniqueOrThrow({
        where: { slug: "file-parity" },
      })
    ).toMatchObject({
      name: "Edited project name",
      description: "Edited from project.md",
    });

    await writeFile(
      join(botDirectory, "memory", "profile.md"),
      ["# About the user", "<!-- Removing a bullet forgets it. -->", ""].join("\n")
    );
    await store.reconcileBot(botId);
    expect(
      await prisma.memoryFact.findFirst({
        where: {
          namespace: `agent:${botId}`,
          fact: "The bot remembers hand-edited Markdown.",
        },
      })
    ).toBeNull();

    await rm(join(botDirectory, "profile.json"));
    await store.reconcileBot(botId);
    expect(JSON.parse(await readFile(join(botDirectory, "profile.json"), "utf8"))).toMatchObject({
      name: "Hand Edited Bot",
    });

    const malformed = "{ definitely not json\n";
    await writeFile(join(botDirectory, "settings.json"), malformed);
    const warning = await store.reconcileBot(botId);
    expect(warning.warnings).toEqual([]);
    await store.projectBot(botId);
    expect(await readFile(join(botDirectory, "settings.json"), "utf8")).toBe(malformed);
  } finally {
    await prisma.channel.deleteMany({
      where: { id: { in: [channelId, groupId] } },
    });
    await prisma.project.deleteMany({ where: { slug: "file-parity" } });
    await prisma.memoryFact.deleteMany({
      where: {
        OR: [
          { writtenByBotId: botId },
          {
            namespace: {
              in: [
                "user",
                `agent:${botId}`,
                `user:agent:${botId}`,
                `project:file-parity:agent:${botId}`,
              ],
            },
          },
        ],
      },
    });
    await prisma.bot.deleteMany({ where: { id: botId } });
    await prisma.$disconnect();
    await rm(temporary, { recursive: true, force: true });
  }
}, 20_000);

test("subagent actors stay hidden and outside agent-data projection", async () => {
  if (!databaseUrl) return;

  const prisma = createPrismaClient(databaseUrl);
  const temporary = await mkdtemp(join(tmpdir(), "openteam-subagent-state-"));
  const root = join(temporary, "agent-data");
  const workspace = join(temporary, "workspace");
  const store = new AgentDataStore(prisma, { root, workspaceRoot: workspace });
  const parentBotId = crypto.randomUUID();
  const childBotId = crypto.randomUUID();
  const subagentId = crypto.randomUUID();

  try {
    await prisma.bot.create({
      data: {
        id: parentBotId,
        name: "Parent agent",
        defaultDirectory: join(workspace, "bots", parentBotId),
        status: "active",
        onboardingStatus: "completed",
      },
    });
    await prisma.bot.create({
      data: {
        id: childBotId,
        name: "Leaked child actor",
        defaultDirectory: join(workspace, "bots", childBotId),
        status: "active",
        onboardingStatus: "skipped_by_user",
        hiddenFromSidebar: false,
        notificationsEnabled: true,
      },
    });
    await prisma.subagent.create({
      data: {
        id: subagentId,
        parentBotId,
        childBotId,
        parentRunId: crypto.randomUUID(),
        parentChannelId: crypto.randomUUID(),
        launchCallId: crypto.randomUUID(),
        description: "Hidden child task",
        prompt: "Complete the private task.",
        subagentType: "executor",
        outputPath: `/tmp/${childBotId}.jsonl`,
      },
    });

    await store.projectBot(childBotId);
    await expect(access(store.botDirectory(childBotId))).rejects.toThrow();
    await mkdir(store.assetRoot, { recursive: true });
    const retainedAsset = join(store.assetRoot, "retained.blob");
    await writeFile(retainedAsset, "active attachment bytes");

    await store.reconcileAllActiveBots();

    expect(await prisma.bot.findUniqueOrThrow({ where: { id: childBotId } })).toMatchObject({
      hiddenFromSidebar: true,
      notificationsEnabled: false,
    });
    await expect(access(store.botDirectory(childBotId))).rejects.toThrow();
    expect(await readFile(retainedAsset, "utf8")).toBe("active attachment bytes");
  } finally {
    await prisma.subagent.deleteMany({ where: { id: subagentId } });
    await prisma.bot.deleteMany({ where: { id: { in: [childBotId, parentBotId] } } });
    await prisma.$disconnect();
    await rm(temporary, { recursive: true, force: true });
  }
}, 20_000);
