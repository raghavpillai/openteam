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
import {
  appendMemoryFact,
  applyMemorySynthesis,
  boundMemoryEvidenceText,
  consumeEvidence,
  forgetMemoryFact,
  markMemoryOrigin,
  memoryLogicalId,
  parseMemoryMarkdown,
  prepareMemorySynthesis,
  readMemoryTree,
  tombstoneMemory,
} from "../../src/memory-files";
import { appendRoutineRunLedger } from "../../src/routines";
import { parseSkillFile, renderSkillFile } from "../../src/skill-files";

test("memory parser preserves raw Markdown while indexing only exact fact lines", () => {
  const facts = parseMemoryMarkdown(
    [
      "# Heading",
      "prose stays on disk",
      "- (2026-08-27)   The   user prefers compact reports.   ",
      "  continuation is not joined",
      "- (bad-date) ignored",
      "- (2026-99-99) Invalid calendar dates are ignored.",
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

test("dreaming synthesis rejects stale and explicit edits while honoring tombstones", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-synthesis-"));
  try {
    const explicit = await appendMemoryFact(root, "Prefers exact totals.", "profile");
    const synthesized = await appendMemoryFact(root, "The launch is planned for Friday.", "log");
    await markMemoryOrigin(root, explicit.logicalId, "explicit");
    await markMemoryOrigin(root, synthesized.logicalId, "synthesized");

    const initial = await prepareMemorySynthesis(root);
    expect(initial.memories[0]).toMatchObject({
      id: explicit.logicalId,
      origin: "explicit",
      kind: "profile",
    });
    expect(
      await applyMemorySynthesis(root, initial, [
        { action: "remove", id: explicit.logicalId, sourceEvidenceIds: ["clock"] },
      ])
    ).toBe("invalid");

    await atomicWrite(
      join(root, "log", "manual.md"),
      "- (2026-08-27) A concurrent disk edit wins.\n"
    );
    expect(await applyMemorySynthesis(root, initial, [])).toBe("stale");

    await tombstoneMemory(root, memoryLogicalId("Do not restore this."));
    const fresh = await prepareMemorySynthesis(root);
    expect(
      await applyMemorySynthesis(
        root,
        fresh,
        [
          {
            action: "create",
            content: "Do not restore this.",
            kind: "log",
            sourceEvidenceIds: ["evidence-1"],
          },
          {
            action: "update",
            id: synthesized.logicalId,
            content: "The launch is planned for Monday.",
            kind: "log",
            sourceEvidenceIds: ["evidence-1"],
          },
        ],
        new Date("2026-08-28T12:00:00Z")
      )
    ).toBe("committed");
    const contents = (await readMemoryTree(root)).map((fact) => fact.content);
    expect(contents).toContain("The launch is planned for Monday.");
    expect(contents).not.toContain("The launch is planned for Friday.");
    expect(contents).not.toContain("Do not restore this.");
    expect(Number(await readFile(join(root, ".dreaming", "next-refresh-at"), "utf8"))).toBe(
      new Date("2026-08-29T12:00:00Z").getTime()
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("official memory writes dedupe and forget only the first raw occurrence", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-memory-"));
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
    expect(
      (await readFile(join(root, "profile.md"), "utf8")).startsWith("# About the user\n\n<!--")
    ).toBe(true);
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
    await mkdir(join(root, "log", "nested"), { recursive: true });
    await atomicWrite(join(root, "log", "manual.md"), "- (2026-08-29) Read this log file.\n");
    await atomicWrite(
      join(root, "log", "nested", "ignored.md"),
      "- (2026-08-29) Ignore nested log files.\n"
    );
    expect((await readMemoryTree(root)).map((fact) => fact.content)).toContain(
      "Read this log file."
    );
    expect((await readMemoryTree(root)).map((fact) => fact.content)).not.toContain(
      "Ignore nested log files."
    );
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
        trigger: [{ type: "cron", schedule: "@every 30s" }, { type: "webhook" }],
      })
    );
    const mixed = await parseAutomationFile(automation, await readFile(automation, "utf8"), "UTC");
    expect(mixed.trigger).toMatchObject({ type: "group" });
    expect(mixed.schedule?.intervalSeconds).toBe(30);

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

test("dreaming evidence uses head-tail bounds and drops malformed spool rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-evidence-"));
  try {
    const evidence = join(root, ".dreaming", "evidence");
    await mkdir(evidence, { recursive: true });
    const id = "123e4567-e89b-12d3-a456-426614174000";
    const longText = `head${"x".repeat(9_000)}tail`;
    await atomicWrite(
      join(evidence, `${id}.json`),
      JSON.stringify({ id, occurredAt: 12, user: longText, assistant: "ok" })
    );
    const badId = "123e4567-e89b-12d3-a456-426614174001";
    await atomicWrite(
      join(evidence, `${badId}.json`),
      JSON.stringify({ id: "mismatch", occurredAt: -1, user: "bad", assistant: "bad" })
    );
    const consumed = await consumeEvidence(root);
    expect(consumed).toHaveLength(1);
    expect(consumed[0]?.user).toBe(boundMemoryEvidenceText(longText));
    expect(consumed[0]?.user).toContain("[...middle omitted...]");
    expect(consumed[0]?.user).toHaveLength(8_000);
    await expect(readFile(join(evidence, `${badId}.json`), "utf8")).rejects.toThrow();
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
