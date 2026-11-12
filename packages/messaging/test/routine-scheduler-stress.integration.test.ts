import { afterEach, expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "../src/agent-data";
import {
  RoutineService,
  nextRoutineRun,
  normalizeRoutineSchedule,
  followUserTimeZone,
} from "../src/routines";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;
const integration = url ? test : test.skip;
afterEach(() => setSystemTime());

async function fixture() {
  const db = createPrismaClient(url!);
  const root = await mkdtemp(join(tmpdir(), "routine-stress-"));
  const botId = randomUUID(),
    roomId = randomUUID(),
    dmId = randomUUID();
  const previousZone = await db.userTimeZoneSettings.findUnique({ where: { id: "global" } });
  await db.userTimeZoneSettings.upsert({
    where: { id: "global" },
    create: { id: "global", detected: "UTC" },
    update: { detected: "UTC", override: null },
  });
  await db.bot.create({
    data: {
      id: botId,
      name: "Scheduler stress",
      defaultDirectory: root,
      status: "active",
      conversation: { create: {} },
    },
  });
  await db.channel.create({
    data: {
      id: roomId,
      kind: "group",
      name: "Scheduler stress",
      members: { create: { botId, ordinal: 0 } },
    },
  });
  await db.channel.create({
    data: { id: dmId, kind: "bot_dm", name: "Scheduler stress DM", directKey: `bot:${botId}` },
  });
  const store = new AgentDataStore(db, { root, workspaceRoot: root });
  const host = {
    isTimelineSessionActive: async () => false,
    enqueueWake: async () => {
      throw new Error("Stress harness does not start a model");
    },
    createGroupRound: async (tx: any, input: any) =>
      tx.channelRound.create({
        data: {
          channelId: input.channelId,
          triggerMessageId: input.triggerMessageId,
          rootMessageId: input.triggerMessageId,
        },
      }),
    advanceRound: async () => {},
  };
  const service = new RoutineService(db, host, store);
  const owner = { kind: "group" as const, id: roomId };
  const create = async (trigger: unknown, bot = false) =>
    String(
      (
        await service.mutateOwner(bot ? { kind: "bot", id: botId } : owner, randomUUID(), null, {
          action: "create",
          name: "Stress cadence",
          prompt: "Original prompt",
          trigger,
        })
      ).id
    );
  const read = (id: string) => db.routine.findUniqueOrThrow({ where: { id } });
  const settle = (id: string) =>
    db.routineExecution.updateMany({
      where: { routineId: id, status: { in: ["queued", "running"] } },
      data: { status: "completed", completedAt: new Date() },
    });
  return {
    db,
    root,
    botId,
    store,
    service,
    owner,
    create,
    read,
    settle,
    close: async () => {
      await store.stopWatching();
      await db.channel.deleteMany({ where: { id: { in: [roomId, dmId] } } });
      await db.bot.delete({ where: { id: botId } });
      if (previousZone)
        await db.userTimeZoneSettings.update({ where: { id: "global" }, data: previousZone });
      else await db.userTimeZoneSettings.deleteMany({ where: { id: "global" } });
      await db.$disconnect();
      await rm(root, { recursive: true, force: true });
    },
  };
}

type Interval = { minutes: number; phase?: number };
const ms = 60_000;
const arithmeticNext = (specs: Interval[], anchor: Date, after: Date) =>
  new Date(
    Math.min(
      ...specs.map((spec) => {
        const period = spec.minutes * ms;
        const origin = spec.phase === undefined ? anchor.getTime() : spec.phase * ms;
        return origin + (Math.floor((after.getTime() - origin) / period) + 1) * period;
      })
    )
  );
const triggerFor = (specs: Interval[]) => ({
  type: "group",
  listeners: specs.map((spec) => ({
    type: "cron",
    schedule: `@every ${spec.minutes}m${spec.phase === undefined ? "" : `/${spec.phase}m`}`,
  })),
});

// Give each seeded schedule its own clock and database fixture. A corpus-wide
// deadline can leave an unfinished promise changing the clock in later tests.
const intervalPlans = (() => {
  let random = 275;
  const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
  return Array.from({ length: 24 }, (_, scenario) => {
    const periods = new Set<number>();
    while (periods.size < 2 + (scenario % 3)) periods.add(5 + (next() % 56));
    const specs = [...periods].map((minutes, index) => ({
      minutes,
      ...(scenario % 3 === 0 && index === 0 ? { phase: next() % minutes } : {}),
    }));
    const jumps = Array.from({ length: 4 }, () => 70 + (next() % 500_000));
    return {
      scenario,
      specs,
      jumps,
      resumeMinutes: (next() % 10_000) + 1,
      anchor: new Date(Date.UTC(2026, 0, 1 + scenario, 0, 0, 0, 123)),
    };
  });
})();

for (const { scenario, specs, jumps, resumeMinutes, anchor } of intervalPlans) {
  integration(
    `independent arithmetic oracle: interval group ${scenario + 1}/24 through downtime, metadata, manual runs, replay and pause/resume`,
    async () => {
      setSystemTime(anchor);
      const f = await fixture();
      try {
        const id = await f.create(triggerFor(specs));
        expect((await f.read(id)).nextRunAt).toEqual(arithmeticNext(specs, anchor, anchor));
        await f.service.runNowOwner(f.owner, id, randomUUID(), anchor);
        await f.settle(id);
        expect((await f.read(id)).nextRunAt).toEqual(arithmeticNext(specs, anchor, anchor));
        let now = anchor;
        for (const [turn, minutes] of jumps.entries()) {
          now = new Date(now.getTime() + minutes * ms);
          setSystemTime(now);
          const scheduledFor = (await f.read(id)).nextRunAt!;
          expect(await f.service.dispatchDue(now)).toBe(1);
          expect((await f.read(id)).nextRunAt).toEqual(arithmeticNext(specs, anchor, now));
          await f.settle(id);
          await f.service.mutateOwner(f.owner, randomUUID(), null, {
            action: "update",
            id,
            prompt: `Metadata ${scenario}/${turn}`,
          });
          expect((await f.read(id)).nextRunAt).toEqual(arithmeticNext(specs, anchor, now));
          await f.db.routine.update({ where: { id }, data: { nextRunAt: scheduledFor } });
          expect(await f.service.dispatchDue(now)).toBe(0);
          expect((await f.read(id)).nextRunAt).toEqual(arithmeticNext(specs, anchor, now));
        }
        await f.service.mutateOwner(f.owner, randomUUID(), null, { action: "pause", id });
        expect((await f.read(id)).nextRunAt).toBeNull();
        now = new Date(now.getTime() + resumeMinutes * ms);
        setSystemTime(now);
        await f.service.mutateOwner(f.owner, randomUUID(), null, { action: "resume", id });
        expect((await f.read(id)).nextRunAt).toEqual(arithmeticNext(specs, now, now));
        await f.service.mutateOwner(f.owner, randomUUID(), null, { action: "delete", id });
      } finally {
        await f.close();
      }
    },
    20_000
  );
}

// Independent oracle: inspect actual local clock minutes, without cron-parser or
// the production trigger helper. These cases deliberately use daily HH:MM rules.
function clockNext(zone: string, after: Date, hour: number, minute: number): Date {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  for (
    let t = Math.floor(after.getTime() / ms) * ms + ms, end = t + 4 * 24 * 60 * ms;
    t < end;
    t += ms
  ) {
    const parts = formatter.formatToParts(new Date(t));
    if (
      Number(parts.find((part) => part.type === "hour")!.value) % 24 === hour &&
      Number(parts.find((part) => part.type === "minute")!.value) === minute
    )
      return new Date(t);
  }
  throw new Error("Independent local-clock oracle exceeded four-day bound");
}

test("independent local-clock oracle: DST gaps, both fold sides and fractional-offset zones", () => {
  const scenarios = [
    { zone: "America/New_York", after: "2026-03-08T06:55:00Z", hour: 2, minute: 30 },
    { zone: "America/New_York", after: "2026-11-01T04:55:00Z", hour: 1, minute: 30 },
    { zone: "America/New_York", after: "2026-11-01T05:30:00Z", hour: 1, minute: 30 },
    { zone: "Australia/Lord_Howe", after: "2026-04-04T14:45:00Z", hour: 1, minute: 45 },
    { zone: "Australia/Lord_Howe", after: "2026-10-03T15:15:00Z", hour: 2, minute: 15 },
    { zone: "Asia/Kathmandu", after: "2026-01-01T01:00:00Z", hour: 9, minute: 0 },
    { zone: "Pacific/Chatham", after: "2026-04-04T13:00:00Z", hour: 3, minute: 0 },
    { zone: "Europe/Berlin", after: "2026-10-25T00:30:00Z", hour: 2, minute: 30 },
  ];
  for (const scenario of scenarios) {
    const schedule = normalizeRoutineSchedule(
      `${scenario.minute} ${scenario.hour} * * *`,
      scenario.zone
    );
    let after = new Date(scenario.after);
    for (let occurrence = 0; occurrence < 3; occurrence++) {
      const expected = clockNext(scenario.zone, after, scenario.hour, scenario.minute);
      expect(nextRoutineRun(schedule, after)).toEqual(expected);
      after = expected;
    }
  }
});

integration(
  "API toggle-only quarantine pause retains the authored invalid file and resume remains blocked until repair",
  async () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const f = await fixture();
    try {
      const id = await f.create({ type: "cron", schedule: "@every 5m" }, true);
      const before = await f.read(id);
      const path = join(
        f.store.botDirectory(f.botId),
        "automations",
        before.slug,
        "automation.json"
      );
      const valid = await readFile(path, "utf8");
      await writeFile(path, "{ deliberately invalid");
      await f.store.reconcileAutomationFilesBatch(null, 100);
      const invalid = await f.read(id);
      await f.service.mutate(f.botId, randomUUID(), null, {
        action: "update",
        id,
        enabled: false,
        expectedRevision: invalid.revision,
      });
      expect(await readFile(path, "utf8")).toBe("{ deliberately invalid");
      expect((await f.read(id)).validationError).toBeString();
      await expect(
        f.service.mutate(f.botId, randomUUID(), null, { action: "update", id, enabled: true })
      ).rejects.toMatchObject({ code: "invalid_routine_definition" });
      await writeFile(path, valid);
      await f.store.reconcileAutomationFilesBatch(null, 100);
      expect(await f.read(id)).toMatchObject({
        enabled: false,
        validationError: null,
        nextRunAt: null,
      });
    } finally {
      await f.close();
    }
  }
);

integration(
  "legacy timezone changes preserve an upcoming relative interval behind a floating calendar listener",
  async () => {
    setSystemTime(new Date("2026-01-01T17:00:00Z"));
    const f = await fixture();
    try {
      const id = await f.create({
        type: "group",
        listeners: [
          { type: "cron", schedule: "@every 30m" },
          { type: "cron", schedule: "0 3 * * *" },
        ],
      });
      await f.db.routine.update({
        where: { id },
        data: { scheduleAnchorAt: null, nextRunAt: new Date("2026-01-01T17:30:00Z") },
      });
      await f.db.$transaction((tx) =>
        followUserTimeZone(tx, "Asia/Tokyo", new Date("2026-01-01T17:05:00Z"))
      );
      expect((await f.read(id)).nextRunAt).toEqual(new Date("2026-01-01T17:30:00Z"));
    } finally {
      await f.close();
    }
  }
);

integration(
  "legacy enabled routines with a null due time are repaired while intentional pauses stay paused",
  async () => {
    setSystemTime(new Date("2026-01-01T17:00:00Z"));
    const f = await fixture();
    try {
      const trigger = {
        type: "group",
        listeners: [
          { type: "cron", schedule: "0 3 * * *" },
          { type: "cron", schedule: "0 18 * * *" },
        ],
      };
      const enabled = await f.create(trigger, true),
        paused = await f.create(trigger, true);
      await f.service.mutate(f.botId, randomUUID(), null, { action: "pause", id: paused });
      await f.db.routine.updateMany({
        where: { id: { in: [enabled, paused] } },
        data: { nextRunAt: null, scheduleAnchorAt: null },
      });
      await f.store.reconcileAutomationFilesBatch(null, 100);
      expect((await f.read(enabled)).nextRunAt).toEqual(new Date("2026-01-01T18:00:00Z"));
      expect(await f.read(paused)).toMatchObject({ enabled: false, nextRunAt: null });
    } finally {
      await f.close();
    }
  }
);

integration(
  "legacy multi-interval routines keep their creation phase after their first recorded occurrence",
  async () => {
    const anchor = new Date("2026-01-01T00:00:00Z");
    setSystemTime(anchor);
    const f = await fixture();
    try {
      const specs = [{ minutes: 10 }, { minutes: 15 }];
      const id = await f.create(triggerFor(specs));
      const first = new Date("2026-01-01T00:10:00Z");
      setSystemTime(first);
      expect(await f.service.dispatchDue(first)).toBe(1);
      await f.settle(id);
      // Simulate a pre-upgrade row: the first-listener scheduler persisted minute20
      // and no definition anchor, while the original creation timestamp survives.
      const nextDue = new Date("2026-01-01T00:20:00Z");
      await f.db.routine.update({
        where: { id },
        data: { scheduleAnchorAt: null, nextRunAt: nextDue, createdAt: anchor },
      });
      setSystemTime(nextDue);
      expect(await f.service.dispatchDue(nextDue)).toBe(1);
      await f.settle(id);
      expect((await f.read(id)).nextRunAt).toEqual(arithmeticNext(specs, anchor, nextDue));
      const simultaneous = new Date("2026-01-01T00:30:00Z");
      setSystemTime(simultaneous);
      expect(await f.service.dispatchDue(simultaneous)).toBe(1);
      await f.settle(id);
      expect((await f.read(id)).nextRunAt).toEqual(arithmeticNext(specs, anchor, simultaneous));
    } finally {
      await f.close();
    }
  }
);

integration(
  "real dispatch visits both DST fold instants and preserves the second one across metadata edits",
  async () => {
    setSystemTime(new Date("2026-11-01T04:00:00Z"));
    const f = await fixture();
    try {
      const id = await f.create({ type: "cron", schedule: "CRON_TZ=America/New_York 30 1 * * *" });
      expect((await f.read(id)).nextRunAt).toEqual(new Date("2026-11-01T05:30:00Z"));
      const first = new Date("2026-11-01T05:30:00Z");
      setSystemTime(first);
      expect(await f.service.dispatchDue(first)).toBe(1);
      await f.settle(id);
      expect((await f.read(id)).nextRunAt).toEqual(new Date("2026-11-01T06:30:00Z"));
      setSystemTime(new Date("2026-11-01T05:45:00Z"));
      await f.service.mutateOwner(f.owner, randomUUID(), null, {
        action: "update",
        id,
        name: "Metadata during the repeated hour",
      });
      expect((await f.read(id)).nextRunAt).toEqual(new Date("2026-11-01T06:30:00Z"));
      const second = new Date("2026-11-01T06:30:00Z");
      setSystemTime(second);
      expect(await f.service.dispatchDue(second)).toBe(1);
      await f.settle(id);
      expect((await f.read(id)).nextRunAt).toEqual(new Date("2026-11-02T06:30:00Z"));
      expect(await f.db.routineExecution.count({ where: { routineId: id } })).toBe(2);
    } finally {
      await f.close();
    }
  }
);

integration(
  "real dispatch skips nonexistent spring clock times and coalesces simultaneous interval listeners",
  async () => {
    setSystemTime(new Date("2026-03-08T05:00:00Z"));
    const f = await fixture();
    try {
      const gap = await f.create({ type: "cron", schedule: "CRON_TZ=America/New_York 30 2 * * *" });
      expect((await f.read(gap)).nextRunAt).toEqual(new Date("2026-03-09T06:30:00Z"));
      await f.service.mutateOwner(f.owner, randomUUID(), null, { action: "pause", id: gap });
      const anchor = new Date("2026-03-08T05:00:00Z");
      const intervals = await f.create(triggerFor([{ minutes: 10 }, { minutes: 15 }]));
      const first = new Date(anchor.getTime() + 10 * ms);
      setSystemTime(first);
      expect(await f.service.dispatchDue(first)).toBe(1);
      await f.settle(intervals);
      const second = new Date(anchor.getTime() + 15 * ms);
      setSystemTime(second);
      expect(await f.service.dispatchDue(second)).toBe(1);
      await f.settle(intervals);
      const simultaneous = new Date(anchor.getTime() + 30 * ms);
      setSystemTime(simultaneous);
      expect(await f.service.dispatchDue(simultaneous)).toBe(1);
      await f.settle(intervals);
      expect(await f.service.dispatchDue(simultaneous)).toBe(0);
      expect((await f.read(intervals)).nextRunAt).toEqual(new Date(anchor.getTime() + 40 * ms));
      expect(await f.db.routineExecution.count({ where: { routineId: intervals } })).toBe(3);
    } finally {
      await f.close();
    }
  }
);

integration(
  "legacy phase inference covers both listener orders, old first occurrences, metadata revisions and observable reset boundaries",
  async () => {
    const creation = new Date("2026-01-01T00:00:00Z");
    setSystemTime(creation);
    const f = await fixture();
    try {
      for (const order of [
        [10, 15],
        [15, 10],
      ]) {
        for (const firstMinutes of [10, 15]) {
          for (const mode of ["steady", "metadata", "resume", "schedule-edit"]) {
            setSystemTime(creation);
            const specs = order.map((minutes) => ({ minutes }));
            const initial = mode === "schedule-edit" ? [{ minutes: 5 }, specs[1]!] : specs;
            const id = await f.create(triggerFor(initial));
            let origin = creation;
            await f.db.routine.update({ where: { id }, data: { createdAt: creation } });
            await f.db.routineRevision.updateMany({
              where: { routineId: id },
              data: { createdAt: creation },
            });
            if (mode === "resume") {
              setSystemTime(new Date(creation.getTime() + 6 * ms));
              await f.service.mutateOwner(f.owner, randomUUID(), null, { action: "pause", id });
              await f.db.routineRevision.updateMany({
                where: { routineId: id, revision: 2 },
                data: { createdAt: new Date(creation.getTime() + 6 * ms) },
              });
              origin = new Date(creation.getTime() + 7 * ms);
              setSystemTime(origin);
              await f.service.mutateOwner(f.owner, randomUUID(), null, { action: "resume", id });
              await f.db.routineRevision.updateMany({
                where: { routineId: id, revision: 3 },
                data: { createdAt: origin },
              });
            } else if (mode === "schedule-edit") {
              origin = new Date(creation.getTime() + 7 * ms);
              setSystemTime(origin);
              await f.service.mutateOwner(f.owner, randomUUID(), null, {
                action: "update",
                id,
                trigger: triggerFor(specs),
              });
              await f.db.routineRevision.updateMany({
                where: { routineId: id, revision: 2 },
                data: { createdAt: origin },
              });
            }
            if (mode === "metadata") {
              setSystemTime(new Date(origin.getTime() + 2 * ms));
              await f.service.mutateOwner(f.owner, randomUUID(), null, {
                action: "update",
                id,
                prompt: "A historical metadata revision",
              });
              await f.db.routineRevision.updateMany({
                where: { routineId: id, revision: 2 },
                data: { createdAt: new Date(origin.getTime() + 2 * ms) },
              });
            }
            const first = new Date(origin.getTime() + firstMinutes * ms);
            await f.db.routine.update({
              where: { id },
              data: { scheduleAnchorAt: null, nextRunAt: first },
            });
            setSystemTime(first);
            expect(await f.service.dispatchDue(first)).toBe(1);
            await f.settle(id);
            expect((await f.read(id)).scheduleAnchorAt).toEqual(origin);
            const second = arithmeticNext(specs, origin, first);
            expect((await f.read(id)).nextRunAt).toEqual(second);
            await f.db.routine.update({ where: { id }, data: { scheduleAnchorAt: null } });
            setSystemTime(second);
            expect(await f.service.dispatchDue(second)).toBe(1);
            await f.settle(id);
            expect((await f.read(id)).nextRunAt).toEqual(arithmeticNext(specs, origin, second));
            await f.service.mutateOwner(f.owner, randomUUID(), null, { action: "delete", id });
          }
        }
      }
    } finally {
      await f.close();
    }
  },
  20_000
);

integration(
  "a missing legacy single-interval due time recovers its last schedule-edit phase",
  async () => {
    const creation = new Date("2026-01-01T17:00:00Z");
    setSystemTime(creation);
    const f = await fixture();
    try {
      const id = await f.create({ type: "cron", schedule: "@every 10m" }, true);
      await f.db.routine.update({ where: { id }, data: { createdAt: creation } });
      await f.db.routineRevision.updateMany({
        where: { routineId: id },
        data: { createdAt: creation },
      });
      const edit = new Date("2026-01-01T17:07:00Z");
      setSystemTime(edit);
      await f.service.mutate(f.botId, randomUUID(), null, {
        action: "update",
        id,
        schedule: "@every 5m",
      });
      await f.db.routineRevision.updateMany({
        where: { routineId: id, revision: 2 },
        data: { createdAt: edit },
      });
      await f.db.routine.update({
        where: { id },
        data: { scheduleAnchorAt: null, nextRunAt: null },
      });
      setSystemTime(new Date("2026-01-01T17:08:00Z"));
      await f.store.reconcileAutomationFilesBatch(null, 100);
      expect((await f.read(id)).nextRunAt).toEqual(new Date("2026-01-01T17:12:00Z"));
      expect((await f.read(id)).scheduleAnchorAt).toEqual(edit);
    } finally {
      await f.close();
    }
  }
);

integration(
  "quarantined Run now cannot execute cached instructions, while an ordinary paused routine remains testable",
  async () => {
    setSystemTime(new Date("2026-01-01T17:00:00Z"));
    const f = await fixture();
    try {
      const id = await f.create({ type: "cron", schedule: "@every 5m" }, true);
      const invalid = await f.read(id);
      const path = join(
        f.store.botDirectory(f.botId),
        "automations",
        invalid.slug,
        "automation.json"
      );
      await writeFile(path, "{ unfinished user instruction edit");
      await f.store.reconcileAutomationFilesBatch(null, 100);
      expect((await f.read(id)).validationError).toBeString();
      await expect(
        f.service.runNowOwner({ kind: "bot", id: f.botId }, id, randomUUID())
      ).rejects.toMatchObject({ code: "invalid_routine_definition" });
      expect(await f.db.routineExecution.count({ where: { routineId: id } })).toBe(0);
      const paused = await f.create({ type: "cron", schedule: "@every 5m" });
      await f.service.mutateOwner(f.owner, randomUUID(), null, { action: "pause", id: paused });
      expect(await f.service.runNowOwner(f.owner, paused, randomUUID())).toMatchObject({
        status: "queued",
        kind: "test",
      });
    } finally {
      await f.close();
    }
  }
);
