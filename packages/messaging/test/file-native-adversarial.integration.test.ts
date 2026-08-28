import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openbot/db";
import { AgentDataStore } from "../src/agent-data";
import { atomicWrite, jsonFile } from "../src/file-state";
import { RoutineService } from "../src/routines";
import { parseSkillFile, renderSkillFile } from "../src/skill-files";

const databaseUrl = process.env.OPENBOT_TEST_DATABASE_URL;

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const eventually = async <T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  label: string,
  timeoutMilliseconds = 6_000
): Promise<T> => {
  const startedAt = Date.now();
  let lastValue: T | undefined;
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMilliseconds) {
    try {
      lastValue = await read();
      if (matches(lastValue)) return lastValue;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    await wait(40);
  }
  throw new Error(
    `${label} did not converge; last value=${JSON.stringify(lastValue)}${
      lastError instanceof Error ? `; last error=${lastError.message}` : ""
    }`
  );
};

test("live filesystem watchers, snapshots, namespaces, and deletion authority agree", async () => {
  if (!databaseUrl) return;

  const prisma = createPrismaClient(databaseUrl);
  const temporary = await mkdtemp(join(tmpdir(), "openbot-live-files-"));
  const root = join(temporary, "agent-data");
  const workspace = join(temporary, "workspace");
  const outsideAvatar = join(temporary, "outside.png");
  await mkdir(workspace, { recursive: true });
  const store = new AgentDataStore(prisma, { root, workspaceRoot: workspace });

  const firstBotId = randomUUID();
  const secondBotId = randomUUID();
  const firstConversationId = randomUUID();
  const secondConversationId = randomUUID();
  const firstChannelId = randomUUID();
  const secondChannelId = randomUUID();
  const groupId = randomUUID();
  const projectSlug = `watcher-${randomUUID()}`;
  const skillSlug = "disk-owned-skill";
  const routineSlug = "disk-owned-routine";

  try {
    await prisma.bot.create({
      data: {
        id: firstBotId,
        name: "Watcher One",
        title: "Initial title",
        description: "Initial description",
        defaultDirectory: join(workspace, "bots", firstBotId),
        status: "active",
        onboardingStatus: "completed",
        conversation: { create: { id: firstConversationId } },
      },
    });
    await prisma.bot.create({
      data: {
        id: secondBotId,
        name: "Watcher Two",
        defaultDirectory: join(workspace, "bots", secondBotId),
        status: "active",
        onboardingStatus: "completed",
        conversation: { create: { id: secondConversationId } },
      },
    });
    await prisma.channel.create({
      data: {
        id: firstChannelId,
        kind: "bot_dm",
        name: "Watcher One",
        directKey: `bot:${firstBotId}`,
        members: { create: { botId: firstBotId, ordinal: 0 } },
      },
    });
    await prisma.channel.create({
      data: {
        id: secondChannelId,
        kind: "bot_dm",
        name: "Watcher Two",
        directKey: `bot:${secondBotId}`,
        members: { create: { botId: secondBotId, ordinal: 0 } },
      },
    });
    await prisma.channel.create({
      data: {
        id: groupId,
        kind: "group",
        name: "Watcher room",
        workingDirectory: join(workspace, "rooms", groupId),
        members: {
          create: [
            { botId: firstBotId, ordinal: 0 },
            { botId: secondBotId, ordinal: 1 },
          ],
        },
      },
    });
    await prisma.project.create({
      data: {
        slug: projectSlug,
        name: "Watcher project",
        workingDirectory: join(workspace, "projects", projectSlug),
        members: {
          create: [{ botId: firstBotId }, { botId: secondBotId }],
        },
      },
    });

    await Promise.all([store.initializeBot(firstBotId), store.initializeBot(secondBotId)]);
    await Promise.all([
      store.writeBotFiles(firstBotId, ["projects"]),
      store.writeBotFiles(secondBotId, ["projects"]),
    ]);
    await store.writeGroupFilesForBot(firstBotId);
    await Promise.all([store.reconcileBot(firstBotId), store.reconcileBot(secondBotId)]);

    const initialPrompt = await store.promptContext(firstBotId);
    expect(initialPrompt.profileSection).toContain("Watcher One");
    expect(initialPrompt.memoryRender).toBe("");
    expect(initialPrompt.skillRender).toBe("");

    await store.startWatching();
    const firstDirectory = store.botDirectory(firstBotId);

    const occupiedRoutineSlug = "manual-folder";
    const occupiedRoutineFile = join(
      firstDirectory,
      "automations",
      occupiedRoutineSlug,
      "automation.json"
    );
    await atomicWrite(occupiedRoutineFile, "{ intentionally invalid\n");
    const routineService = new RoutineService(
      prisma,
      {
        defaultTimeZone: "UTC",
        enqueueWake: async () => {
          throw new Error("not used by this test");
        },
      },
      store,
      "UTC"
    );
    const createdRoutine = await routineService.mutate(firstBotId, randomUUID(), null, {
      action: "create",
      name: "Manual   folder",
      prompt: "Do not overwrite the manual directory.",
      schedule: "@daily",
      enabled: false,
    });
    expect(
      await prisma.routine.findUniqueOrThrow({ where: { id: String(createdRoutine.id) } })
    ).toMatchObject({ slug: "manual-folder-2", name: "Manual folder" });
    expect(createdRoutine.folder).toBe("manual-folder-2");
    await routineService.mutate(firstBotId, randomUUID(), null, {
      action: "update",
      id: "manual-folder-2",
      name: "Renamed by folder",
    });
    expect(
      await prisma.routine.findUniqueOrThrow({ where: { id: String(createdRoutine.id) } })
    ).toMatchObject({ slug: "manual-folder-2", name: "Renamed by folder" });
    expect(await readFile(occupiedRoutineFile, "utf8")).toBe("{ intentionally invalid\n");

    await prisma.botConnectorState.upsert({
      where: { botId_platform: { botId: firstBotId, platform: "slack" } },
      create: {
        botId: firstBotId,
        platform: "slack",
        connected: false,
        disconnectedAt: new Date("2026-08-27T12:00:00.000Z"),
      },
      update: {
        connected: false,
        disconnectedAt: new Date("2026-08-27T12:00:00.000Z"),
      },
    });
    await store.writeConnectorFile(firstBotId, "slack");
    const connectionPath = join(firstDirectory, "channels", "slack", "connection.json");
    expect(JSON.parse(await readFile(connectionPath, "utf8"))).toEqual({
      platform: "slack",
      connected: false,
      disconnectedAt: "2026-08-27T12:00:00.000Z",
    });
    await atomicWrite(
      connectionPath,
      jsonFile({ platform: "slack", connected: true, disconnectedAt: null })
    );
    await eventually(
      () =>
        prisma.botConnectorState.findUnique({
          where: { botId_platform: { botId: firstBotId, platform: "slack" } },
        }),
      (state) => state?.connected === true && state.disconnectedAt === null,
      "connector watcher"
    );

    await atomicWrite(
      join(firstDirectory, "profile.json"),
      jsonFile({
        name: "Renamed on disk",
        description: "A watcher-applied description",
        title: "Filesystem title",
        avatarShape: "◆",
        avatarColor: "#123456",
        namedBy: "user",
      })
    );
    await eventually(
      () => prisma.bot.findUnique({ where: { id: firstBotId } }),
      (bot) => bot?.name === "Renamed on disk",
      "profile watcher"
    );
    expect(await prisma.channel.findUniqueOrThrow({ where: { id: firstChannelId } })).toMatchObject(
      { name: "Renamed on disk" }
    );

    const frozenIdentity = await store.promptContext(firstBotId);
    expect(frozenIdentity.profileSection).toBe(initialPrompt.profileSection);
    expect(frozenIdentity.identityAnnouncement).toContain("Renamed on disk");
    expect((await store.promptContext(firstBotId)).identityAnnouncement).toContain(
      "Renamed on disk"
    );
    await store.acknowledgeIdentityAnnouncement(firstBotId);
    expect((await store.promptContext(firstBotId)).identityAnnouncement).toBe("");

    const skillDirectory = join(firstDirectory, "skills", skillSlug);
    await atomicWrite(
      join(skillDirectory, "SKILL.md"),
      renderSkillFile({
        name: "Disk-owned skill",
        description: "Used to verify live watcher skill refresh.",
        body: "# Disk body\n\nFollow the filesystem contract.",
        frontmatter: { model: "fast", owner: "local" },
      })
    );
    await eventually(
      () =>
        prisma.savedSkill.findUnique({
          where: { botId_slug: { botId: firstBotId, slug: skillSlug } },
        }),
      (skill) => skill?.body.includes("Follow the filesystem contract") === true,
      "skill creation watcher"
    );
    await store.writeSkill(firstBotId, {
      id: skillSlug,
      name: "Disk-owned skill",
      description: "Updated without losing disk-owned frontmatter.",
      body: "# Updated disk body",
    });
    expect(
      parseSkillFile(await readFile(join(skillDirectory, "SKILL.md"), "utf8"), "SKILL.md")
        .frontmatter
    ).toMatchObject({ model: "fast", owner: "local" });
    expect(
      await store.deleteSkill(
        firstBotId,
        (
          await store.writeSkill(firstBotId, {
            name: "Delete by folder",
            description: "Exercises the file-native identifier path.",
            body: "# Delete me",
          })
        ).slug
      )
    ).toBe(true);
    expect((await store.promptContext(firstBotId)).skillRender).toBe("");

    await store.writeMemory(firstBotId, {
      scope: "agent",
      tier: "profile",
      fact: "The first fact is visible before memory freezes.",
    });
    await expect(access(join(firstDirectory, "memory", ".dreaming"))).rejects.toThrow();
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.writeMemory(firstBotId, {
          scope: "agent",
          tier: "log",
          fact: `Concurrent memory fact ${index}.`,
        })
      )
    );
    const concurrentMemory = await readFile(
      join(firstDirectory, "memory", "log", `${new Date().toISOString().slice(0, 7)}.md`),
      "utf8"
    );
    for (let index = 0; index < 8; index += 1) {
      expect(concurrentMemory).toContain(`Concurrent memory fact ${index}.`);
    }
    const firstMemoryPrompt = await store.promptContext(firstBotId);
    expect(firstMemoryPrompt.memoryRender).toContain(
      "The first fact is visible before memory freezes."
    );
    const memoryPath = join(firstDirectory, "memory", "profile.md");
    await atomicWrite(
      memoryPath,
      `${await readFile(memoryPath, "utf8")}- (2026-08-27) The second fact waits for compaction.\n`
    );
    await eventually(
      () =>
        prisma.memoryFact.findFirst({
          where: {
            namespace: `agent:${firstBotId}`,
            fact: "The second fact waits for compaction.",
          },
        }),
      (fact) => fact !== null,
      "memory watcher"
    );
    expect((await store.promptContext(firstBotId)).memoryRender).not.toContain(
      "The second fact waits for compaction."
    );

    await prisma.conversation.update({
      where: { id: firstConversationId },
      data: { compactionEpoch: { increment: 1 } },
    });
    const compactedPrompt = await store.promptContext(firstBotId);
    expect(compactedPrompt.profileSection).toContain("Renamed on disk");
    expect(compactedPrompt.memoryRender).toContain("The second fact waits for compaction.");
    expect(compactedPrompt.skillRender).toContain("Disk-owned skill");

    await store.writeMemory(firstBotId, {
      scope: "user",
      tier: "profile",
      fact: "User fact written by watcher one.",
    });
    await store.writeMemory(secondBotId, {
      scope: "user",
      tier: "profile",
      fact: "User fact written by watcher two.",
    });
    await store.writeMemory(secondBotId, {
      scope: "project",
      projectSlug,
      tier: "profile",
      fact: "Shared project fact written by watcher two.",
    });
    await prisma.conversation.update({
      where: { id: firstConversationId },
      data: { compactionEpoch: { increment: 1 } },
    });
    const mergedMemory = await store.promptContext(firstBotId);
    expect(mergedMemory.memoryRender).toContain("User fact written by watcher one.");
    expect(mergedMemory.memoryRender).toContain("User fact written by watcher two.");
    expect(mergedMemory.memoryRender).toContain("Shared project fact written by watcher two.");

    await store.forgetMemory(firstBotId, {
      scope: "user",
      fact: "User fact written by watcher one.",
    });
    const afterForget = await store.promptContext(firstBotId);
    expect(afterForget.memoryRender).not.toContain("User fact written by watcher one.");
    expect(afterForget.memoryRender).toContain("User fact written by watcher two.");

    const groupDirectory = join(root, "agents", groupId);
    await atomicWrite(
      join(groupDirectory, "profile.json"),
      jsonFile({ name: "Renamed watcher room", description: "" })
    );
    await eventually(
      () => prisma.channel.findUnique({ where: { id: groupId } }),
      (channel) => channel?.name === "Renamed watcher room",
      "group profile watcher"
    );
    await atomicWrite(
      join(groupDirectory, "group.json"),
      jsonFile({ version: 1, memberIds: [secondBotId] })
    );
    await eventually(
      () =>
        prisma.channelMember.findMany({
          where: { channelId: groupId },
          orderBy: { ordinal: "asc" },
        }),
      (members) => members.length === 1 && members[0]?.botId === secondBotId,
      "group membership watcher"
    );

    const routineDirectory = join(firstDirectory, "automations", routineSlug);
    const lastRunAt = Date.now() - 60_000;
    await atomicWrite(
      join(routineDirectory, "automation.json"),
      jsonFile({
        name: "Disk-owned routine",
        prompt: "Validate the disk-owned routine.",
        schedule: "@every 30s",
        enabled: false,
        provenance: "user",
        lastRunAt,
      })
    );
    await atomicWrite(
      join(routineDirectory, "runs.json"),
      jsonFile([
        {
          id: "watcher-run",
          trigger: "manual",
          startedAt: lastRunAt - 1_000,
          finishedAt: lastRunAt,
          status: "ok",
        },
      ])
    );
    const routine = await eventually(
      () =>
        prisma.routine.findUnique({
          where: { botId_slug: { botId: firstBotId, slug: routineSlug } },
        }),
      (value) => Array.isArray(value?.runLedger) && value.runLedger.length === 1,
      "automation watcher"
    );
    expect(routine).toMatchObject({
      enabled: false,
      provenance: "user",
      intervalSeconds: 30,
    });
    expect(routine?.lastRunAt?.getTime()).toBe(lastRunAt);

    await rm(join(routineDirectory, "runs.json"));
    const withoutLedger = await eventually(
      () =>
        prisma.routine.findUnique({
          where: { botId_slug: { botId: firstBotId, slug: routineSlug } },
        }),
      (value) => Array.isArray(value?.runLedger) && value.runLedger.length === 0,
      "runs.json deletion watcher"
    );
    expect(withoutLedger?.lastRunAt?.getTime()).toBe(lastRunAt);

    await rm(routineDirectory, { recursive: true });
    await eventually(
      () =>
        prisma.routine.findUnique({
          where: { botId_slug: { botId: firstBotId, slug: routineSlug } },
        }),
      (value) => value?.deletedAt !== null && value?.enabled === false,
      "automation deletion watcher"
    );

    await rm(skillDirectory, { recursive: true });
    await eventually(
      () =>
        prisma.savedSkill.findUnique({
          where: { botId_slug: { botId: firstBotId, slug: skillSlug } },
        }),
      (skill) => skill === null,
      "skill deletion watcher"
    );

    const malformedSettings = "{ definitely not valid json\n";
    await atomicWrite(join(firstDirectory, "settings.json"), malformedSettings);
    await eventually(
      () => prisma.bot.findUnique({ where: { id: firstBotId } }),
      (bot) =>
        bot?.notificationsEnabled === true &&
        bot.hiddenFromSidebar === false &&
        bot.dreamingEnabled === false,
      "malformed settings fallback"
    );
    expect(await readFile(join(firstDirectory, "settings.json"), "utf8")).toBe(malformedSettings);
    await store.writeBotFiles(firstBotId, ["settings"]);
    expect(JSON.parse(await readFile(join(firstDirectory, "settings.json"), "utf8"))).toEqual({
      notifyOnAgentUpdates: true,
      hiddenFromSidebar: false,
      dreamingEnabled: false,
    });
    await atomicWrite(
      join(firstDirectory, "settings.json"),
      jsonFile({ notifyOnAgentUpdates: false, hiddenFromSidebar: false, extra: "keep" })
    );
    await Promise.all([
      store.writeBotSettings(firstBotId, { hiddenFromSidebar: true }),
      store.writeBotSettings(firstBotId, { dreamingEnabled: true }),
    ]);
    expect(JSON.parse(await readFile(join(firstDirectory, "settings.json"), "utf8"))).toEqual({
      notifyOnAgentUpdates: false,
      hiddenFromSidebar: true,
      dreamingEnabled: true,
      extra: "keep",
    });

    await atomicWrite(join(firstDirectory, "profile.json"), "{ broken\n");
    await eventually(
      async () => {
        try {
          return JSON.parse(await readFile(join(firstDirectory, "profile.json"), "utf8")) as {
            name?: string;
          };
        } catch {
          return null;
        }
      },
      (profile) => profile?.name === "Renamed on disk",
      "malformed profile regeneration"
    );
    const parseableBadProfile = '{"name":42,"extraDiskField":true}\n';
    await atomicWrite(join(firstDirectory, "profile.json"), parseableBadProfile);
    await eventually(
      () => prisma.bot.findUnique({ where: { id: firstBotId } }),
      (bot) => bot?.name === "",
      "parseable profile coercion"
    );
    expect(await readFile(join(firstDirectory, "profile.json"), "utf8")).toBe(parseableBadProfile);
    await atomicWrite(
      join(firstDirectory, "profile.json"),
      jsonFile({
        name: "Binding profile",
        description: "",
        serverId: " server-1 ",
        harness: "box",
        extraDiskField: true,
      })
    );
    await store.reconcileBot(firstBotId);
    await store.writeBotFiles(firstBotId, ["profile"]);
    expect(JSON.parse(await readFile(join(firstDirectory, "profile.json"), "utf8"))).toMatchObject({
      name: "Binding profile",
      serverId: "server-1",
      harness: "box",
    });
    expect(
      JSON.parse(await readFile(join(firstDirectory, "profile.json"), "utf8"))
    ).not.toHaveProperty("extraDiskField");

    const avatarBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const validAvatar = join(firstDirectory, "avatar-source.png");
    await writeFile(validAvatar, avatarBytes);
    const avatar = await store.setAvatarFromPath(firstBotId, "avatar-source.png");
    expect(avatar.resolvedPath).toBe(await realpath(join(firstDirectory, "avatar.png")));
    expect(await readFile(join(firstDirectory, "avatar.png"))).toEqual(Buffer.from(avatarBytes));
    await rm(validAvatar);
    expect(await readFile(join(firstDirectory, "avatar.png"))).toEqual(Buffer.from(avatarBytes));
    await expect(access(join(firstDirectory, "avatar.json"))).rejects.toThrow();
    await writeFile(outsideAvatar, avatarBytes);
    const escapedAvatar = join(firstDirectory, "escaped.png");
    await symlink(outsideAvatar, escapedAvatar);
    await expect(store.setAvatarFromPath(firstBotId, escapedAvatar)).rejects.toThrow(
      "avatar source must stay inside"
    );

    await atomicWrite(
      join(firstDirectory, "settings.json"),
      jsonFile({
        notifyOnAgentUpdates: true,
        hiddenFromSidebar: false,
        dreamingEnabled: true,
      })
    );
    await store.reconcileBot(firstBotId);
    await prisma.bot.update({ where: { id: firstBotId }, data: { episodePending: 5 } });
    for (let index = 0; index < 13; index += 1) {
      await store.recordTurnMemory(firstBotId, {
        user: `Dreaming evidence ${index}`,
        assistant: `Dreaming answer ${index}`,
        occurredAt: index,
      });
    }
    expect(await prisma.bot.findUniqueOrThrow({ where: { id: firstBotId } })).toMatchObject({
      episodePending: 0,
    });
    await expect(access(join(firstDirectory, "memory", ".dreaming", "evidence"))).rejects.toThrow();
    await expect(
      access(join(firstDirectory, "memory", ".dreaming", "next-refresh-at"))
    ).rejects.toThrow();

    await atomicWrite(
      join(firstDirectory, "settings.json"),
      jsonFile({
        notifyOnAgentUpdates: true,
        hiddenFromSidebar: false,
        dreamingEnabled: false,
      })
    );
    await store.reconcileBot(firstBotId);
    await store.recordTurnMemory(firstBotId, {
      user: "Thanks!",
      assistant: "You're welcome.",
    });
    expect((await prisma.bot.findUniqueOrThrow({ where: { id: firstBotId } })).episodePending).toBe(
      0
    );
    await store.recordTurnMemory(firstBotId, {
      user: "Should this memorable question advance the episode counter?",
      assistant: "Yes.",
    });
    expect((await prisma.bot.findUniqueOrThrow({ where: { id: firstBotId } })).episodePending).toBe(
      1
    );

    await atomicWrite(join(root, "settings.json"), "{ malformed\n");
    const malformedRootSettings = await store.loadRootSettings();
    expect(malformedRootSettings.valid).toBe(false);
    expect(malformedRootSettings.settings.notificationsEnabled).toBe(true);
    const writtenRootSettings = await store.writeRootSettings({
      timezone: "Europe/London",
      theme: "dark",
    });
    expect(writtenRootSettings).toMatchObject({
      version: 1,
      timezone: "Europe/London",
      theme: "dark",
    });
    await Promise.all([
      store.writeRootSettings({ timezone: "America/New_York" }),
      store.writeRootSettings({ language: "fr" }),
    ]);
    expect((await store.loadRootSettings()).settings).toMatchObject({
      timezone: "America/New_York",
      language: "fr",
      theme: "dark",
    });
    expect((await store.loadRootSettings()).valid).toBe(true);
    await store.writeActiveAgentId(secondBotId);
    expect(await store.loadActiveAgentId()).toBe(secondBotId);

    expect(() => store.memoryDirectory(firstBotId, "project", "../escape")).toThrow(
      "project slug is not a safe folder id"
    );

    const secondDirectory = store.botDirectory(secondBotId);
    const secondUserMemory = join(root, "user-memory", "by-agent", secondBotId, "profile.md");
    const secondProjectMemory = join(
      root,
      "projects",
      projectSlug,
      "memory",
      "by-agent",
      secondBotId,
      "profile.md"
    );
    await access(secondDirectory);
    await access(secondUserMemory);
    await access(secondProjectMemory);
    await prisma.bot.update({
      where: { id: secondBotId },
      data: { status: "archived", avatarPath: null },
    });
    await store.deleteAgentFiles(secondBotId);
    const successor = await store.repairActiveAgentAfterDeletion(secondBotId);
    expect(successor).not.toBe(secondBotId);
    expect(successor).not.toBeNull();
    expect(await store.loadActiveAgentId()).toBe(successor);
    if (!successor) throw new Error("Expected an active-agent successor");
    expect(await prisma.bot.findUniqueOrThrow({ where: { id: successor } })).toMatchObject({
      status: "active",
    });
    await expect(access(secondDirectory)).rejects.toThrow();
    await access(secondUserMemory);
    await access(secondProjectMemory);
    await atomicWrite(
      secondUserMemory,
      "- (2026-08-27) An archived writer's user shard remains authoritative.\n"
    );
    await atomicWrite(
      secondProjectMemory,
      "- (2026-08-27) An archived writer's project shard remains authoritative.\n"
    );
    await store.reconcileBot(firstBotId);
    expect(
      await prisma.memoryFact.findFirst({
        where: {
          namespace: `user:agent:${secondBotId}`,
          fact: "An archived writer's user shard remains authoritative.",
        },
      })
    ).not.toBeNull();
    expect(
      await prisma.memoryFact.findFirst({
        where: {
          namespace: `project:${projectSlug}:agent:${secondBotId}`,
          fact: "An archived writer's project shard remains authoritative.",
        },
      })
    ).not.toBeNull();
  } finally {
    await store.stopWatching();
    await prisma.channel.deleteMany({
      where: { id: { in: [firstChannelId, secondChannelId, groupId] } },
    });
    await prisma.project.deleteMany({ where: { slug: projectSlug } });
    await prisma.memoryFact.deleteMany({
      where: {
        namespace: {
          in: [
            `agent:${firstBotId}`,
            `agent:${secondBotId}`,
            `user:agent:${firstBotId}`,
            `user:agent:${secondBotId}`,
            `project:${projectSlug}:agent:${firstBotId}`,
            `project:${projectSlug}:agent:${secondBotId}`,
          ],
        },
      },
    });
    await prisma.bot.deleteMany({
      where: { id: { in: [firstBotId, secondBotId] } },
    });
    await prisma.$disconnect();
    await rm(temporary, { recursive: true, force: true });
  }
}, 30_000);
