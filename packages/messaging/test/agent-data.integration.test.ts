import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "../src/agent-data";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

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
    await prisma.bot.create({
      data: {
        id: botId,
        name: "Filesystem Bot",
        title: "Research",
        description: "Initial description",
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
    await mkdir(join(botDirectory, "skills", skillId), { recursive: true });
    const avatarBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    await writeFile(join(botDirectory, "avatar.png"), avatarBytes);

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
        },
        null,
        2
      )
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

    const reconciled = await store.reconcileBot(botId);
    expect(reconciled.warnings).toEqual([]);
    const bot = await prisma.bot.findUniqueOrThrow({ where: { id: botId } });
    expect(bot).toMatchObject({
      name: "Hand Edited Bot",
      title: "Operations",
      description: "Edited on disk",
      icon: "◆",
      color: "#123456",
      hiddenFromSidebar: false,
      notificationsEnabled: false,
      avatarPath: await realpath(join(botDirectory, "avatar.png")),
    });
    expect(await readFile(join(botDirectory, "avatar.png"))).toEqual(Buffer.from(avatarBytes));
    expect(await prisma.channel.findUniqueOrThrow({ where: { id: groupId } })).toMatchObject({
      name: "Hand-edited room",
    });
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
