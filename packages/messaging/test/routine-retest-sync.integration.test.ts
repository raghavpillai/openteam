import { afterEach, expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "../src/agent-data";
import { RoutineService } from "../src/routines";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;
const integration = url ? test : test.skip;
const at = new Date("2026-11-12T17:00:00Z");
afterEach(() => setSystemTime());

async function fixture() {
  const db = createPrismaClient(url!);
  const root = await mkdtemp(join(tmpdir(), "openteam-routine-retest-sync-"));
  const botId = randomUUID(), channelId = randomUUID(), conversationId = randomUUID();
  const store = new AgentDataStore(db, { root, workspaceRoot: root });
  const other = new AgentDataStore(db, { root, workspaceRoot: root });
  await db.userTimeZoneSettings.upsert({ where: { id: "global" }, create: { id: "global", detected: "UTC" }, update: { detected: "UTC", override: null } });
  await db.bot.create({ data: { id: botId, name: "Sync stress", status: "active", defaultDirectory: root, conversation: { create: { id: conversationId } } } });
  await db.channel.create({ data: { id: channelId, kind: "bot_dm", name: "Sync stress", directKey: `bot:${botId}` } });
  const host = { isTimelineSessionActive: async () => false, enqueueWake: async (tx: any) => ({ run: await tx.run.create({ data: { botId, conversationId, channelId, userMessageId: randomUUID(), origin: "routine" } }) }) };
  const service = new RoutineService(db, host, store);
  const read = (id: string) => db.routine.findUniqueOrThrow({ where: { id } });
  const path = (slug: string) => join(store.botDirectory(botId), "automations", slug, "automation.json");
  const create = async (name = "Schedule", callId: string = randomUUID()) => {
    const created = await service.mutate(botId, callId, null, { action: "create", name, prompt: "Original instructions", schedule: "@every 5m" });
    return read(String(created.id));
  };
  const sync = () => store.reconcileAutomationFilesBatch(null, 100);
  const close = async () => {
    await Promise.all([store.stopWatching(), other.stopWatching()]);
    const ids = (await db.routine.findMany({ where: { botId }, select: { id: true } })).map(r => r.id);
    const executions = (await db.routineExecution.findMany({ where: { routineId: { in: ids } }, select: { id: true } })).map(r => r.id);
    await db.routineExecution.deleteMany({ where: { routineId: { in: ids } } });
    await db.routineRevision.deleteMany({ where: { routineId: { in: ids } } });
    await db.routine.deleteMany({ where: { id: { in: ids } } });
    await db.event.deleteMany({ where: { entityId: { in: [...ids, ...executions] } } });
    await db.bot.delete({ where: { id: botId } });
    await db.channel.delete({ where: { id: channelId } });
    await db.$disconnect();
    await rm(root, { recursive: true, force: true });
  };
  return { db, root, botId, store, other, service, read, path, create, sync, close };
}

async function rollbackCreation(f: Awaited<ReturnType<typeof fixture>>, callId: string) {
  const write = f.store.writeRoutine.bind(f.store);
  let fail = true;
  f.store.writeRoutine = async (...args) => {
    await write(...args);
    if (fail) { fail = false; throw new Error("creation projection committed to disk, transaction rolled back"); }
  };
  await expect(f.create("Zulu failed create", callId)).rejects.toThrow("transaction rolled back");
  expect(await f.db.routine.count({ where: { botId: f.botId } })).toBe(0);
  const slug = (await f.store.listRoutineFolderIds(f.botId))[0]!;
  const text = await readFile(f.path(slug), "utf8");
  return { slug, text, projection: JSON.parse(text).projection };
}

integration("same-call retry immediately after create rollback recovers the disk receipt before any watcher pass", async () => {
  setSystemTime(at);
  const f = await fixture();
  try {
    const callId = randomUUID(), orphan = await rollbackCreation(f, callId);
    const retried = await f.create("Edited uncertain retry", callId);
    await f.sync();
    const rows = await f.db.routine.findMany({ where: { botId: f.botId }, orderBy: { slug: "asc" } });
    expect({ retryId: retried.id, rows: rows.map(r => ({ id: r.id, slug: r.slug })) }).toEqual({
      retryId: orphan.projection.routineId,
      rows: [{ id: orphan.projection.routineId, slug: orphan.slug }],
    });
    expect(retried.name).toBe("Zulu failed create");
  } finally { await f.close(); }
});

for (const edited of [false, true]) {
integration(`an ${edited ? "edited" : "identical"} copy scanned before a rolled-back source cannot steal its UUID or creation receipt`, async () => {
  setSystemTime(at);
  const f = await fixture();
  try {
    const callId = randomUUID(), orphan = await rollbackCreation(f, callId);
    const copySlug = "aaa-copied-orphan";
    await mkdir(join(f.path(copySlug), ".."), { recursive: true });
    await writeFile(f.path(copySlug), edited
      ? JSON.stringify({ ...JSON.parse(orphan.text), prompt: "Independently edited copied instructions" })
      : orphan.text);
    expect((await f.sync()).warnings).toEqual([]);
    const original = await f.db.routine.findUniqueOrThrow({ where: { botId_slug: { botId: f.botId, slug: orphan.slug } } });
    const copy = await f.db.routine.findUniqueOrThrow({ where: { botId_slug: { botId: f.botId, slug: copySlug } } });
    expect({ originalId: original.id, copyStoleSourceId: copy.id === orphan.projection.routineId }).toEqual({
      originalId: orphan.projection.routineId,
      copyStoleSourceId: false,
    });
    expect((await f.create("Retry", callId)).id).toBe(original.id);
    expect((await f.db.routineRevision.findUniqueOrThrow({ where: { routineId_revision: { routineId: copy.id, revision: 1 } } })).callId).toBeNull();
  } finally { await f.close(); }
});
}

integration("renaming a sole rolled-back folder recovers its UUID and creation receipt at its new path", async () => {
  setSystemTime(at);
  const f = await fixture();
  try {
    const callId = randomUUID(), orphan = await rollbackCreation(f, callId);
    const renamed = "renamed-before-recovery";
    await rename(join(f.path(orphan.slug), ".."), join(f.path(renamed), ".."));
    expect((await f.sync()).warnings).toEqual([]);
    const recovered = await f.read(orphan.projection.routineId);
    expect(recovered).toMatchObject({ slug: renamed, prompt: "Original instructions", enabled: true });
    expect((await f.create("Retry", callId)).id).toBe(recovered.id);
    expect(await f.db.routine.count({ where: { botId: f.botId } })).toBe(1);
  } finally { await f.close(); }
});

integration("an invalid new folder becomes one paused routine after correction without disabling its healthy sibling", async () => {
  setSystemTime(at);
  const f = await fixture();
  try {
    const healthy = await f.create("Healthy sibling");
    const slug = "invalid-new-folder";
    await mkdir(join(f.path(slug), ".."), { recursive: true });
    await writeFile(f.path(slug), "{ unfinished new definition");
    expect((await f.sync()).warnings).toHaveLength(1);
    expect(await f.db.routine.count({ where: { botId: f.botId } })).toBe(1);
    expect(await f.read(healthy.id)).toMatchObject({ enabled: true, validationError: null, nextRunAt: healthy.nextRunAt });
    await writeFile(f.path(slug), JSON.stringify({ name: "Corrected paused", prompt: "Repaired instructions", schedule: "@every 10m", enabled: false }));
    expect((await f.sync()).warnings).toEqual([]);
    expect((await f.sync()).warnings).toEqual([]);
    const imported = await f.db.routine.findUniqueOrThrow({ where: { botId_slug: { botId: f.botId, slug } } });
    expect(imported).toMatchObject({ enabled: false, nextRunAt: null, validationError: null });
    expect(await f.db.routineRevision.count({ where: { routineId: imported.id } })).toBe(1);
    expect(await f.read(healthy.id)).toMatchObject({ enabled: true, validationError: null, nextRunAt: healthy.nextRunAt });
  } finally { await f.close(); }
});

integration("concurrent immediate retries after a second recovery rollback retain one original receipt despite broken history", async () => {
  setSystemTime(at);
  const f = await fixture();
  try {
    const callId = randomUUID(), orphan = await rollbackCreation(f, callId);
    await writeFile(join(f.path(orphan.slug), "..", "runs.json"), "{ invalid recoverable history");
    const recover = f.store.recoverRoutineCreation.bind(f.store);
    let crash = true;
    f.store.recoverRoutineCreation = async (...args) => {
      await recover(...args);
      if (crash) { crash = false; throw new Error("rollback after retry recovery"); }
    };
    await expect(f.create("Changed retry", callId)).rejects.toThrow("rollback after retry recovery");
    expect(await f.db.routine.count({ where: { botId: f.botId } })).toBe(0);
    expect(JSON.parse(await readFile(f.path(orphan.slug), "utf8")).projection.creationCallId).toBe(callId);
    const recovered = await Promise.all(Array.from({ length: 4 }, () => f.create("Concurrent retry", callId)));
    expect(recovered.map(r => r.id)).toEqual(Array(4).fill(orphan.projection.routineId));
    expect(await f.db.routine.count({ where: { botId: f.botId } })).toBe(1);
    expect(await f.db.routineRevision.count({ where: { routine: { botId: f.botId }, callId } })).toBe(1);
  } finally { await f.close(); }
});

integration("an invalid orphan definition blocks uncertain retry until a paused correction can recover its original ID", async () => {
  setSystemTime(at);
  const f = await fixture();
  try {
    const callId = randomUUID(), orphan = await rollbackCreation(f, callId);
    const document = JSON.parse(orphan.text);
    await writeFile(f.path(orphan.slug), JSON.stringify({ ...document, trigger: { type: "invalid" } }));
    await expect(f.create("Uncertain retry", callId)).rejects.toThrow("Cannot recover routine creation");
    expect(await f.db.routine.count({ where: { botId: f.botId } })).toBe(0);
    await writeFile(f.path(orphan.slug), JSON.stringify({ ...document, enabled: false, prompt: "Corrected paused instructions" }));
    const recovered = await f.create("Retry after correction", callId);
    expect(recovered).toMatchObject({ id: orphan.projection.routineId, enabled: false, nextRunAt: null, prompt: "Corrected paused instructions" });
    expect(await f.db.routine.count({ where: { botId: f.botId } })).toBe(1);
    expect((await f.sync()).warnings).toEqual([]);
    expect(await f.read(recovered.id)).toMatchObject({ enabled: false, nextRunAt: null, validationError: null });
  } finally { await f.close(); }
});

integration("copying an orphan projection across bots cannot transfer the source creation identity", async () => {
  setSystemTime(at);
  const source = await fixture(), destination = await fixture();
  try {
    const callId = randomUUID(), orphan = await rollbackCreation(source, callId);
    const copySlug = "copied-between-bots";
    await mkdir(join(destination.path(copySlug), ".."), { recursive: true });
    await writeFile(destination.path(copySlug), orphan.text);
    expect((await destination.sync()).warnings).toEqual([]);
    const copy = await destination.db.routine.findUniqueOrThrow({ where: { botId_slug: { botId: destination.botId, slug: copySlug } } });
    expect(copy.id).not.toBe(orphan.projection.routineId);
    expect((await destination.db.routineRevision.findUniqueOrThrow({ where: { routineId_revision: { routineId: copy.id, revision: 1 } } })).callId).toBeNull();
    expect((await source.create("Retry source", callId)).id).toBe(orphan.projection.routineId);
    expect((await source.read(orphan.projection.routineId)).botId).toBe(source.botId);
  } finally { await destination.close(); await source.close(); }
});

integration("ambiguous legacy orphan copies require disambiguation without assigning arbitrary instructions to a receipt", async () => {
  setSystemTime(at);
  const f = await fixture();
  try {
    const callId = randomUUID(), orphan = await rollbackCreation(f, callId);
    const legacy = JSON.parse(orphan.text);
    delete legacy.projection.originBotId;
    delete legacy.projection.originSlug;
    const copySlug = "aaa-legacy-copy";
    await writeFile(f.path(orphan.slug), JSON.stringify(legacy));
    await mkdir(join(f.path(copySlug), ".."), { recursive: true });
    await writeFile(f.path(copySlug), JSON.stringify({ ...legacy, prompt: "Different copied instructions" }));
    const first = await f.sync();
    expect(first.warnings).toHaveLength(2);
    expect(first.warnings.every(w => w.includes("Ambiguous routine recovery"))).toBe(true);
    expect(await f.db.routine.count({ where: { botId: f.botId } })).toBe(0);
    await expect(f.create("Retry before disambiguation", callId)).rejects.toThrow("Ambiguous routine recovery");
    expect(await f.db.routine.count({ where: { botId: f.botId } })).toBe(0);
    const copy = { ...legacy, prompt: "Different copied instructions" };
    delete copy.projection;
    await writeFile(f.path(copySlug), JSON.stringify(copy));
    expect((await f.create("Retry after disambiguation", callId)).id).toBe(orphan.projection.routineId);
    expect((await f.sync()).warnings).toEqual([]);
    expect((await f.read(orphan.projection.routineId)).prompt).toBe("Original instructions");
    expect(await f.db.routine.count({ where: { botId: f.botId } })).toBe(2);
  } finally { await f.close(); }
});

integration("unchanged mixed-listener files and prompt-only file edits preserve revision and relative cadence", async () => {
  setSystemTime(at);
  const f = await fixture();
  try {
    const result = await f.service.mutate(f.botId, randomUUID(), null, {
      action: "create", name: "Mixed key ordering", prompt: "Original instructions",
      trigger: { type: "group", listeners: [
        { type: "github", repo: "openai/example", events: ["pr-merged"], pr: 7 },
        { type: "cron", schedule: "@every 10m" },
        { type: "cron", schedule: "@every 15m" },
      ] },
    });
    const before = await f.read(String(result.id));
    setSystemTime(new Date(at.getTime() + 3 * 60_000));
    for (let i = 0; i < 3; i++) expect((await f.sync()).warnings).toEqual([]);
    expect(await f.read(before.id)).toMatchObject({ revision: before.revision, scheduleAnchorAt: before.scheduleAnchorAt, nextRunAt: before.nextRunAt, trigger: before.trigger });
    const document = JSON.parse(await readFile(f.path(before.slug), "utf8"));
    await writeFile(f.path(before.slug), JSON.stringify({ ...document, prompt: "File-only instruction update" }));
    expect((await f.sync()).warnings).toEqual([]);
    expect(await f.read(before.id)).toMatchObject({ revision: before.revision + 1, scheduleAnchorAt: before.scheduleAnchorAt, nextRunAt: before.nextRunAt, trigger: before.trigger, prompt: "File-only instruction update" });
    expect((await f.sync()).warnings).toEqual([]);
    expect((await f.read(before.id)).revision).toBe(before.revision + 1);
  } finally { await f.close(); }
});

