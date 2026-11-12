import { afterEach, expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const root = await mkdtemp(join(tmpdir(), "openteam-routine-sync-stress-"));
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
  const create = async (name = "Schedule", callId = randomUUID()) => {
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

for (const edit of ["invalid", "valid"] as const) {
  integration(`runtime projection preserves an unimported ${edit} authored edit before quarantine`, async () => {
    setSystemTime(at);
    const f = await fixture();
    try {
      const routine = await f.create();
      const document = JSON.parse(await readFile(f.path(routine.slug), "utf8"));
      const edited = edit === "invalid" ? "{ user is still editing" : JSON.stringify({ ...document, prompt: "New authored instructions" });
      await writeFile(f.path(routine.slug), edited);
      await f.store.writeRoutine(f.botId, routine.id);
      expect(await readFile(f.path(routine.slug), "utf8")).toBe(edited);
      await f.sync();
      expect(await f.read(routine.id)).toMatchObject(edit === "invalid" ? { enabled: false } : { prompt: "New authored instructions", enabled: true });
    } finally { await f.close(); }
  });
}

integration("two store instances import one new authored folder once", async () => {
  setSystemTime(at);
  const f = await fixture();
  try {
    await mkdir(join(f.path("new-file"), ".."), { recursive: true });
    await writeFile(f.path("new-file"), JSON.stringify({ name: "New file", prompt: "Imported instructions", schedule: "@every 5m", createdAt: at.getTime() }));
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? f.store : f.other).reconcileAutomationFilesBatch(null, 100)));
    expect(results.flatMap(r => r.warnings)).toEqual([]);
    expect(await f.db.routine.count({ where: { botId: f.botId } })).toBe(1);
    expect(await f.db.routineRevision.count({ where: { routine: { botId: f.botId } } })).toBe(1);
  } finally { await f.close(); }
});

integration("two sync instances racing scheduled dispatch preserve every committed occurrence once", async () => {
  setSystemTime(at);
  const f = await fixture();
  try {
    const routine = await f.create();
    for (let tick = 1; tick <= 12; tick++) {
      const due = new Date(at.getTime() + tick * 5 * 60_000);
      setSystemTime(due);
      const [count, a, b] = await Promise.all([f.service.dispatchDue(due), f.sync(), f.other.reconcileAutomationFilesBatch(null, 100)]);
      expect(count).toBe(1);
      expect([...a.warnings, ...b.warnings]).toEqual([]);
      const current = await f.read(routine.id);
      expect(current.lastRunAt).toEqual(due);
      expect(current.nextRunAt).toEqual(new Date(due.getTime() + 5 * 60_000));
      await f.db.routineExecution.updateMany({ where: { routineId: routine.id }, data: { status: "completed", completedAt: due } });
      await f.db.run.updateMany({ where: { botId: f.botId }, data: { status: "completed", completedAt: due } });
    }
    expect(await f.db.routineExecution.count({ where: { routineId: routine.id } })).toBe(12);
    expect(await f.service.dispatchDue(new Date())).toBe(0);
  } finally { await f.close(); }
});

integration("a deleted routine remains deleted when an old untouched projection reappears during concurrent scans", async () => {
  setSystemTime(at);
  const f = await fixture();
  try {
    const routine = await f.create(), saved = await readFile(f.path(routine.slug), "utf8");
    await f.service.mutate(f.botId, randomUUID(), null, { action: "delete", id: routine.id });
    await mkdir(join(f.path(routine.slug), ".."), { recursive: true });
    await writeFile(f.path(routine.slug), saved);
    await Promise.all([f.sync(), f.other.reconcileAutomationFilesBatch(null, 100)]);
    expect(await f.read(routine.id)).toMatchObject({ enabled: false, nextRunAt: null });
    expect((await f.read(routine.id)).deletedAt).not.toBeNull();
    expect(await f.service.dispatchDue(new Date(at.getTime() + 24 * 3600_000))).toBe(0);
  } finally { await f.close(); }
});

integration("a pending authored prompt edit survives an API pause without resuming the routine", async () => {
  setSystemTime(at);
  const f = await fixture();
  try {
    const routine = await f.create();
    const document = JSON.parse(await readFile(f.path(routine.slug), "utf8"));
    await writeFile(f.path(routine.slug), JSON.stringify({ ...document, prompt: "Pending authored instructions", "x-user-field": "keep me" }));
    await f.service.mutate(f.botId, randomUUID(), null, { action: "pause", id: routine.id });
    await f.sync();
    expect(await f.read(routine.id)).toMatchObject({ prompt: "Pending authored instructions", enabled: false, nextRunAt: null });
    const acknowledged = JSON.parse(await readFile(f.path(routine.slug), "utf8"));
    expect(acknowledged.enabled).toBe(false);
    expect(acknowledged["x-user-field"]).toBe("keep me");
    await f.store.writeRoutine(f.botId, routine.id);
    expect((await f.sync()).warnings).toEqual([]);
    expect(await f.read(routine.id)).toMatchObject({ prompt: "Pending authored instructions", enabled: false, nextRunAt: null });
  } finally { await f.close(); }
});

integration("runtime projection cannot recreate a user-deleted definition before reconciliation", async () => {
  setSystemTime(at);
  const f = await fixture();
  try {
    const routine = await f.create();
    await rm(f.path(routine.slug));
    await f.store.writeRoutine(f.botId, routine.id);
    await expect(readFile(f.path(routine.slug), "utf8")).rejects.toThrow();
    await f.sync();
    expect((await f.read(routine.id)).deletedAt).not.toBeNull();
    expect((await f.read(routine.id)).enabled).toBe(false);
  } finally { await f.close(); }
});

integration("an explicit validated API definition save can replace an unfinished file edit", async () => {
  setSystemTime(at);
  const f = await fixture();
  try {
    const routine = await f.create();
    await writeFile(f.path(routine.slug), "{ unfinished");
    await f.service.mutate(f.botId, randomUUID(), null, { action: "update", id: routine.id, prompt: "Explicit API correction" });
    expect(JSON.parse(await readFile(f.path(routine.slug), "utf8")).prompt).toBe("Explicit API correction");
    expect((await f.sync()).warnings).toEqual([]);
    expect(await f.read(routine.id)).toMatchObject({ prompt: "Explicit API correction", enabled: true, validationError: null });
  } finally { await f.close(); }
});

integration("legacy metadata-free files retain a pending authored edit across a pause during upgrade", async () => {
  setSystemTime(at);
  const f = await fixture();
  try {
    const routine = await f.create();
    const legacy = JSON.parse(await readFile(f.path(routine.slug), "utf8"));
    delete legacy.projection;
    await writeFile(f.path(routine.slug), JSON.stringify(legacy));
    await f.sync();
    const pending = JSON.parse(await readFile(f.path(routine.slug), "utf8"));
    pending.prompt = "Pending pre-upgrade edit";
    await writeFile(f.path(routine.slug), JSON.stringify(pending));
    await f.service.mutate(f.botId, randomUUID(), null, { action: "pause", id: routine.id });
    await f.sync();
    expect(await f.read(routine.id)).toMatchObject({ prompt: "Pending pre-upgrade edit", enabled: false, nextRunAt: null });
    expect((await f.read(routine.id)).scheduleAnchorAt).not.toBeNull();
  } finally { await f.close(); }
});

integration("pausing before an invalid edit is imported preserves both the unfinished file and pause intent", async () => {
  setSystemTime(at);
  const f = await fixture();
  try {
    const routine = await f.create(), valid = await readFile(f.path(routine.slug), "utf8");
    await writeFile(f.path(routine.slug), "{ unfinished author edit");
    await f.service.mutate(f.botId, randomUUID(), null, { action: "pause", id: routine.id });
    expect(await readFile(f.path(routine.slug), "utf8")).toBe("{ unfinished author edit");
    await f.sync();
    expect(await f.read(routine.id)).toMatchObject({ enabled: false, nextRunAt: null });
    expect((await f.read(routine.id)).validationError).toBeString();
    await writeFile(f.path(routine.slug), valid);
    await f.sync();
    expect(await f.read(routine.id)).toMatchObject({ enabled: false, nextRunAt: null, validationError: null });
  } finally { await f.close(); }
});

integration("rollback after an update projection recovers intended instructions without rewinding runtime history", async () => {
  setSystemTime(at);
  const f = await fixture();
  try {
    const creationCall = randomUUID(), routine = await f.create("Rollback update", creationCall);
    const due = new Date(at.getTime() + 5 * 60_000);
    setSystemTime(due);
    expect(await f.service.dispatchDue(due)).toBe(1);
    await f.db.routineExecution.updateMany({ where: { routineId: routine.id }, data: { status: "completed", completedAt: due } });
    await f.db.run.updateMany({ where: { botId: f.botId }, data: { status: "completed", completedAt: due } });
    const committed = await f.read(routine.id);
    const project = f.store.writeRoutine.bind(f.store);
    let injectFailure = true;
    f.store.writeRoutine = async (...args) => { await project(...args); if (injectFailure) { injectFailure = false; throw new Error("post-update-projection rollback"); } };
    const updateCall = randomUUID();
    const input = { action: "update" as const, id: routine.id, prompt: "Recovered intended instructions" };
    await expect(f.service.mutate(f.botId, updateCall, null, input)).rejects.toThrow("post-update-projection rollback");
    expect((await f.read(routine.id)).prompt).toBe("Original instructions");
    await writeFile(join(f.path(routine.slug), "..", "runs.json"), "[]");
    await Promise.all([f.sync(), f.other.reconcileAutomationFilesBatch(null, 100)]);
    const recovered = await f.read(routine.id);
    expect(recovered.prompt).toBe("Recovered intended instructions");
    expect(recovered.revision).toBe(committed.revision + 1);
    expect(recovered.nextRunAt).toEqual(committed.nextRunAt);
    expect(recovered.lastRunAt).toEqual(committed.lastRunAt);
    expect(recovered.runLedger).toEqual(committed.runLedger);
    await f.service.mutate(f.botId, updateCall, null, input);
    expect((await f.read(routine.id)).nextRunAt).toEqual(recovered.nextRunAt);
    expect((await f.read(routine.id)).runLedger).toEqual(recovered.runLedger);
    expect((await f.service.mutate(f.botId, creationCall, null, { action: "create", name: "Retry", prompt: "Do not duplicate", schedule: "@every 5m" })).id).toBe(routine.id);
    expect(await f.db.routine.count({ where: { botId: f.botId } })).toBe(1);
  } finally { await f.close(); }
});

integration("an explicit enabled edit in a file remains effective after intervening lifecycle changes", async () => {
  setSystemTime(at);
  const f = await fixture();
  try {
    const routine = await f.create(), document = JSON.parse(await readFile(f.path(routine.slug), "utf8"));
    document.enabled = false;
    document.prompt = "File explicitly pauses this routine";
    await writeFile(f.path(routine.slug), JSON.stringify(document));
    await f.service.mutate(f.botId, randomUUID(), null, { action: "pause", id: routine.id });
    await f.service.mutate(f.botId, randomUUID(), null, { action: "resume", id: routine.id });
    await f.sync();
    expect(await f.read(routine.id)).toMatchObject({ prompt: "File explicitly pauses this routine", enabled: false, nextRunAt: null });
  } finally { await f.close(); }
});

integration("additive scheduling columns preserve legacy rows, paused intent and older SQL projections", async () => {
  setSystemTime(at);
  const f = await fixture();
  try {
    const enabled = await f.create("Legacy enabled"), paused = await f.create("Legacy paused");
    await f.service.mutate(f.botId, randomUUID(), null, { action: "pause", id: paused.id });
    const pausedBefore = await f.read(paused.id);
    await f.db.$transaction(async tx => {
      // This exclusive disposable database models the actual pre-upgrade shape.
      await tx.$executeRawUnsafe('ALTER TABLE "Routine" DROP COLUMN "scheduleAnchorAt", DROP COLUMN "validationError"');
      const before = await tx.$queryRaw<Array<{ id: string; prompt: string; enabled: boolean; revision: number }>>`SELECT id, prompt, enabled, revision FROM "Routine" WHERE "botId" = ${f.botId}::uuid ORDER BY id`;
      await tx.$executeRawUnsafe('ALTER TABLE "Routine" ADD COLUMN "scheduleAnchorAt" TIMESTAMP(3), ADD COLUMN "validationError" TEXT');
      // An old client's named-column query still sees precisely the same values.
      const after = await tx.$queryRaw<Array<{ id: string; prompt: string; enabled: boolean; revision: number }>>`SELECT id, prompt, enabled, revision FROM "Routine" WHERE "botId" = ${f.botId}::uuid ORDER BY id`;
      expect(after).toEqual(before);
    });
    expect((await f.read(enabled.id)).scheduleAnchorAt).toBeNull();
    expect((await f.read(enabled.id)).validationError).toBeNull();
    expect((await f.sync()).warnings).toEqual([]);
    expect((await f.read(enabled.id)).nextRunAt).toEqual(enabled.nextRunAt);
    expect((await f.read(enabled.id)).scheduleAnchorAt).not.toBeNull();
    expect(await f.read(paused.id)).toMatchObject({ enabled: false, nextRunAt: null, pausedAt: pausedBefore.pausedAt, revision: pausedBefore.revision });
  } finally { await f.close(); }
});

integration("acknowledging one import cannot overwrite a newer authored edit made during reconciliation", async () => {
  setSystemTime(at);
  const f = await fixture();
  try {
    const routine = await f.create(), document = JSON.parse(await readFile(f.path(routine.slug), "utf8"));
    const first = JSON.stringify({ ...document, prompt: "First pending edit" });
    const second = JSON.stringify({ ...document, prompt: "Second newer edit", "x-user-field": "newer value" });
    await writeFile(f.path(routine.slug), first);
    let inject = true;
    const proxy = new Proxy(f.db, { get(target, property, receiver) {
      if (property === "$transaction") return (action: (tx: any) => Promise<any>, options?: any) => target.$transaction(async tx => {
        const delegated = new Proxy(tx, { get(inner, key) {
          if (key === "routine") return { ...inner.routine, update: async (args: any) => {
            const updated = await inner.routine.update(args);
            if (inject && args.where.id === routine.id && args.data.prompt === "First pending edit") {
              inject = false;
              await writeFile(f.path(routine.slug), second);
            }
            return updated;
          } };
          const value = Reflect.get(inner, key, inner);
          return typeof value === "function" ? value.bind(inner) : value;
        } });
        return action(delegated);
      }, options);
      return Reflect.get(target, property, receiver);
    } });
    const interleaved = new AgentDataStore(proxy, { root: f.root, workspaceRoot: f.root });
    expect((await interleaved.reconcileAutomationFilesBatch(null, 100)).warnings).toEqual([]);
    expect(await readFile(f.path(routine.slug), "utf8")).toBe(second);
    expect((await f.read(routine.id)).prompt).toBe("First pending edit");
    expect((await f.sync()).warnings).toEqual([]);
    expect((await f.read(routine.id)).prompt).toBe("Second newer edit");
    expect(JSON.parse(await readFile(f.path(routine.slug), "utf8"))["x-user-field"]).toBe("newer value");
  } finally { await f.close(); }
});

for (const edit of ["valid", "invalid"] as const) {
  integration(`a toggle-only API update preserves a pending ${edit} file edit`, async () => {
    setSystemTime(at);
    const f = await fixture();
    try {
      const routine = await f.create(), original = await readFile(f.path(routine.slug), "utf8");
      const document = JSON.parse(original);
      const edited = edit === "invalid" ? "{ pending partial edit" : JSON.stringify({ ...document, prompt: "Pending file prompt" });
      await writeFile(f.path(routine.slug), edited);
      await f.service.mutate(f.botId, randomUUID(), null, { action: "update", id: routine.id, enabled: false });
      expect(await readFile(f.path(routine.slug), "utf8")).toBe(edited);
      await f.sync();
      expect(await f.read(routine.id)).toMatchObject({ enabled: false, nextRunAt: null });
      if (edit === "invalid") {
        expect((await f.read(routine.id)).validationError).toBeString();
        await writeFile(f.path(routine.slug), original);
        await f.sync();
        expect(await f.read(routine.id)).toMatchObject({ enabled: false, validationError: null });
      } else expect((await f.read(routine.id)).prompt).toBe("Pending file prompt");
    } finally { await f.close(); }
  });
}

integration("runtime projection preserves a copied managed definition awaiting import into an existing folder", async () => {
  setSystemTime(at);
  const f = await fixture();
  try {
    const source = await f.create("Source definition"), destination = await f.create("Destination definition");
    const copied = await readFile(f.path(source.slug), "utf8");
    await writeFile(f.path(destination.slug), copied);
    await f.store.writeRoutine(f.botId, destination.id);
    expect(await readFile(f.path(destination.slug), "utf8")).toBe(copied);
    expect((await f.sync()).warnings).toEqual([]);
    expect(await f.read(destination.id)).toMatchObject({ id: destination.id, name: "Source definition", enabled: true });
    expect(await f.read(source.id)).toMatchObject({ id: source.id, name: "Source definition", enabled: true });
  } finally { await f.close(); }
});

integration("repeated rollback during managed-file recovery preserves the original creation receipt", async () => {
  setSystemTime(at);
  const f = await fixture();
  try {
    const callId = randomUUID();
    const project = f.store.writeRoutine.bind(f.store);
    let failCreate = true;
    f.store.writeRoutine = async (...args) => {
      await project(...args);
      if (failCreate) { failCreate = false; throw new Error("rollback after initial projection"); }
    };
    await expect(f.create("Repeated rollback", callId)).rejects.toThrow("rollback after initial projection");
    const folder = (await f.store.listRoutineFolderIds(f.botId))[0]!;
    const original = JSON.parse(await readFile(f.path(folder), "utf8"));
    expect(original.projection.creationCallId).toBe(callId);
    expect(await f.db.routine.count({ where: { botId: f.botId } })).toBe(0);
    const crashDb = new Proxy(f.db, { get(target, property, receiver) {
      if (property === "$transaction") return (action: (tx: any) => Promise<any>, options?: any) => target.$transaction(async tx => {
        await action(tx);
        throw new Error("rollback after import acknowledgment");
      }, options);
      return Reflect.get(target, property, receiver);
    } });
    const crashStore = new AgentDataStore(crashDb, { root: f.root, workspaceRoot: f.root });
    await expect(crashStore.reconcileAutomationFilesBatch(null, 100)).rejects.toThrow("rollback after import acknowledgment");
    expect(await f.db.routine.count({ where: { botId: f.botId } })).toBe(0);
    expect(JSON.parse(await readFile(f.path(folder), "utf8")).projection.creationCallId).toBe(callId);
    expect((await f.sync()).warnings).toEqual([]);
    const recovered = await f.create("Retry changed inputs", callId);
    expect(recovered.id).toBe(original.projection.routineId);
    expect(recovered.name).toBe("Repeated rollback");
    expect(await f.db.routine.count({ where: { botId: f.botId } })).toBe(1);
  } finally { await f.close(); }
});
