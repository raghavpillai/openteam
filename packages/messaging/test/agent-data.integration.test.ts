import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openbot/db";
import { AgentDataStore } from "../src/agent-data";

const databaseUrl = process.env.OPENBOT_TEST_DATABASE_URL;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("agent-data files are authoritative and preserve malformed settings", async () => {
  if (!databaseUrl) return;

  const prisma = createPrismaClient(databaseUrl);
  const temporary = await mkdtemp(join(tmpdir(), "openbot-agent-data-"));
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
        dreamingEnabled: true,
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
      notifyOnAgentUpdates: false,
      hiddenFromSidebar: true,
      dreamingEnabled: true,
    });
    expect(JSON.parse(await readFile(join(root, "agents", groupId, "group.json"), "utf8"))).toEqual(
      { version: 1, memberIds: [botId] }
    );
    await mkdir(join(botDirectory, "memory", "log"), { recursive: true });
    await mkdir(join(botDirectory, "skills", skillId), { recursive: true });

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
          dreamingEnabled: true,
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
    const avatarPath = join(workspace, "avatar.png");
    const avatarBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    await writeFile(avatarPath, avatarBytes);
    await writeFile(
      join(botDirectory, "avatar.json"),
      JSON.stringify({ path: avatarPath }, null, 2)
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
      dreamingEnabled: true,
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
    expect(warning.warnings.join("\n")).toContain("settings.json is not valid JSON");
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
  const temporary = await mkdtemp(join(tmpdir(), "openbot-subagent-state-"));
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

    await store.reconcileAllActiveBots();

    expect(await prisma.bot.findUniqueOrThrow({ where: { id: childBotId } })).toMatchObject({
      hiddenFromSidebar: true,
      notificationsEnabled: false,
    });
    await expect(access(store.botDirectory(childBotId))).rejects.toThrow();
  } finally {
    await prisma.subagent.deleteMany({ where: { id: subagentId } });
    await prisma.bot.deleteMany({ where: { id: { in: [childBotId, parentBotId] } } });
    await prisma.$disconnect();
    await rm(temporary, { recursive: true, force: true });
  }
}, 20_000);
