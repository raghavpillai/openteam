import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerRuntime } from "../src/runtime";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-context-deletion-"));
  roots.push(root);
  const sessionsDir = join(root, "sessions", "openteam");
  await mkdir(sessionsDir, { recursive: true });
  const activeByContext = new Map();
  const disposed: string[] = [];
  const runtime = Object.create(ComputerRuntime.prototype) as ComputerRuntime;
  Object.assign(runtime, {
    sessionsDir, activeByContext,
    providerConnections: { dispose: (id: string) => { disposed.push(id); } },
    compaction: { remove: async () => {} },
  });
  return { root, sessionsDir, runtime, activeByContext, disposed };
};

test("context deletion discovers the file when session attachment was not recorded", async () => {
  const f = await fixture();
  const path = join(f.sessionsDir, "2026-11-11_context.jsonl");
  await writeFile(path, "session");
  await f.runtime.deleteContextSession("context");
  expect(await stat(path).catch(() => null)).toBeNull();
  expect(f.disposed).toEqual(["context"]);
});

test("context deletion removes a recorded file under an old session root", async () => {
  const f = await fixture();
  const legacy = join(f.root, "sessions", "legacy");
  await mkdir(legacy);
  const path = join(legacy, "context.jsonl");
  await writeFile(path, "session");
  await f.runtime.deleteContextSession("context", path);
  expect(await stat(path).catch(() => null)).toBeNull();
});

test("context deletion preserves files outside the sessions parent", async () => {
  const f = await fixture();
  const path = join(f.root, "unrelated.jsonl");
  await writeFile(path, "keep");
  await f.runtime.deleteContextSession("context", path);
  expect(await readFile(path, "utf8")).toBe("keep");
});

test("an executing context must be settled before its files are deleted", async () => {
  const f = await fixture();
  const path = join(f.sessionsDir, "2026-11-11_context.jsonl");
  await writeFile(path, "session");
  f.activeByContext.set("context", {});
  await expect(f.runtime.deleteContextSession("context", path)).rejects.toThrow("active context session");
  expect(await readFile(path, "utf8")).toBe("session");
  expect(f.disposed).toEqual([]);
});

test("context cleanup never follows a legacy directory symlink outside the sessions tree", async () => {
  const f = await fixture();
  const outside = join(f.root, "outside");
  await mkdir(outside);
  const target = join(outside, "keep.jsonl");
  await writeFile(target, "keep");
  const legacy = join(f.root, "sessions", "legacy");
  await symlink(outside, legacy);
  await f.runtime.deleteContextSession("context", join(legacy, "keep.jsonl"));
  expect(await readFile(target, "utf8")).toBe("keep");
});

test("an internal legacy-directory symlink is cleaned without deleting another session", async () => {
  const f = await fixture();
  const path = join(f.sessionsDir, "context.jsonl");
  const unrelated = join(f.sessionsDir, "another.jsonl");
  await writeFile(path, "session");
  await writeFile(unrelated, "keep");
  const legacy = join(f.root, "sessions", "legacy");
  await symlink(f.sessionsDir, legacy);
  await f.runtime.deleteContextSession("context", join(legacy, "context.jsonl"));
  expect(await stat(path).catch(() => null)).toBeNull();
  expect(await readFile(unrelated, "utf8")).toBe("keep");
});

test("a final-component symlink is unlinked while its external target is preserved", async () => {
  const f = await fixture();
  const target = join(f.root, "keep.jsonl");
  await writeFile(target, "keep");
  const link = join(f.sessionsDir, "context.jsonl");
  await symlink(target, link);
  await f.runtime.deleteContextSession("context", link);
  expect(await stat(link).catch(() => null)).toBeNull();
  expect(await readFile(target, "utf8")).toBe("keep");
});
