import { afterAll, afterEach, beforeAll, expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRoutineHarness } from "./fixtures/routines";

const integration = test.skipIf(!process.env.OPENTEAM_TEST_DATABASE_URL);
const at = new Date("2026-11-12T17:00:00Z");
afterEach(() => setSystemTime());
let harness: Awaited<ReturnType<typeof createRoutineHarness>>;
beforeAll(async () => {
  if (process.env.OPENTEAM_TEST_DATABASE_URL) harness = await createRoutineHarness();
});
afterAll(() => harness?.close());
async function fixture() {
  setSystemTime(at);
  const f = await harness.fixture(null);
  return { ...f, close: f.cleanup, db: harness.db };
}

integration(
  "unchanged file sync preserves a second-listener dispatch and committed run history",
  async () => {
    const f = await fixture();
    try {
      const id = await f.create({
        trigger: {
          type: "group",
          listeners: [
            { type: "cron", schedule: "CRON_TZ=America/New_York 0 3 * * *" },
            { type: "cron", schedule: "CRON_TZ=America/New_York 9 18 * * *" },
          ],
        },
      });
      const before = await f.read(id);
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
    const f = await fixture();
    try {
      const id = await f.create(),
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
    const f = await fixture();
    try {
      const first = await f.create(),
        second = await f.create({ name: "Healthy", schedule: "@every 5m" });
      const invalid = await f.read(first),
        healthy = await f.read(second);
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
