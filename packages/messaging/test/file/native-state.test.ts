import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAutomationFile, parseAutomationRuns, renderAutomationFile } from "../../src/automation-files";
import { appendRoutineRunLedger } from "../../src/routines";

const root = await mkdtemp(join(tmpdir(), "openteam-automation-"));
const path = join(root, "automation.json");
afterEach(() => setSystemTime());
afterAll(() => rm(root, { recursive: true, force: true }));
const parse = async (fields: Record<string, unknown>, zone = "UTC") => {
  const text = JSON.stringify({ name: "Parser", prompt: "Instructions", ...fields });
  await writeFile(path, text);
  return parseAutomationFile(path, text, zone);
};

test("automation parser supports paused event groups, mixed triggers, presentations and operational runs", async () => {
  await writeFile(join(root, "runs.json"), JSON.stringify([{ id: "run-1", trigger: "event", startedAt: 1, finishedAt: 2, status: "ok" }]));
  const parsed = await parse({
    trigger: { type: "group", listeners: [
      { type: "github", repo: "openteam/openteam", events: ["pr-opened"] },
      { type: "slack", channel: "#ops", match: { kind: "message" } },
    ] },
    triggerPresentation: { version: 1, trigger: { type: "webhook" } },
    pendingNotices: [" github-listener-scope ", "unknown-notice", "github-listener-scope"],
    enabled: false,
    provenance: "user",
  });
  expect(parsed).toMatchObject({ enabled: false, provenance: "user", triggerPresentation: null, pendingNotices: ["github-listener-scope"], schedule: null });
  expect(parsed.runs).toHaveLength(1);
  expect(parseAutomationRuns("[]")).toEqual([]);
  const mixed = await parse({ trigger: [{ type: "cron", schedule: "@every 5m" }, { type: "webhook" }] });
  expect(mixed.trigger).toMatchObject({ type: "group" });
  expect(mixed.schedule?.intervalSeconds).toBe(300);
  const presentation = { version: 2, kind: "bot-time-routines", schedules: [{ preset: "weekdays", time: "08:00" }] };
  expect((await parse({ trigger: { type: "cron", schedule: "0 8 * * 1-5" }, triggerPresentation: presentation })).triggerPresentation).toEqual(presentation);
  await rm(join(root, "runs.json"));
});

test("file parser schedules every listener, validates later listeners and keeps long accepted cron text", async () => {
  const at = new Date("2026-11-12T17:00:00Z");
  setSystemTime(at);
  const nyc = (fields: Record<string, unknown>) => parse({ createdAt: at.getTime(), ...fields }, "America/New_York");
  const group = (...listeners: unknown[]) => ({ trigger: { type: "group", listeners } });
  const parsed = await nyc(group({ type: "cron", schedule: "CRON_TZ=America/New_York 0 3 * * *" }, { type: "cron", schedule: "CRON_TZ=America/New_York 9 18 * * *" }));
  expect(parsed.nextRunAt?.toISOString()).toBe("2026-11-12T23:09:00.000Z");
  await expect(nyc(group({ type: "cron", schedule: "0 3 * * *" }, { type: "cron", schedule: "* * * * *" }))).rejects.toThrow();
  await expect(nyc({ schedule: "0 3 * * *", ...group({ type: "cron", schedule: "0 3 * * *" }, { type: "invalid" }) })).rejects.toThrow();
  const longCron = [
    Array.from({ length: 12 }, (_, i) => i * 5).join(","),
    Array.from({ length: 24 }, (_, i) => i).join(","),
    Array.from({ length: 31 }, (_, i) => i + 1).join(","),
    "*",
    "*",
  ].join(" ");
  expect((await nyc({ trigger: { type: "cron", schedule: longCron } })).trigger.schedule).toBe(longCron);
});

test("automation serialization preserves grouped cron scheduling and disk ledger semantics", () => {
  const rendered = JSON.parse(renderAutomationFile({
    name: "Grouped watcher", prompt: "Check both sources.",
    trigger: { type: "group", listeners: [{ type: "github", repository: "openteam" }, { type: "cron", schedule: "0 11 * * 1-5" }] },
    triggerPresentation: null, scheduleText: JSON.stringify({ type: "group" }), enabled: false, provenance: "untrusted",
    createdAt: new Date(1), lastRunAt: null, pendingNotices: [], raisedNotices: [],
  })) as Record<string, unknown>;
  expect(rendered.schedule).toBe("0 11 * * 1-5");
  expect(rendered.trigger).toMatchObject({ type: "group" });
  const ledger = appendRoutineRunLedger(
    [{ id: "same-run", trigger: "schedule", startedAt: 1, status: "running" }],
    { id: "same-run", trigger: "schedule", startedAt: 1, finishedAt: 2, status: "ok" }
  ) as Array<Record<string, unknown>>;
  expect(ledger).toEqual([expect.objectContaining({ status: "ok", finishedAt: 2 })]);
});
