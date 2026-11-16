import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { followUserTimeZone } from "../src/routines";
import { createRoutineHarness } from "./fixtures/routines";

const url = process.env.OPENTEAM_TEST_DATABASE_URL;
let harness: Awaited<ReturnType<typeof createRoutineHarness>>;
beforeAll(async () => {
  if (url) harness = await createRoutineHarness();
});
afterAll(() => harness?.close());
async function fixture() {
  const f = await harness.fixture(null);
  return { ...f, db: harness.db, close: f.cleanup };
}

test.skipIf(!url)(
  "metadata edits and manual runs preserve interval due time and anchor",
  async () => {
    const f = await fixture();
    try {
      const { owner, routineId: id } = await f.group({ type: "cron", schedule: "@every 15m" });
      const presentation = {
        version: 2,
        kind: "bot-time-routines",
        schedules: [{ preset: "interval", intervalAmount: 15, intervalUnit: "m" }],
      };
      await f.db.routine.update({ where: { id }, data: { triggerPresentation: presentation } });
      const before = await f.db.routine.findUniqueOrThrow({ where: { id } });
      await f.service.mutateOwner(owner, randomUUID(), null, {
        action: "update",
        id,
        name: "Renamed",
        prompt: "New instructions",
      });
      const after = await f.db.routine.findUniqueOrThrow({ where: { id } });
      expect(after.nextRunAt).toEqual(before.nextRunAt);
      expect(after.scheduleAnchorAt).toEqual(before.scheduleAnchorAt);
      expect(after.triggerPresentation).toEqual(presentation);
      await f.service.runNowOwner(owner, id, randomUUID());
      const manual = await f.db.routine.findUniqueOrThrow({ where: { id } });
      expect(manual.nextRunAt).toEqual(before.nextRunAt);
      expect(manual.scheduleAnchorAt).toEqual(before.scheduleAnchorAt);
    } finally {
      await f.close();
    }
  }
);

test.skipIf(!url)(
  "timezone change recalculates floating listeners behind intervals without shifting interval phase",
  async () => {
    const f = await fixture();
    try {
      const { routineId: id } = await f.group({
        type: "group",
        listeners: [
          { type: "cron", schedule: "@every 24h" },
          { type: "cron", schedule: "0 9 * * *" },
        ],
      });
      const now = new Date("2026-01-01T08:00:00Z"),
        anchor = new Date("2026-01-01T08:00:00Z");
      await f.db.routine.update({
        where: { id },
        data: { scheduleAnchorAt: anchor, nextRunAt: new Date("2026-01-01T09:00:00Z") },
      });
      await f.db.$transaction((tx) => followUserTimeZone(tx, "America/New_York", now));
      expect(
        (await f.db.routine.findUniqueOrThrow({ where: { id } })).nextRunAt?.toISOString()
      ).toBe("2026-01-01T14:00:00.000Z");
    } finally {
      await f.close();
    }
  }
);

test.skipIf(!url)(
  "a broken event destination does not block healthy listeners and retries stay idempotent",
  async () => {
    const f = await fixture();
    try {
      await f.create({ trigger: { type: "webhook" } });
      const { routineId: healthy } = await f.group({ type: "webhook" });
      await f.db.channel.update({ where: { id: f.channelId }, data: { archivedAt: new Date() } });
      const event = { id: randomUUID(), source: "webhook", kind: "webhook", text: "payload" };
      await expect(f.service.dispatchEventToAll(event)).rejects.toMatchObject({
        code: "routine_channel_unavailable",
      });
      expect(await f.db.routineExecution.count({ where: { routineId: healthy } })).toBe(1);
      await expect(f.service.dispatchEventToAll(event)).rejects.toMatchObject({
        code: "routine_channel_unavailable",
      });
      expect(await f.db.routineExecution.count({ where: { routineId: healthy } })).toBe(1);
    } finally {
      await f.close();
    }
  }
);
