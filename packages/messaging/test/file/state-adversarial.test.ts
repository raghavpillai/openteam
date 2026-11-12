import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDataStore } from "../../src/agent-data";
import { parseAutomationRuns } from "../../src/automation-files";
import {
  atomicWrite,
  listDirectories,
  readBytes,
  readText,
  safeFolderId,
} from "../../src/file-state";

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

test("an avatar source must stay inside the bot directory, even through a symlink", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "openteam-avatar-"));
  const botId = "00000000-0000-4000-8000-000000000001";
  const updates: unknown[] = [];
  const store = Object.assign(Object.create(AgentDataStore.prototype), {
    root: temporary,
    prisma: { bot: { update: async (input: unknown) => updates.push(input) } },
  }) as any;
  const install = (path: string) => store.installAvatarFromPath(botId, path);
  try {
    const directory = store.botDirectory(botId);
    await mkdir(directory, { recursive: true });
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const outside = join(temporary, "outside.png");
    await writeFile(outside, png);
    await symlink(outside, join(directory, "escaped.png"));
    await expect(install("escaped.png")).rejects.toThrow("The avatar source must stay inside");
    await expect(install("../../outside.png")).rejects.toThrow("The avatar source must stay inside");
    await expect(install(outside)).rejects.toThrow("The avatar source must stay inside");
    expect(updates).toEqual([]);

    await writeFile(join(directory, "source.png"), png);
    expect((await install("source.png")).bytes).toBe(png.length);
    expect(await readFile(join(directory, "avatar.png"))).toEqual(Buffer.from(png));
    expect(updates).toHaveLength(1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("folder identifiers reject traversal, separators, and null bytes", () => {
  for (const unsafe of ["", ".", "..", "../escape", "nested/path", "a\\b", "x\0y"]) {
    expect(() => safeFolderId(unsafe)).toThrow("not a safe folder id");
  }
  expect(safeFolderId("valid-slug_123")).toBe("valid-slug_123");
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
