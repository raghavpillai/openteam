import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "../src/agent-data";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const write = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === "string" || value instanceof Uint8Array ? value : JSON.stringify(value, null, 2));
};

test.skipIf(!databaseUrl)("agent-data files are authoritative and preserve malformed settings", async () => {
  const prisma = createPrismaClient(databaseUrl!);
  const temporary = await mkdtemp(join(tmpdir(), "openteam-agent-data-"));
  const root = join(temporary, "agent-data");
  const workspace = join(temporary, "workspace");
  await mkdir(workspace, { recursive: true });
  const store = new AgentDataStore(prisma, { root, workspaceRoot: workspace });
  const [botId, channelId, groupId, skillId, routineId] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const botDirectory = join(root, "agents", botId);
  const groupDirectory = join(root, "agents", groupId);
  try {
    await prisma.bot.create({ data: {
      id: botId, name: "Filesystem Bot", title: "Research", description: "Initial description", icon: "●", color: "#4f7cff",
      namedBy: "user", defaultDirectory: join(workspace, "bots", botId), status: "active", onboardingStatus: "completed",
      notificationsEnabled: false, hiddenFromSidebar: true, conversation: { create: {} },
    } });
    await prisma.channel.create({ data: { id: channelId, kind: "bot_dm", name: "Filesystem Bot", directKey: `bot:${botId}`, members: { create: { botId, ordinal: 0 } } } });
    await prisma.channel.create({ data: {
      id: groupId, kind: "group", name: "Filesystem room", description: "Coordinates filesystem parity.",
      workingDirectory: join(workspace, "projects", "filesystem-room"), members: { create: { botId, ordinal: 0 } },
    } });
    await prisma.savedSkill.create({ data: { id: skillId, botId, slug: skillId, name: "Existing skill", description: "use this when checking projections", body: "# Original" } });

    // The database projects into files.
    await store.projectBot(botId);
    await store.writeGroupFilesForBot(botId);
    expect(await readJson(join(botDirectory, "profile.json"))).toMatchObject({ name: "Filesystem Bot", title: "Research", namedBy: "user" });
    expect(await readJson(join(botDirectory, "settings.json"))).toEqual({ notifyOnAgentUpdates: true });
    expect(await readJson(join(groupDirectory, "group.json"))).toEqual({ version: 1, memberIds: [botId] });
    expect(await readJson(join(groupDirectory, "profile.json"))).toEqual({ name: "Filesystem room", description: "Coordinates filesystem parity." });

    // Hand edits to the files win on reconciliation.
    const avatarBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    await write(join(botDirectory, "avatar.png"), avatarBytes);
    await write(join(botDirectory, "profile.json"), {
      name: "Hand Edited Bot", description: "Edited on disk", title: "Operations", avatarShape: "◆", avatarColor: "#123456", namedBy: "user",
    });
    await write(join(botDirectory, "settings.json"), { hiddenFromSidebar: true, notifyOnAgentUpdates: false });
    await write(join(botDirectory, "skills", skillId, "SKILL.md"),
      `---\nid: ${JSON.stringify(skillId)}\nname: "Edited skill"\ndescription: "use this when verifying a hand-edited skill"\n---\n\n# Edited body\n`);
    await write(join(botDirectory, "automations", routineId, "automation.json"), {
      id: routineId, name: "Filesystem routine", prompt: "Report the current filesystem projection state.", schedule: "@daily", enabled: false,
    });
    await write(join(groupDirectory, "profile.json"), { name: "Hand-edited room", description: "" });
    expect((await store.reconcileBot(botId)).warnings).toEqual([]);
    expect(await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).toMatchObject({
      name: "Hand Edited Bot", title: "Operations", description: "Edited on disk", icon: "◆", color: "#123456",
      hiddenFromSidebar: false, notificationsEnabled: false, avatarPath: await realpath(join(botDirectory, "avatar.png")),
    });
    expect(await readFile(join(botDirectory, "avatar.png"))).toEqual(Buffer.from(avatarBytes));
    expect(await prisma.channel.findUniqueOrThrow({ where: { id: groupId } })).toMatchObject({ name: "Hand-edited room" });
    expect(await prisma.savedSkill.findUniqueOrThrow({ where: { id: skillId } })).toMatchObject({ name: "Edited skill", body: "# Edited body" });
    expect(await prisma.routine.findUniqueOrThrow({ where: { botId_slug: { botId, slug: routineId } } }))
      .toMatchObject({ name: "Filesystem routine", scheduleText: "@daily", enabled: false });

    // A deleted profile is restored from the database; malformed settings are left for the user.
    await rm(join(botDirectory, "profile.json"));
    await store.reconcileBot(botId);
    expect(await readJson(join(botDirectory, "profile.json"))).toMatchObject({ name: "Hand Edited Bot" });
    const malformed = "{ definitely not json\n";
    await write(join(botDirectory, "settings.json"), malformed);
    expect((await store.reconcileBot(botId)).warnings).toEqual([]);
    await store.projectBot(botId);
    expect(await readFile(join(botDirectory, "settings.json"), "utf8")).toBe(malformed);
  } finally {
    await prisma.channel.deleteMany({ where: { id: { in: [channelId, groupId] } } });
    await prisma.memoryFact.deleteMany({ where: { OR: [{ writtenByBotId: botId }, { namespace: { in: [`agent:${botId}`, `user:agent:${botId}`] } }] } });
    await prisma.bot.deleteMany({ where: { id: botId } });
    await prisma.$disconnect();
    await rm(temporary, { recursive: true, force: true });
  }
}, 20_000);
