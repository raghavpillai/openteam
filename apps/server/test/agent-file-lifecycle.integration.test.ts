import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createPrismaClient } from "@openbot/db";
import { AgentDataStore, RoutineService } from "@openbot/messaging";
import { Effect } from "effect";
import type { PgBoss } from "pg-boss";
import { BotService } from "../src/services/bot-service";
import { ScreenService } from "../src/services/screen-service";

const databaseUrl = process.env.OPENBOT_TEST_DATABASE_URL;

test("canonical avatars serve safely and sidebar deletion preserves global memory shards", async () => {
  if (!databaseUrl) return;

  const prisma = createPrismaClient(databaseUrl);
  const temporary = await mkdtemp(join(tmpdir(), "openbot-agent-lifecycle-"));
  const root = join(temporary, "agent-data");
  const workspace = join(temporary, "workspace");
  const botId = crypto.randomUUID();
  const channelId = crypto.randomUUID();
  const routineId = crypto.randomUUID();
  const store = new AgentDataStore(prisma, { root, workspaceRoot: workspace });
  const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  try {
    await mkdir(workspace, { recursive: true });
    await prisma.bot.create({
      data: {
        id: botId,
        name: "File lifecycle",
        defaultDirectory: join(workspace, "bots", botId),
        status: "active",
        conversation: { create: {} },
      },
    });
    await prisma.channel.create({
      data: {
        id: channelId,
        kind: "bot_dm",
        name: "File lifecycle",
        directKey: `bot:${botId}`,
        members: { create: { botId, ordinal: 0 } },
      },
    });
    await prisma.routine.create({
      data: {
        id: routineId,
        botId,
        slug: "delete-with-agent",
        name: "Delete with agent",
        prompt: "This must not survive agent deletion.",
        trigger: { type: "cron", schedule: "0 11 * * 1-5" },
        scheduleText: "0 11 * * 1-5",
        scheduleKind: "cron",
        cronExpression: "0 11 * * 1-5",
        timezone: "UTC",
        nextRunAt: new Date(Date.now() + 60_000),
      },
    });
    await store.initializeBot(botId);
    await store.writeActiveAgentId(botId);
    const agentDirectory = store.botDirectory(botId);
    const avatarSource = join(agentDirectory, "avatar-source.png");
    await writeFile(avatarSource, imageBytes);
    await store.setAvatarFromPath(botId, avatarSource);
    await rm(avatarSource);

    const screens = new ScreenService(prisma, root, "127.0.0.1", async () => new Response());
    const served = await Effect.runPromise(screens.avatar(botId));
    expect(served.contentType).toBe("image/png");
    expect(new Uint8Array(served.bytes)).toEqual(imageBytes);

    const outsideAvatar = join(temporary, "outside.png");
    const canonicalAvatar = join(agentDirectory, "avatar.png");
    await writeFile(outsideAvatar, imageBytes);
    await rm(canonicalAvatar);
    await symlink(outsideAvatar, canonicalAvatar);
    await expect(Effect.runPromise(screens.avatar(botId))).rejects.toThrow(
      "Bot avatar is unavailable"
    );
    await rm(canonicalAvatar);
    await writeFile(canonicalAvatar, new Uint8Array(5 * 1024 * 1024 + 1));
    await expect(Effect.runPromise(screens.avatar(botId))).rejects.toThrow(
      "Bot avatar is unavailable"
    );
    await rm(canonicalAvatar);
    await writeFile(canonicalAvatar, imageBytes);
    await store.reconcileBot(botId);
    const a2aImageSource = join(workspace, "a2a-reference.png");
    await writeFile(a2aImageSource, imageBytes);
    const a2aAttachmentPaths = await store.materializeAttachments(botId, "a2a-file-image", [
      { url: pathToFileURL(a2aImageSource).toString(), alt: "A2A reference" },
    ]);
    expect(a2aAttachmentPaths).toHaveLength(1);
    expect(new Uint8Array(await readFile(a2aAttachmentPaths[0]!))).toEqual(imageBytes);

    const userShard = join(root, "user-memory", "by-agent", botId, "profile.md");
    const projectShard = join(
      root,
      "projects",
      "lifecycle",
      "memory",
      "by-agent",
      botId,
      "profile.md"
    );
    await mkdir(join(userShard, ".."), { recursive: true });
    await mkdir(join(projectShard, ".."), { recursive: true });
    await writeFile(userShard, "- (2026-08-27) Keep user memory.\n");
    await writeFile(projectShard, "- (2026-08-27) Keep project memory.\n");

    const bots = new BotService(
      prisma,
      {} as PgBoss,
      workspace,
      async () => new Response(null, { status: 204 }),
      store
    );
    expect(await Effect.runPromise(bots.archive(botId))).toEqual({ ok: true });
    expect(await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).toMatchObject({
      status: "archived",
      avatarPath: null,
    });
    expect(await prisma.routine.findUniqueOrThrow({ where: { id: routineId } })).toMatchObject({
      enabled: false,
      nextRunAt: null,
    });
    expect(
      (await prisma.routine.findUniqueOrThrow({ where: { id: routineId } })).deletedAt
    ).not.toBeNull();
    await expect(access(agentDirectory)).rejects.toThrow();
    await store.writeRoutine(botId, routineId);
    await expect(access(agentDirectory)).rejects.toThrow();
    expect(
      await store.materializeAttachments(botId, "late-message", [
        { url: `data:image/png;base64,${Buffer.from(imageBytes).toString("base64")}` },
      ])
    ).toEqual([]);
    await expect(access(agentDirectory)).rejects.toThrow();
    const routines = new RoutineService(
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
    await expect(
      routines.mutate(botId, crypto.randomUUID(), null, {
        action: "create",
        name: "Late routine",
        prompt: "This must remain impossible after archival.",
        schedule: "@daily",
      })
    ).rejects.toThrow("inactive bot");
    const successor = await store.loadActiveAgentId();
    expect(successor).not.toBe(botId);
    if (successor) {
      expect(await prisma.bot.findUniqueOrThrow({ where: { id: successor } })).toMatchObject({
        status: "active",
      });
    }
    expect(await readFile(userShard, "utf8")).toContain("Keep user memory");
    expect(await readFile(projectShard, "utf8")).toContain("Keep project memory");
  } finally {
    await prisma.bot.deleteMany({ where: { id: botId } }).catch(() => undefined);
    await prisma.channel.deleteMany({ where: { id: channelId } }).catch(() => undefined);
    await prisma.$disconnect();
    await rm(temporary, { recursive: true, force: true });
  }
});
