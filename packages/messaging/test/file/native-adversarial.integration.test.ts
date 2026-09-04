import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "../../src/agent-data";
import { atomicWrite, jsonFile } from "../../src/file-state";
import { RoutineService } from "../../src/routines";
import { parseSkillFile, renderSkillFile } from "../../src/skill-files";
import { appendAgentTimelineEvent } from "../../src/timeline-events";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

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

test("provisioning watches preserve Bot's exact three-file creation state", async () => {
  if (!databaseUrl) return;

  const prisma = createPrismaClient(databaseUrl);
  const temporary = await mkdtemp(join(tmpdir(), "openteam-provisioning-files-"));
  const root = join(temporary, "agent-data");
  const workspace = join(temporary, "workspace");
  const botId = randomUUID();
  const store = new AgentDataStore(prisma, { root, workspaceRoot: workspace });

  try {
    await mkdir(workspace, { recursive: true });
    await prisma.bot.create({
      data: {
        id: botId,
        name: "Provisioning files",
        defaultDirectory: workspace,
        status: "provisioning",
      },
    });
    await store.startWatching();
    await store.initializeBot(botId);
    await atomicWrite(join(store.botDirectory(botId), "store.db"), "sqlite fixture");
    await store.reconcileBot(botId);
    await wait(250);

    expect((await readdir(store.botDirectory(botId))).sort()).toEqual([
      "profile.json",
      "settings.json",
      "store.db",
    ]);
  } finally {
    await store.stopWatching();
    await prisma.bot.deleteMany({ where: { id: botId } });
    await prisma.$disconnect();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("live filesystem watchers, snapshots, namespaces, and deletion authority agree", async () => {
  if (!databaseUrl) return;

  const prisma = createPrismaClient(databaseUrl);
  const temporary = await mkdtemp(join(tmpdir(), "openteam-live-files-"));
  const root = join(temporary, "agent-data");
  const workspace = join(temporary, "workspace");
  const outsideAvatar = join(temporary, "outside.png");
  await mkdir(workspace, { recursive: true });
  const store = new AgentDataStore(prisma, { root, workspaceRoot: workspace });
  const dreamingStore = new AgentDataStore(prisma, {
    root,
    workspaceRoot: workspace,
    memoryDreamingEnabled: true,
  });

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
  const eventWakes: Array<{ origin: string; type: string; content: string }> = [];
  let timelineSessionActive = true;
  const timelineHost = {
    defaultTimeZone: "UTC",
    isTimelineSessionActive: async () => timelineSessionActive,
    enqueueWake: async (_tx: unknown, input: { origin: string; type: string; content: string }) => {
      eventWakes.push(input);
      return { run: { id: randomUUID() } };
    },
  };
  store.setTimelineEventSink((tx, input) => appendAgentTimelineEvent(tx, timelineHost, input));

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
    const routineService = new RoutineService(prisma, timelineHost, store, "UTC");
    const createdRoutine = await routineService.mutate(firstBotId, randomUUID(), null, {
      action: "create",
      name: "Manual   folder",
      prompt: "Do not overwrite the manual directory.",
      schedule: "@daily",
      enabled: false,
    });
    const createdRoutineId = String(createdRoutine.id);
    expect(
      await prisma.routine.findUniqueOrThrow({ where: { id: createdRoutineId } })
    ).toMatchObject({ slug: "manual-folder-2", name: "Manual folder" });
    expect(createdRoutine.folder).toBe("manual-folder-2");
    await routineService.mutate(firstBotId, randomUUID(), null, {
      action: "update",
      id: "manual-folder-2",
      name: "Renamed by folder",
    });
    await routineService.mutate(firstBotId, randomUUID(), null, {
      action: "resume",
      id: "manual-folder-2",
    });
    await routineService.mutate(firstBotId, randomUUID(), null, {
      action: "pause",
      id: "manual-folder-2",
    });
    const unchangedPause = await routineService.mutate(firstBotId, randomUUID(), null, {
      action: "pause",
      id: "manual-folder-2",
    });
    expect(unchangedPause).toMatchObject({ unchanged: true, paused: false });
    expect(
      await prisma.routine.findUniqueOrThrow({ where: { id: createdRoutineId } })
    ).toMatchObject({ slug: "manual-folder-2", name: "Renamed by folder" });
    expect(
      (
        await prisma.channelMessage.findMany({
          where: { channelId: firstChannelId, sender: "system" },
          orderBy: { sequence: "asc" },
          select: { metadata: true },
        })
      ).map((message) => message.metadata)
    ).toEqual([
      {
        type: "event",
        event: {
          type: "automation-changed",
          action: "created",
          automationId: createdRoutineId,
          automationName: "Manual folder",
        },
      },
      {
        type: "event",
        event: {
          type: "automation-changed",
          action: "updated",
          automationId: createdRoutineId,
          automationName: "Renamed by folder",
        },
      },
      {
        type: "event",
        event: {
          type: "automation-changed",
          action: "enabled",
          automationId: createdRoutineId,
          automationName: "Renamed by folder",
        },
      },
      {
        type: "event",
        event: {
          type: "automation-changed",
          action: "disabled",
          automationId: createdRoutineId,
          automationName: "Renamed by folder",
        },
      },
    ]);
    expect(eventWakes).toHaveLength(4);
    expect(
      eventWakes.every((wake) => wake.origin === "event" && wake.type === "timeline.event")
    ).toBe(true);
    expect(eventWakes.map((wake) => wake.content.match(/- (.+)/)?.[1])).toEqual([
      'Created routine "Manual folder"',
      'Updated routine "Renamed by folder"',
      'Enabled routine "Renamed by folder"',
      'Disabled routine "Renamed by folder"',
    ]);
    await routineService.mutate(firstBotId, randomUUID(), null, {
      action: "update",
      id: createdRoutineId,
      name: "Renamed by folder",
      prompt: "Do not overwrite the manual directory.",
      enabled: false,
    });
    expect(eventWakes).toHaveLength(4);

    await routineService.mutate(firstBotId, randomUUID(), null, {
      action: "update",
      id: createdRoutineId,
      name: "Mixed authored and enabled edit",
      enabled: true,
    });
    expect(eventWakes).toHaveLength(5);
    expect(eventWakes.at(-1)?.content).toContain(
      'Updated routine "Mixed authored and enabled edit"'
    );

    const runningMessage = await prisma.message.create({
      data: {
        botId: firstBotId,
        conversationId: firstConversationId,
        role: "user",
        content: "Active lane fixture",
        status: "completed",
      },
    });
    const runningRun = await prisma.run.create({
      data: {
        botId: firstBotId,
        conversationId: firstConversationId,
        userMessageId: runningMessage.id,
        status: "running",
        origin: "user",
        channelId: firstChannelId,
      },
    });
    await prisma.message.update({
      where: { id: runningMessage.id },
      data: { runId: runningRun.id },
    });
    await prisma.botRunLease.create({
      data: {
        botId: firstBotId,
        runId: runningRun.id,
        ownerId: "timeline-event-parity-test",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await routineService.mutate(firstBotId, randomUUID(), null, {
      action: "update",
      id: createdRoutineId,
      prompt: "Changed while the Bot is running.",
    });
    expect(eventWakes).toHaveLength(5);
    expect(
      await prisma.channelMessage.count({
        where: {
          channelId: firstChannelId,
          sender: "system",
          metadata: { path: ["event", "type"], equals: "automation-changed" },
        },
      })
    ).toBe(6);
    await prisma.botRunLease.delete({ where: { botId: firstBotId } });
    await prisma.run.update({ where: { id: runningRun.id }, data: { status: "completed" } });
    timelineSessionActive = false;
    await routineService.mutate(firstBotId, randomUUID(), null, {
      action: "update",
      id: createdRoutineId,
      prompt: "Changed while another chat is active.",
    });
    expect(eventWakes).toHaveLength(5);
    expect(
      await prisma.channelMessage.count({
        where: {
          channelId: firstChannelId,
          sender: "system",
          metadata: { path: ["event", "type"], equals: "automation-changed" },
        },
      })
    ).toBe(6);
    timelineSessionActive = true;
    const groupRoutine = await routineService.mutateOwner(
      { kind: "group", id: groupId },
      randomUUID(),
      null,
      {
        action: "create",
        name: "Room digest",
        prompt: "Summarize the room.",
        schedule: "@daily",
        enabled: false,
      }
    );
    const groupRoutineId = String(groupRoutine.id);
    await routineService.mutateOwner({ kind: "group", id: groupId }, randomUUID(), null, {
      action: "update",
      id: groupRoutineId,
      name: "Room digest updated",
    });
    await routineService.mutateOwner({ kind: "group", id: groupId }, randomUUID(), null, {
      action: "resume",
      id: groupRoutineId,
    });
    await routineService.mutateOwner({ kind: "group", id: groupId }, randomUUID(), null, {
      action: "pause",
      id: groupRoutineId,
    });
    expect(
      (
        await prisma.channelMessage.findMany({
          where: { channelId: groupId, sender: "system" },
          orderBy: { sequence: "asc" },
          select: { metadata: true },
        })
      ).map((message) => message.metadata)
    ).toEqual([]);
    expect(eventWakes).toHaveLength(5);
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
    await eventually(
      () =>
        prisma.channelMessage.findFirst({
          where: {
            channelId: firstChannelId,
            sender: "system",
            metadata: { path: ["event", "type"], equals: "name-changed" },
          },
          orderBy: { sequence: "desc" },
        }),
      (message) => Boolean(message),
      "profile name-change timeline event"
    );
    expect(eventWakes).toHaveLength(6);
    expect(eventWakes.at(-1)?.content).toContain("- Renamed to Renamed on disk");

    const frozenIdentity = await store.promptContext(firstBotId);
    expect(frozenIdentity.profileSection).toBe(initialPrompt.profileSection);
    expect(frozenIdentity.identityAnnouncement).toContain("Renamed on disk");
    expect((await store.promptContext(firstBotId)).identityAnnouncement).toContain(
      "Renamed on disk"
    );
    await store.acknowledgeIdentityAnnouncement(firstBotId);
    expect((await store.promptContext(firstBotId)).identityAnnouncement).toBe("");

    const skillDirectory = join(root, "workflows", skillSlug);
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
          where: { slug: skillSlug },
        }),
      (skill) => skill?.body.includes("Follow the filesystem contract") === true,
      "skill creation watcher"
    );
    await eventually(
      () =>
        prisma.event.findFirst({
          where: { topic: "bot.state.filesystem_changed", entityId: null },
          orderBy: { sequence: "desc" },
        }),
      (event) =>
        Boolean(
          event?.payload &&
            typeof event.payload === "object" &&
            !Array.isArray(event.payload) &&
            (event.payload as { scope?: unknown }).scope === "workflows"
        ),
      "global workflow watcher event"
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
      jsonFile({
        name: "Renamed watcher room",
        description: "Coordinates watcher parity.",
      })
    );
    await eventually(
      () => prisma.channel.findUnique({ where: { id: groupId } }),
      (channel) =>
        channel?.name === "Renamed watcher room" &&
        channel.description === "Coordinates watcher parity.",
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
          where: { slug: skillSlug },
        }),
      (skill) => skill === null,
      "skill deletion watcher"
    );

    const malformedSettings = "{ definitely not valid json\n";
    await atomicWrite(join(firstDirectory, "settings.json"), malformedSettings);
    await eventually(
      () => prisma.bot.findUnique({ where: { id: firstBotId } }),
      (bot) => bot?.notificationsEnabled === true && bot.hiddenFromSidebar === false,
      "malformed settings fallback"
    );
    expect(await readFile(join(firstDirectory, "settings.json"), "utf8")).toBe(malformedSettings);
    await store.writeBotFiles(firstBotId, ["settings"]);
    expect(JSON.parse(await readFile(join(firstDirectory, "settings.json"), "utf8"))).toEqual({
      notifyOnAgentUpdates: true,
      hiddenFromSidebar: false,
    });
    await atomicWrite(
      join(firstDirectory, "settings.json"),
      jsonFile({ notifyOnAgentUpdates: false, hiddenFromSidebar: false, extra: "keep" })
    );
    await store.writeBotSettings(firstBotId, { hiddenFromSidebar: true });
    expect(JSON.parse(await readFile(join(firstDirectory, "settings.json"), "utf8"))).toEqual({
      notifyOnAgentUpdates: false,
      hiddenFromSidebar: true,
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
      (profile) => profile?.name === "New Bot",
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

    await prisma.bot.update({ where: { id: firstBotId }, data: { episodePending: 5 } });
    for (let index = 0; index < 13; index += 1) {
      await dreamingStore.recordTurnMemory(firstBotId, {
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
    await expect(store.loadInferenceSettings()).rejects.toThrow("settings.json");
    expect(malformedRootSettings.settings).toMatchObject({
      version: 1,
      inference: {
        providerId: "openai-codex",
        modelId: "gpt-5.5",
        reasoning: "high",
      },
      mcpBoxServers: [],
      autoUpdateWhenIdleOptIn: false,
      egressTunnelEnabled: false,
      webauthnProxyEnabled: true,
      conciergeConsent: "unset",
      accountScopes: {},
    });
    const writtenRootSettings = await store.writeRootSettings({
      userTimeZone: "Europe/London",
      themePreference: "dark",
    });
    expect(writtenRootSettings).toMatchObject({
      version: 1,
      userTimeZone: "Europe/London",
      themePreference: "dark",
    });
    await Promise.all([
      store.writeRootSettings({ userTimeZone: "America/New_York" }),
      store.writeRootSettings({ languagePreference: "fr" }),
    ]);
    expect((await store.loadRootSettings()).settings).toMatchObject({
      userTimeZone: "America/New_York",
      languagePreference: "fr",
      themePreference: "dark",
    });
    expect((await store.loadRootSettings()).valid).toBe(true);
    await store.writeInferenceSettings({
      providerId: "anthropic",
      modelId: "claude-sonnet-4-5",
      reasoning: "medium",
    });
    expect((await store.loadRootSettings()).settings.inference).toEqual({
      providerId: "anthropic",
      modelId: "claude-sonnet-4-5",
      reasoning: "medium",
    });
    await store.writeSidebarPreferences({
      version: 2,
      pinnedIds: [firstChannelId],
      unreadIds: ["local-only-unread"],
      unassignedCollapsed: true,
      sections: [{ id: "work", name: "Work", collapsed: true }],
      sectionByChannel: { [secondChannelId]: "work" },
      channelOrderByGroup: { work: [secondChannelId] },
    });
    const persistedRootSettings = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
    expect(persistedRootSettings.sidebarPreferences).toBeUndefined();
    expect(persistedRootSettings.pinnedAgentIds).toEqual([firstBotId]);
    expect(persistedRootSettings.sidebarSections).toEqual([
      {
        id: "work",
        name: "Work",
        agentIds: [secondBotId],
        isCollapsed: true,
      },
      {
        id: "__agents__",
        name: "Unassigned",
        agentIds: [],
        isCollapsed: false,
      },
    ]);
    expect((await store.loadRootSettingsForClient()).settings).toMatchObject({
      pinnedAgentIds: [firstChannelId],
      sidebarSections: [
        {
          id: "work",
          agentIds: [secondChannelId],
        },
        {
          id: "__agents__",
          agentIds: [],
        },
      ],
    });
    expect(persistedRootSettings).toMatchObject({
      mcpBoxServers: [],
      autoUpdateWhenIdleOptIn: false,
      egressTunnelEnabled: false,
      webauthnProxyEnabled: true,
      conciergeConsent: "unset",
      accountScopes: {},
    });
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
}, 90_000);
