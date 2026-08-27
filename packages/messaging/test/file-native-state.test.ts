import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAutomationFile,
  parseAutomationRuns,
  renderAutomationFile,
} from "../src/automation-files";
import { atomicWrite } from "../src/file-state";
import {
  appendMemoryFact,
  forgetMemoryFact,
  memoryLogicalId,
  parseMemoryMarkdown,
  readMemoryTree,
} from "../src/memory-files";
import { parseSkillFile, renderSkillFile } from "../src/skill-files";
import { appendRoutineRunLedger } from "../src/routines";

test("memory parser preserves raw Markdown while indexing only exact fact lines", () => {
  const facts = parseMemoryMarkdown(
    [
      "# Heading",
      "prose stays on disk",
      "- (2026-08-27)   The   user prefers compact reports.   ",
      "  continuation is not joined",
      "- (bad-date) ignored",
      "- (2026-08-27) [episode] Chose file-native state.",
      "- (2026-08-27) [note] Follow up tomorrow.",
    ].join("\n"),
    true
  );
  expect(facts).toHaveLength(3);
  expect(facts[0]).toMatchObject({
    content: "The user prefers compact reports.",
    sourceLine: 3,
    sourceOrdinal: 0,
    tier: "profile",
    importance: 1,
  });
  expect(facts[1]).toMatchObject({ tier: "profile", importance: 1.5 });
  expect(facts[2]).toMatchObject({ tier: "note", importance: 0.5 });
  expect(facts[0]?.logicalId).toBe(memoryLogicalId("the user prefers compact reports."));
});

test("official memory writes dedupe and forget only the first raw occurrence", async () => {
  const root = await mkdtemp(join(tmpdir(), "openbot-memory-"));
  try {
    const first = await appendMemoryFact(
      root,
      "Uses net revenue.",
      "profile",
      new Date("2026-08-27")
    );
    const duplicate = await appendMemoryFact(
      root,
      "uses net revenue.",
      "log",
      new Date("2026-08-28")
    );
    expect(first.added).toBe(true);
    expect(duplicate.added).toBe(false);
    await atomicWrite(
      join(root, "profile.md"),
      "- (2026-08-27) Uses net revenue.\n- (2026-08-27) Uses net revenue.\n"
    );
    expect(
      (await readMemoryTree(root)).filter((fact) => fact.logicalId === first.logicalId)
    ).toHaveLength(2);
    expect((await forgetMemoryFact(root, "Uses net revenue.")).forgotten).toBe(true);
    expect(
      (await readMemoryTree(root)).filter((fact) => fact.logicalId === first.logicalId)
    ).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skill frontmatter keeps unknown compatible fields", () => {
  const parsed = parseSkillFile(
    [
      "---",
      "name: Research helper",
      "description: Searches the local corpus when evidence is needed.",
      "model: fast",
      "metadata:",
      "  owner: user",
      "---",
      "",
      "# Workflow",
    ].join("\n"),
    "SKILL.md"
  );
  expect(parsed.frontmatter).toMatchObject({
    model: "fast",
    metadata: { owner: "user" },
  });
  const roundTrip = parseSkillFile(renderSkillFile(parsed), "SKILL.md");
  expect(roundTrip.frontmatter).toMatchObject({
    model: "fast",
    metadata: { owner: "user" },
  });
});

test("automation parser supports paused cron, event groups, and operational runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "openbot-automation-"));
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
            { type: "github", repository: "openbot" },
            { type: "slack", channel: "ops" },
          ],
        },
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
      schedule: null,
    });
    expect(parsed.runs).toHaveLength(1);
    expect(parseAutomationRuns("[]")).toEqual([]);

    await atomicWrite(
      automation,
      JSON.stringify({
        name: "Mixed trigger",
        prompt: "Run for either listener.",
        trigger: [{ type: "cron", schedule: "@every 30s" }, { type: "webhook" }],
      })
    );
    const mixed = await parseAutomationFile(automation, await readFile(automation, "utf8"), "UTC");
    expect(mixed.trigger).toMatchObject({ type: "group" });
    expect(mixed.schedule?.intervalSeconds).toBe(30);
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
          { type: "github", repository: "openbot" },
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
