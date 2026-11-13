import { expect } from "bun:test";
import { access, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { AssetStore, RoutineService } from "@openteam/messaging";
import { Effect } from "effect";
import { BotService } from "../src/services/bot-service";
import { ScreenService } from "../src/services/screen-service";
import { dbIt, fakeBoss } from "./harness";

dbIt("canonical avatars serve safely and sidebar deletion preserves global memory shards", async h => {
  const { db: prisma, store, dir: workspace } = h;
  const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const bot = await h.bot("File lifecycle", { defaultDirectory: join(workspace, "bots", "owner") }), botId = bot.id;
  h.onClose(() => prisma.memoryFact.deleteMany({ where: { writtenByBotId: botId } }));
  const child = await h.bot("Disposable child", { hiddenFromSidebar: true }, { dm: false });
  await prisma.subagent.create({ data: {
    parentBotId: botId, childBotId: child.id, parentRunId: crypto.randomUUID(), parentChannelId: bot.channelId!, launchCallId: crypto.randomUUID(), description: "Disposable child",
    prompt: "Return immediately.", subagentType: "executor", status: "completed", result: "done", outputPath: join(store.root, "agent-transcripts", child.id, `${child.id}.jsonl`),
  } });
  const routine = await prisma.routine.create({ data: {
    botId, slug: "delete-with-agent", name: "Delete with agent", prompt: "This must not survive agent deletion.", trigger: { type: "cron", schedule: "0 11 * * 1-5" },
    scheduleText: "0 11 * * 1-5", scheduleKind: "cron", cronExpression: "0 11 * * 1-5", timezone: "UTC", nextRunAt: new Date(Date.now() + 60_000),
  } });
  await store.writeActiveAgentId(botId);
  const agentDirectory = store.botDirectory(botId), childAgentDirectory = store.botDirectory(child.id);
  const avatarSource = join(agentDirectory, "avatar-source.png");
  await writeFile(avatarSource, imageBytes);
  await store.setAvatarFromPath(botId, avatarSource);
  await rm(avatarSource);

  const screens = new ScreenService(prisma, store.root, "127.0.0.1", async () => new Response());
  const served = await Effect.runPromise(screens.avatar(botId));
  expect(served.contentType).toBe("image/png");
  expect(new Uint8Array(served.bytes)).toEqual(imageBytes);
  // A symlink out of the agent directory or an oversized file is never served.
  const canonicalAvatar = join(agentDirectory, "avatar.png"), outsideAvatar = join(workspace, "outside.png");
  await writeFile(outsideAvatar, imageBytes);
  await rm(canonicalAvatar);
  await symlink(outsideAvatar, canonicalAvatar);
  await expect(Effect.runPromise(screens.avatar(botId))).rejects.toThrow("Bot avatar is unavailable");
  await rm(canonicalAvatar);
  await writeFile(canonicalAvatar, new Uint8Array(5 * 1024 * 1024 + 1));
  await expect(Effect.runPromise(screens.avatar(botId))).rejects.toThrow("Bot avatar is unavailable");
  await rm(canonicalAvatar);
  await writeFile(canonicalAvatar, imageBytes);
  await store.reconcileBot(botId);

  const a2aImageSource = join(workspace, "a2a-reference.png");
  await writeFile(a2aImageSource, imageBytes);
  const assets = new AssetStore({ root: store.assetRoot, allowedFileRoots: [workspace] });
  const a2aImage = await assets.ingestSource({ url: pathToFileURL(a2aImageSource).toString(), alt: "A2A reference" });
  const paths = await store.materializeAttachments(botId, "a2a-file-image", [a2aImage]);
  expect(paths.map(path => basename(path))).toEqual([`${a2aImage.assetId}.png`]);
  expect(new Uint8Array(await readFile(paths[0]!))).toEqual(imageBytes);
  expect(await store.materializeAttachments(botId, "same-bytes-second-message", [a2aImage])).toEqual(paths);
  await store.writeMemory(botId, { scope: "user", tier: "profile", fact: "Keep user memory." }, { source: "tool" });

  const bots = new BotService(prisma, fakeBoss(), workspace, async () => new Response(null, { status: 204 }), store);
  expect(await Effect.runPromise(bots.archive(botId))).toEqual({ ok: true });
  expect(await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).toMatchObject({ status: "archived", avatarPath: null });
  const archivedRoutine = await prisma.routine.findUniqueOrThrow({ where: { id: routine.id } });
  expect(archivedRoutine).toMatchObject({ enabled: false, nextRunAt: null });
  expect(archivedRoutine.deletedAt).not.toBeNull();
  await expect(access(agentDirectory)).rejects.toThrow();
  await expect(access(childAgentDirectory)).rejects.toThrow();
  // Late writers cannot recreate the retired agent's files or schedule.
  await store.writeRoutine(botId, routine.id);
  await expect(access(agentDirectory)).rejects.toThrow();
  const routines = new RoutineService(prisma, { enqueueWake: async () => { throw new Error("not used by this test"); } }, store);
  await expect(routines.mutate(botId, crypto.randomUUID(), null, { action: "create", name: "Late routine", prompt: "This must remain impossible after archival.", schedule: "@daily" })).rejects.toThrow("inactive bot");
  const successor = await store.loadActiveAgentId();
  expect(successor).not.toBe(botId);
  if (successor) expect((await prisma.bot.findUniqueOrThrow({ where: { id: successor } })).status).toBe("active");
  expect(await prisma.memoryFact.count({ where: { namespace: `user:agent:${botId}`, fact: "Keep user memory." } })).toBe(1);
});
