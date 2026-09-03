import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAutomationFile, parseAutomationRuns } from "../src/automation-files";
import { atomicWrite, listDirectories, readBytes, readText, safeFolderId } from "../src/file-state";

test("atomic writes never expose mixed payloads or leave temporary files", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-atomic-"));
  const path = join(root, "profile.json");
  const payloads = Array.from(
    { length: 24 },
    (_, index) => `${String(index).padStart(2, "0")}:${"x".repeat(8_192)}\n`
  );
  try {
    await Promise.all(payloads.map((payload) => atomicWrite(path, payload)));
    expect(payloads).toContain(await readFile(path, "utf8"));
    expect((await readdir(root)).filter((name) => name.endsWith(".part"))).toEqual([]);

    const directoryTarget = join(root, "cannot-replace-directory");
    await mkdir(directoryTarget);
    await expect(atomicWrite(directoryTarget, "nope")).rejects.toThrow();
    expect((await readdir(root)).filter((name) => name.endsWith(".part"))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("state readers reject symlinks and directory discovery does not follow them", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "openteam-outside-"));
  try {
    const outsideFile = join(outside, "secret.txt");
    await writeFile(outsideFile, "must not be read through a state pointer");
    await symlink(outsideFile, join(root, "profile.json"));
    await expect(readText(join(root, "profile.json"))).rejects.toThrow("must be a regular file");
    await expect(readBytes(join(root, "profile.json"))).rejects.toThrow("must be a regular file");

    await mkdir(join(root, "real-skill"));
    await symlink(outside, join(root, "linked-skill"));
    expect(await listDirectories(root)).toEqual(["real-skill"]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("folder identifiers reject traversal, separators, and null bytes", () => {
  for (const unsafe of ["", ".", "..", "../escape", "nested/path", "a\\b", "x\0y"]) {
    expect(() => safeFolderId(unsafe)).toThrow("not a safe folder id");
  }
  expect(safeFolderId("valid-slug_123")).toBe("valid-slug_123");
});

test("automation parsing applies schedule fallback and validates incompatible groups", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-auto-adversarial-"));
  const automationPath = join(root, "automation.json");
  try {
    await atomicWrite(
      automationPath,
      JSON.stringify({
        name: "Fallback",
        prompt: "Use the cron fallback.",
        trigger: { type: "not-supported" },
        schedule: "@every 30s",
      })
    );
    const fallback = await parseAutomationFile(
      automationPath,
      await readFile(automationPath, "utf8"),
      "UTC"
    );
    expect(fallback.trigger).toEqual({ type: "cron", schedule: "@every 30s" });
    expect(fallback.schedule?.intervalSeconds).toBe(30);
    expect(fallback.enabled).toBe(true);
    expect(fallback.provenance).toBe("untrusted");

    await atomicWrite(
      automationPath,
      JSON.stringify({
        name: "Invalid group",
        prompt: "This must not load.",
        trigger: {
          type: "group",
          listeners: [
            { type: "origin", repo: "openteam/openteam", events: ["pr-opened"] },
            { type: "webhook" },
          ],
        },
      })
    );
    await expect(
      parseAutomationFile(automationPath, await readFile(automationPath, "utf8"), "UTC")
    ).rejects.toThrow("origin cannot be grouped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("routine run ledgers normalize unknown enums, order entries, and retain only 20", () => {
  const input = Array.from({ length: 25 }, (_, index) => ({
    id: `run-${index}`,
    trigger: index === 0 ? "future-trigger" : "manual",
    startedAt: 25 - index,
    status: index === 0 ? "future-status" : "running",
    extensionField: { retained: true },
  }));
  const parsed = parseAutomationRuns(JSON.stringify(input));
  expect(parsed).toHaveLength(20);
  expect(parsed.map((run) => run.startedAt)).toEqual(
    Array.from({ length: 20 }, (_, index) => 25 - index)
  );
  const normalized = parsed.find((run) => run.id === "run-0");
  expect(normalized).toMatchObject({
    trigger: "schedule",
    status: "ok",
  });
  expect(normalized).not.toHaveProperty("extensionField");
});

test("routine run ledgers recover per row and clamp optional fields", () => {
  expect(parseAutomationRuns("{ bad")).toEqual([]);
  expect(parseAutomationRuns("{}")).toEqual([]);
  const parsed = parseAutomationRuns(
    JSON.stringify([
      null,
      { id: "", startedAt: 1 },
      {
        id: "good",
        startedAt: 2,
        finishedAt: "bad",
        detail: `  ${"x".repeat(400)}  `,
        event: ` ${"y".repeat(400)} `,
        coalescedRunIds: Array.from({ length: 30 }, (_, index) => `id-${index}`),
      },
    ])
  );
  expect(parsed).toHaveLength(1);
  expect(parsed[0]).toMatchObject({
    id: "good",
    trigger: "schedule",
    status: "ok",
    finishedAt: null,
  });
  expect(String(parsed[0]?.detail)).toHaveLength(300);
  expect(String(parsed[0]?.event)).toHaveLength(300);
  expect(parsed[0]?.coalescedRunIds).toHaveLength(25);
});
