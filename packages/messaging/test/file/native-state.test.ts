import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAutomationFile,
  parseAutomationRuns,
  renderAutomationFile,
} from "../../src/automation-files";
import { atomicWrite } from "../../src/file-state";
import { appendRoutineRunLedger } from "../../src/routines";
import { parseSkillFile, renderSkillFile } from "../../src/skill-files";

test("skill frontmatter keeps unknown compatible fields", () => {
  const parsed = parseSkillFile(
    [
      "---",
      "name: Research helper",
      "description: Searches the local corpus when evidence is needed.",
      "model: fast",
      "metadata:",
      "  owner: user",
      '"x:y": value',
      "---",
      "",
      "# Workflow",
    ].join("\n"),
    "SKILL.md"
  );
  expect(parsed.frontmatter).toMatchObject({
    model: "fast",
    metadata: { owner: "user" },
    "x:y": "value",
  });
  const roundTrip = parseSkillFile(renderSkillFile(parsed), "SKILL.md");
  expect(roundTrip.frontmatter).toMatchObject({
    model: "fast",
    metadata: { owner: "user" },
    "x:y": "value",
  });
});

test("automation parser supports paused cron, event groups, and operational runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-automation-"));
  try {
    const automation = join(root, "automation.json");
    await atomicWrite(
      automation,
      JSON.stringify({
        name: "Cloud triage",
        prompt: "Triage the event.",
        trigger: {
          type: "group",
          listeners: [
            { type: "github", repo: "openteam/openteam", events: ["pr-opened"] },
            { type: "slack", channel: "#ops", match: { kind: "message" } },
          ],
        },
        triggerPresentation: {
          version: 1,
          trigger: { type: "webhook" },
        },
        pendingNotices: [" github-listener-scope ", "unknown-notice", "github-listener-scope"],
        enabled: false,
        provenance: "user",
      })
    );
    await atomicWrite(
      join(root, "runs.json"),
      JSON.stringify([
        {
          id: "run-1",
          trigger: "event",
          startedAt: 1,
          finishedAt: 2,
          status: "ok",
        },
      ])
    );
    const parsed = await parseAutomationFile(automation, await readFile(automation, "utf8"), "UTC");
    expect(parsed).toMatchObject({
      enabled: false,
      provenance: "user",
      triggerPresentation: null,
      pendingNotices: ["github-listener-scope"],
      schedule: null,
    });
    expect(parsed.runs).toHaveLength(1);
    expect(parseAutomationRuns("[]")).toEqual([]);

    await atomicWrite(
      automation,
      JSON.stringify({
        name: "Mixed trigger",
        prompt: "Run for either listener.",
        trigger: [{ type: "cron", schedule: "@every 5m" }, { type: "webhook" }],
      })
    );
    const mixed = await parseAutomationFile(automation, await readFile(automation, "utf8"), "UTC");
    expect(mixed.trigger).toMatchObject({ type: "group" });
    expect(mixed.schedule?.intervalSeconds).toBe(300);

    await atomicWrite(
      automation,
      JSON.stringify({
        name: "Presented schedule",
        prompt: "Keep the structured editor state.",
        trigger: { type: "cron", schedule: "0 8 * * 1-5" },
        triggerPresentation: {
          version: 2,
          kind: "bot-time-routines",
          schedules: [{ preset: "weekdays", time: "08:00" }],
        },
      })
    );
    const presented = await parseAutomationFile(
      automation,
      await readFile(automation, "utf8"),
      "UTC"
    );
    expect(presented.triggerPresentation).toEqual({
      version: 2,
      kind: "bot-time-routines",
      schedules: [{ preset: "weekdays", time: "08:00" }],
    });

    const longPrompt = "x".repeat(240_001);
    await atomicWrite(
      automation,
      JSON.stringify({ name: "Long prompt", prompt: longPrompt, schedule: "@daily" })
    );
    expect(
      (await parseAutomationFile(automation, await readFile(automation, "utf8"), "UTC")).prompt
    ).toHaveLength(longPrompt.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automation serialization preserves grouped cron scheduling and disk ledger semantics", () => {
  const rendered = JSON.parse(
    renderAutomationFile({
      name: "Grouped watcher",
      prompt: "Check both sources.",
      trigger: {
        type: "group",
        listeners: [
          { type: "github", repository: "openteam" },
          { type: "cron", schedule: "0 11 * * 1-5" },
        ],
      },
      triggerPresentation: null,
      scheduleText: JSON.stringify({ type: "group" }),
      enabled: false,
      provenance: "untrusted",
      createdAt: new Date(1),
      lastRunAt: null,
      pendingNotices: [],
      raisedNotices: [],
    })
  ) as Record<string, unknown>;
  expect(rendered.schedule).toBe("0 11 * * 1-5");
  expect(rendered.trigger).toMatchObject({ type: "group" });

  const ledger = appendRoutineRunLedger(
    [
      {
        id: "same-run",
        trigger: "schedule",
        startedAt: 1,
        status: "running",
      },
    ],
    {
      id: "same-run",
      trigger: "schedule",
      startedAt: 1,
      finishedAt: 2,
      status: "ok",
    }
  ) as Array<Record<string, unknown>>;
  expect(ledger).toHaveLength(1);
  expect(ledger[0]).toMatchObject({ status: "ok", finishedAt: 2 });
});
