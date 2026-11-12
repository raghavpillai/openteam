import { afterEach, expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "../src/agent-data";
import { parseAutomationFile } from "../src/automation-files";
import { RoutineService } from "../src/routines";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;
const at = new Date("2026-11-12T17:00:00Z");
afterEach(() => setSystemTime());

async function fixture(sharedRoot?: string) {
  const db = createPrismaClient(databaseUrl!);
  const root = sharedRoot ?? (await mkdtemp(join(tmpdir(), "openteam-routine-sync-fix-")));
  const botId = randomUUID(),
    channelId = randomUUID(),
    conversationId = randomUUID();
  const store = new AgentDataStore(db, { root, workspaceRoot: root });
  await db.userTimeZoneSettings.upsert({
    where: { id: "global" },
    create: { id: "global", detected: "UTC" },
    update: { detected: "UTC", override: null },
  });
  await db.bot.create({
    data: {
      id: botId,
      name: "Sync regression",
      status: "active",
      defaultDirectory: root,
      conversation: { create: { id: conversationId } },
    },
  });
  await db.channel.create({
    data: { id: channelId, kind: "bot_dm", name: "Sync regression", directKey: `bot:${botId}` },
  });
  const host = {
    isTimelineSessionActive: async () => false,
    enqueueWake: async (tx: any) => ({
      run: await tx.run.create({
        data: { botId, conversationId, channelId, userMessageId: randomUUID(), origin: "routine" },
      }),
    }),
  };
  const service = new RoutineService(db, host, store);
  const create = async (input: Record<string, unknown> = {}, callId = randomUUID()) =>
    service.mutate(botId, callId, null, {
      action: "create",
      name: "Schedule",
      prompt: "Saved instructions",
      schedule: "@every 5m",
      ...input,
    } as never);
  const read = (id: string) => db.routine.findUniqueOrThrow({ where: { id } });
  const path = (slug: string) =>
    join(store.botDirectory(botId), "automations", slug, "automation.json");
  const sync = () => store.reconcileAutomationFilesBatch(null, 100);
  const close = async () => {
    await store.stopWatching();
    const ids = (await db.routine.findMany({ where: { botId }, select: { id: true } })).map(
      (r) => r.id
    );
    const executionIds = (
      await db.routineExecution.findMany({
        where: { routineId: { in: ids } },
        select: { id: true },
      })
    ).map((r) => r.id);
    await db.routineExecution.deleteMany({ where: { routineId: { in: ids } } });
    await db.routineRevision.deleteMany({ where: { routineId: { in: ids } } });
    await db.routine.deleteMany({ where: { id: { in: ids } } });
    await db.event.deleteMany({ where: { entityId: { in: [...ids, ...executionIds] } } });
    await db.bot.delete({ where: { id: botId } });
    await db.channel.delete({ where: { id: channelId } });
    await db.$disconnect();
    if (!sharedRoot) await rm(root, { recursive: true, force: true });
  };
  return { db, root, botId, store, service, create, read, path, sync, close };
}

test("file parser schedules every listener, validates later listeners and keeps long accepted cron text", async () => {
  setSystemTime(at);
  const root = await mkdtemp(join(tmpdir(), "openteam-routine-parser-fix-"));
  const path = join(root, "automation.json");
  const parse = async (fields: Record<string, unknown>) => {
    const text = JSON.stringify({
      name: "Parser",
      prompt: "Instructions",
      createdAt: at.getTime(),
      ...fields,
    });
    await writeFile(path, text);
    return parseAutomationFile(path, text, "America/New_York");
  };
  try {
    const parsed = await parse({
      trigger: {
        type: "group",
        listeners: [
          { type: "cron", schedule: "CRON_TZ=America/New_York 0 3 * * *" },
          { type: "cron", schedule: "CRON_TZ=America/New_York 9 18 * * *" },
        ],
      },
    });
    expect(parsed.nextRunAt?.toISOString()).toBe("2026-11-12T23:09:00.000Z");
    await expect(
      parse({
        trigger: {
          type: "group",
          listeners: [
            { type: "cron", schedule: "0 3 * * *" },
            { type: "cron", schedule: "* * * * *" },
          ],
        },
      })
    ).rejects.toThrow();
    await expect(
      parse({
        schedule: "0 3 * * *",
        trigger: {
          type: "group",
          listeners: [{ type: "cron", schedule: "0 3 * * *" }, { type: "invalid" }],
        },
      })
    ).rejects.toThrow();
    const longCron = [
      Array.from({ length: 12 }, (_, i) => i * 5).join(","),
      Array.from({ length: 24 }, (_, i) => i).join(","),
      Array.from({ length: 31 }, (_, i) => i + 1).join(","),
      "*",
      "*",
    ].join(" ");
    expect((await parse({ trigger: { type: "cron", schedule: longCron } })).trigger.schedule).toBe(
      longCron
    );
    await mkdir(join(root, "runs.json"));
    const brokenHistory = await parse({ schedule: "0 8 * * *" });
    expect(brokenHistory.historyError).toBeString();
    expect(brokenHistory.enabled).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

integration(
  "unchanged file sync preserves a second-listener dispatch and committed run history",
  async () => {
    setSystemTime(at);
    const f = await fixture();
    try {
      const created = await f.create({
        schedule: undefined,
        trigger: {
          type: "group",
          listeners: [
            { type: "cron", schedule: "CRON_TZ=America/New_York 0 3 * * *" },
            { type: "cron", schedule: "CRON_TZ=America/New_York 9 18 * * *" },
          ],
        },
      });
      const id = String(created.id),
        before = await f.read(id);
      const staleDefinition = await readFile(f.path(before.slug), "utf8");
      await f.sync();
      expect((await f.read(id)).nextRunAt?.toISOString()).toBe("2026-11-12T23:09:00.000Z");
      setSystemTime(new Date("2026-11-12T23:09:00Z"));
      expect(await f.service.dispatchDue(new Date())).toBe(1);
      const dispatched = await f.read(id);
      await writeFile(f.path(before.slug), staleDefinition);
      await writeFile(join(f.path(before.slug), "..", "runs.json"), "[]");
      await f.sync();
      const synced = await f.read(id);
      expect(synced.nextRunAt).toEqual(dispatched.nextRunAt);
      expect(synced.lastRunAt).toEqual(dispatched.lastRunAt);
      expect(synced.runLedger).toEqual(dispatched.runLedger);
      expect(await f.service.dispatchDue(new Date())).toBe(0);
      expect(await f.db.routineExecution.count({ where: { routineId: id } })).toBe(1);
    } finally {
      await f.close();
    }
  }
);

integration(
  "stale projections cannot undo edits or pauses and authored prompt edits retain interval cadence",
  async () => {
    setSystemTime(at);
    const f = await fixture();
    try {
      const created = await f.create(),
        id = String(created.id),
        before = await f.read(id);
      const stale = await readFile(f.path(before.slug), "utf8");
      setSystemTime(new Date(at.getTime() + 60_000));
      await f.service.mutate(f.botId, randomUUID(), null, {
        action: "update",
        id,
        prompt: "Updated instructions",
      });
      await writeFile(f.path(before.slug), stale);
      await f.sync();
      expect((await f.read(id)).prompt).toBe("Updated instructions");
      expect((await f.read(id)).nextRunAt).toEqual(before.nextRunAt);
      await f.service.mutate(f.botId, randomUUID(), null, { action: "pause", id });
      await writeFile(f.path(before.slug), stale);
      await f.sync();
      expect((await f.read(id)).enabled).toBe(false);
      expect((await f.read(id)).nextRunAt).toBeNull();
      // Editing the authored instructions remains supported even with a stale marker.
      const edited = JSON.parse(stale);
      edited.prompt = "Deliberate file edit";
      edited.enabled = false;
      await writeFile(f.path(before.slug), JSON.stringify(edited));
      await f.sync();
      expect((await f.read(id)).prompt).toBe("Deliberate file edit");
    } finally {
      await f.close();
    }
  }
);

integration(
  "invalid definitions stay visible and disabled, while broken history leaves valid routines enabled",
  async () => {
    setSystemTime(at);
    const f = await fixture();
    try {
      const first = await f.create(),
        second = await f.create({ name: "Healthy" });
      const invalid = await f.read(String(first.id)),
        healthy = await f.read(String(second.id));
      const definition = await readFile(f.path(invalid.slug), "utf8");
      await writeFile(f.path(invalid.slug), "{ invalid");
      const historyPath = join(f.path(healthy.slug), "..", "runs.json");
      await rm(historyPath);
      await mkdir(historyPath);
      const result = await f.sync();
      expect(result.warnings).toHaveLength(2);
      expect(await f.read(invalid.id)).toMatchObject({
        enabled: false,
        deletedAt: null,
        nextRunAt: null,
      });
      expect((await f.read(healthy.id)).enabled).toBe(true);
      setSystemTime(new Date(at.getTime() + 5 * 60_000));
      expect(await f.service.dispatchDue(new Date())).toBe(1);
      await writeFile(f.path(invalid.slug), definition);
      await f.sync();
      expect((await f.read(invalid.id)).enabled).toBe(true);
    } finally {
      await f.close();
    }
  }
);

integration(
  "rollback projection recovers the same creation identity and retries cannot create a second routine",
  async () => {
    setSystemTime(at);
    const f = await fixture();
    const write = f.store.writeRoutine.bind(f.store);
    let fail = true;
    f.store.writeRoutine = async (...args) => {
      await write(...args);
      if (fail) {
        fail = false;
        throw new Error("post-projection failure");
      }
    };
    try {
      const callId = randomUUID();
      await expect(f.create({}, callId)).rejects.toThrow("post-projection failure");
      expect(await f.db.routine.count({ where: { botId: f.botId } })).toBe(0);
      const folders = await f.store.listRoutineFolderIds(f.botId);
      const projected = JSON.parse(await readFile(f.path(folders[0]!), "utf8"));
      expect(projected.projection.creationCallId).toBe(callId);
      expect((await f.sync()).warnings).toEqual([]);
      const recovered = await f.create({ name: "Changed retry inputs" }, callId);
      expect(recovered.id).toBe(projected.projection.routineId);
      expect(recovered.name).toBe("Schedule");
      expect(await f.db.routine.count({ where: { botId: f.botId } })).toBe(1);
      expect(
        (await f.db.routineRevision.findMany({ where: { routineId: String(recovered.id) } }))[0]
          ?.callId
      ).toBe(callId);
    } finally {
      await f.close();
    }
  }
);

integration(
  "copying over an existing folder replaces only its definition and preserves both creation identities",
  async () => {
    setSystemTime(at);
    const f = await fixture();
    try {
      const sourceCall = randomUUID(),
        destinationCall = randomUUID();
      const first = await f.create({}, sourceCall),
        second = await f.create({ name: "Other" }, destinationCall);
      const a = await f.read(String(first.id)),
        b = await f.read(String(second.id));
      const copied = JSON.parse(await readFile(f.path(a.slug), "utf8"));
      copied.name = "Replacement definition";
      await writeFile(f.path(b.slug), JSON.stringify(copied));
      expect((await f.sync()).warnings).toEqual([]);
      expect(await f.read(a.id)).toMatchObject({ name: "Schedule", enabled: true });
      expect(await f.read(b.id)).toMatchObject({
        name: "Replacement definition",
        enabled: true,
        deletedAt: null,
      });
      expect(await f.db.routine.count({ where: { botId: f.botId } })).toBe(2);
      expect((await f.create({}, sourceCall)).id).toBe(a.id);
      expect((await f.create({}, destinationCall)).id).toBe(b.id);
      expect((await f.sync()).warnings).toEqual([]);
      expect(JSON.parse(await readFile(f.path(b.slug), "utf8")).projection).toMatchObject({
        routineId: b.id,
        creationCallId: destinationCall,
      });
    } finally {
      await f.close();
    }
  }
);

integration(
  "legacy first-listener state is repaired across calendar and interval mixtures without replaying due work",
  async () => {
    setSystemTime(at);
    const f = await fixture();
    try {
      for (const listeners of [
        [
          { type: "cron", schedule: "0 3 * * *" },
          { type: "cron", schedule: "0 18 * * *" },
        ],
        [
          { type: "cron", schedule: "@every 1d" },
          { type: "cron", schedule: "0 18 * * *" },
        ],
        [
          { type: "cron", schedule: "@every 1d" },
          { type: "cron", schedule: "@every 5m" },
        ],
      ]) {
        const created = await f.create({
          schedule: undefined,
          trigger: { type: "group", listeners },
        });
        const id = String(created.id),
          expected = (await f.read(id)).nextRunAt;
        await f.db.routine.update({
          where: { id },
          data: {
            nextRunAt: new Date("2026-11-13T03:00:00Z"),
            scheduleAnchorAt: null,
            createdAt: at,
          },
        });
        await f.sync();
        expect((await f.read(id)).nextRunAt).toEqual(expected);
        expect((await f.read(id)).scheduleAnchorAt).toEqual(at);
        const overdue = new Date(at.getTime() - 60_000);
        await f.db.routine.update({
          where: { id },
          data: { nextRunAt: overdue, scheduleAnchorAt: null },
        });
        await f.sync();
        expect((await f.read(id)).nextRunAt).toEqual(overdue);
      }
    } finally {
      await f.close();
    }
  }
);

integration(
  "unreadable automation files quarantine only their own routine and do not block healthy dispatch",
  async () => {
    setSystemTime(at);
    const f = await fixture();
    try {
      const first = await f.create(),
        second = await f.create({ name: "Healthy neighbor" });
      const broken = await f.read(String(first.id));
      await rm(f.path(broken.slug));
      await mkdir(f.path(broken.slug));
      const result = await f.sync();
      expect(result.warnings).toHaveLength(1);
      expect(await f.read(broken.id)).toMatchObject({ enabled: false, deletedAt: null });
      expect((await f.read(broken.id)).validationError).toContain("regular file");
      setSystemTime(new Date(at.getTime() + 5 * 60_000));
      expect(await f.service.dispatchDue(new Date())).toBe(1);
      expect(await f.db.routineExecution.count({ where: { routineId: String(second.id) } })).toBe(
        1
      );
    } finally {
      await f.close();
    }
  }
);

integration(
  "copying a managed definition into a new folder creates a fresh routine without copying its receipt",
  async () => {
    setSystemTime(at);
    const f = await fixture();
    try {
      const callId = randomUUID(),
        created = await f.create({}, callId),
        source = await f.read(String(created.id));
      const document = await readFile(f.path(source.slug), "utf8");
      await mkdir(join(f.path("copied-definition"), ".."));
      await writeFile(f.path("copied-definition"), document);
      expect((await f.sync()).warnings).toEqual([]);
      const copied = await f.db.routine.findUniqueOrThrow({
        where: { botId_slug: { botId: f.botId, slug: "copied-definition" } },
      });
      expect(copied.id).not.toBe(source.id);
      expect(copied.enabled).toBe(true);
      expect((await f.sync()).warnings).toEqual([]);
      expect((await f.read(copied.id)).enabled).toBe(true);
      expect(
        (
          await f.db.routineRevision.findUniqueOrThrow({
            where: { routineId_revision: { routineId: copied.id, revision: 1 } },
          })
        ).callId
      ).toBeNull();
      expect((await f.create({}, callId)).id).toBe(source.id);
      expect(await f.db.routine.count({ where: { botId: f.botId } })).toBe(2);
    } finally {
      await f.close();
    }
  }
);

integration(
  "legacy replay recovery recognizes committed scheduled occurrences across definition revisions",
  async () => {
    setSystemTime(at);
    const f = await fixture();
    try {
      const created = await f.create(),
        id = String(created.id);
      const due = new Date(at.getTime() + 5 * 60_000);
      setSystemTime(due);
      expect(await f.service.dispatchDue(due)).toBe(1);
      await f.db.routineExecution.updateMany({
        where: { routineId: id },
        data: { status: "completed", completedAt: due },
      });
      await f.db.run.updateMany({
        where: { botId: f.botId },
        data: { status: "completed", completedAt: due },
      });
      await f.service.mutate(f.botId, randomUUID(), null, {
        action: "update",
        id,
        prompt: "New prompt after first occurrence",
      });
      // A pre-upgrade stale projection persisted the old due time after the edit.
      await f.db.routine.update({ where: { id }, data: { nextRunAt: due } });
      expect(await f.service.dispatchDue(due)).toBe(0);
      expect(await f.db.routineExecution.count({ where: { routineId: id } })).toBe(1);
      expect((await f.read(id)).nextRunAt?.getTime()).toBeGreaterThan(due.getTime());
    } finally {
      await f.close();
    }
  }
);

integration(
  "settling an existing run cannot erase an invalid authored edit or clear its quarantine",
  async () => {
    setSystemTime(at);
    const f = await fixture();
    try {
      const created = await f.create(),
        id = String(created.id),
        original = await f.read(id);
      setSystemTime(new Date(at.getTime() + 5 * 60_000));
      expect(await f.service.dispatchDue(new Date())).toBe(1);
      const valid = await readFile(f.path(original.slug), "utf8");
      await writeFile(f.path(original.slug), "{ unfinished user edit");
      await f.sync();
      expect((await f.read(id)).validationError).toBeString();
      // This is the same projection entrypoint used when the ongoing run settles.
      await f.store.writeRoutine(f.botId, id);
      expect(await readFile(f.path(original.slug), "utf8")).toBe("{ unfinished user edit");
      await f.sync();
      expect((await f.read(id)).enabled).toBe(false);
      expect((await f.read(id)).validationError).toBeString();
      await writeFile(f.path(original.slug), valid);
      await f.sync();
      expect((await f.read(id)).enabled).toBe(true);
      expect((await f.read(id)).validationError).toBeNull();
    } finally {
      await f.close();
    }
  }
);

integration(
  "file imports preserve a legacy single interval phase and grouped intervals do not reset from event history",
  async () => {
    setSystemTime(at);
    const f = await fixture();
    try {
      const createdAt = new Date(at.getTime() - 7 * 60_000),
        lastRunAt = new Date(at.getTime() - 60_000);
      for (const [slug, trigger] of [
        ["legacy-phase", { type: "cron", schedule: "@every 5m" }],
        [
          "group-phase",
          {
            type: "group",
            listeners: [
              { type: "cron", schedule: "@every 5m" },
              { type: "cron", schedule: "@every 10m" },
            ],
          },
        ],
      ] as const) {
        await mkdir(join(f.path(slug), ".."), { recursive: true });
        await writeFile(
          f.path(slug),
          JSON.stringify({
            name: slug,
            prompt: "Instructions",
            trigger,
            createdAt: createdAt.getTime(),
            lastRunAt: lastRunAt.getTime(),
          })
        );
      }
      expect((await f.sync()).warnings).toEqual([]);
      const legacy = await f.db.routine.findUniqueOrThrow({
        where: { botId_slug: { botId: f.botId, slug: "legacy-phase" } },
      });
      expect(legacy.scheduleAnchorAt).toEqual(lastRunAt);
      expect(legacy.nextRunAt).toEqual(new Date(at.getTime() + 4 * 60_000));
      const grouped = await f.db.routine.findUniqueOrThrow({
        where: { botId_slug: { botId: f.botId, slug: "group-phase" } },
      });
      expect(grouped.scheduleAnchorAt).toEqual(createdAt);
      expect(grouped.nextRunAt).toEqual(new Date(at.getTime() + 3 * 60_000));
      setSystemTime(legacy.nextRunAt!);
      await f.service.dispatchDue(new Date());
      expect((await f.read(legacy.id)).nextRunAt).toEqual(new Date(at.getTime() + 9 * 60_000));
    } finally {
      await f.close();
    }
  }
);

integration(
  "restoring a valid definition after an explicit quarantine pause clears its error without resuming",
  async () => {
    setSystemTime(at);
    const f = await fixture();
    try {
      const created = await f.create(),
        id = String(created.id),
        original = await f.read(id);
      const valid = await readFile(f.path(original.slug), "utf8");
      await writeFile(f.path(original.slug), "{ invalid edit");
      await f.sync();
      await f.service.mutate(f.botId, randomUUID(), null, { action: "pause", id });
      const paused = await f.read(id);
      expect(paused.revision).toBeGreaterThan(original.revision);
      expect(paused.validationError).toBeString();
      await writeFile(f.path(original.slug), valid);
      await f.sync();
      expect(await f.read(id)).toMatchObject({
        enabled: false,
        nextRunAt: null,
        validationError: null,
      });
      expect((await f.read(id)).revision).toBe(paused.revision);
    } finally {
      await f.close();
    }
  }
);

test("all original first-listener variants and unaffected controls retain their expected next occurrence", async () => {
  const base = new Date("2026-11-10T00:00:00Z");
  setSystemTime(base);
  const root = await mkdtemp(join(tmpdir(), "routine-listener-matrix-"));
  const path = join(root, "automation.json");
  const group = (...listeners: unknown[]) => ({ type: "group", listeners });
  const cron = (schedule: string) => ({ type: "cron", schedule });
  const cases: Array<[unknown, string | null, boolean?]> = [
    [group(cron("0 18 * * *"), cron("0 3 * * *")), "2026-11-10T03:00:00.000Z"],
    [group(cron("0 9 * * 1"), cron("0 9 * * *")), "2026-11-10T09:00:00.000Z"],
    [
      group(cron("CRON_TZ=America/New_York 0 18 * * *"), cron("CRON_TZ=Asia/Tokyo 0 18 * * *")),
      "2026-11-10T09:00:00.000Z",
    ],
    [group(cron("@every 1h"), cron("@every 5m")), "2026-11-10T00:05:00.000Z"],
    [group(cron("0 18 * * *"), cron("@every 5m")), "2026-11-10T00:05:00.000Z"],
    [group(cron("@every 1h/30m"), cron("@every 1h/5m")), "2026-11-10T00:05:00.000Z"],
    [
      group(...[18, 17, 16, 15, 14, 13, 12, 3].map((hour) => cron(`0 ${hour} * * *`))),
      "2026-11-10T03:00:00.000Z",
    ],
    [group({ type: "webhook" }, cron("0 3 * * *")), "2026-11-10T03:00:00.000Z"],
    [group({ type: "webhook" }, { type: "email", inbox: "a@example.com" }), null],
    [cron("0 3,18 * * *"), "2026-11-10T03:00:00.000Z"],
    [group(cron("0 3 * * *"), cron("0 18 * * *")), null, false],
  ];
  try {
    for (const [trigger, expected, enabled = true] of cases) {
      const text = JSON.stringify({
        name: "Matrix",
        prompt: "Instructions",
        trigger,
        enabled,
        createdAt: base.getTime(),
      });
      await writeFile(path, text);
      expect((await parseAutomationFile(path, text, "UTC")).nextRunAt?.toISOString() ?? null).toBe(
        expected
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

integration(
  "concurrent sync cannot erase a dispatch committed after its initial read",
  async () => {
    setSystemTime(at);
    const f = await fixture();
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const read = deferred(),
      release = deferred(),
      projected = deferred();
    const bounded = <T>(promise: Promise<T>) =>
      Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Concurrent routine sync timed out")),
            2000
          );
          timer.unref();
        }),
      ]);
    let syncing: Promise<unknown> | undefined, dispatching: Promise<unknown> | undefined;
    try {
      const id = String((await f.create()).id),
        original = await f.read(id),
        due = original.nextRunAt!;
      setSystemTime(due);
      const extended = f.db.$extends({
        query: {
          routine: {
            async findUnique({ args, query }) {
              const result = await query(args);
              if (args.where.botId_slug?.botId === f.botId) {
                read.resolve();
                await release.promise;
              }
              return result;
            },
          },
        },
      });
      const store = new AgentDataStore(extended as never, { root: f.root, workspaceRoot: f.root });
      const service = new RoutineService(
        f.db,
        {
          enqueueWake: async (tx) => ({
            run: await tx.run.create({
              data: {
                botId: f.botId,
                conversationId: (
                  await f.db.bot.findUniqueOrThrow({
                    where: { id: f.botId },
                    include: { conversation: true },
                  })
                ).conversation!.id,
                channelId: (
                  await f.db.channel.findUniqueOrThrow({ where: { directKey: `bot:${f.botId}` } })
                ).id,
                userMessageId: randomUUID(),
                origin: "routine",
              },
            }),
          }),
        },
        {
          writeRoutine: async (botId, routineId, tx) => {
            projected.resolve();
            await f.store.writeRoutine(botId, routineId, tx);
          },
          deleteRoutine: async () => {},
        }
      );
      syncing = store.reconcileAutomationFilesBatch(null, 100);
      await bounded(read.promise);
      dispatching = service.dispatchDue(due);
      await bounded(projected.promise);
      expect((await f.read(id)).lastRunAt).toEqual(due);
      release.resolve();
      await bounded(Promise.all([syncing, dispatching]));
      expect((await f.read(id)).lastRunAt).toEqual(due);
      expect((await f.read(id)).nextRunAt).toEqual(new Date(due.getTime() + 300_000));
      expect(await service.dispatchDue(due)).toBe(0);
      expect(await f.db.routineExecution.count({ where: { routineId: id } })).toBe(1);
    } finally {
      release.resolve();
      await Promise.allSettled([syncing, dispatching]);
      await f.close();
    }
  }
);

// Includes 51 API creations and their indexed file projections before dispatch is checked.
integration(
  "a backlog cannot rewind through sync and monopolize the next dispatch page",
  async () => {
    setSystemTime(at);
    const f = await fixture();
    const healthy = await fixture(f.root);
    try {
      const ids: string[] = [];
      for (let n = 0; n < 50; n++) ids.push(String((await f.create({ name: `Backlog ${n}` })).id));
      const healthyId = String((await healthy.create({ name: "Healthy after backlog" })).id);
      const overdue = new Date(at.getTime() - 86_400_000);
      await f.db.routine.updateMany({ where: { id: { in: ids } }, data: { nextRunAt: overdue } });
      await f.db.routine.update({
        where: { id: healthyId },
        data: { enabled: true, nextRunAt: at },
      });
      expect(await f.service.dispatchDue(at)).toBe(50);
      await f.sync();
      expect(await f.service.dispatchDue(at)).toBe(1);
      await f.sync();
      expect(await f.service.dispatchDue(at)).toBe(0);
      expect(await f.db.routineExecution.count({ where: { routineId: healthyId } })).toBe(1);
      expect(
        await f.db.routineExecution.count({ where: { routineId: { in: ids }, status: "skipped" } })
      ).toBe(0);
    } finally {
      await healthy.close();
      await f.close();
    }
  },
  30_000
);
