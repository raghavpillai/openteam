import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerRuntime } from "../src/runtime";
import { assertSessionPath, disposableSessionPath } from "../src/runtime/session-path";

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

test("an executing context must be settled before its files are deleted", async () => {
  const f = await fixture();
  const path = join(f.sessionsDir, "2026-11-11_context.jsonl");
  await writeFile(path, "session");
  f.activeByContext.set("context", {});
  await expect(f.runtime.deleteContextSession("context", path)).rejects.toThrow("active context session");
  expect(await readFile(path, "utf8")).toBe("session");
  expect(f.disposed).toEqual([]);
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

test("context cleanup stays inside the sessions tree: outside files, outside legacy links and link targets are kept", async () => {
  const f = await fixture();
  const outside = join(f.root, "outside");
  await mkdir(outside);
  const target = join(outside, "keep.jsonl");
  await writeFile(target, "keep");
  await f.runtime.deleteContextSession("context", target);
  await symlink(outside, join(f.root, "sessions", "legacy"));
  await f.runtime.deleteContextSession("context", join(f.root, "sessions", "legacy", "keep.jsonl"));
  expect(await readFile(target, "utf8")).toBe("keep");
  // A final-component symlink is unlinked while its external target is preserved.
  const link = join(f.sessionsDir, "context.jsonl");
  await symlink(target, link);
  await f.runtime.deleteContextSession("context", link);
  expect(await stat(link).catch(() => null)).toBeNull();
  expect(await readFile(target, "utf8")).toBe("keep");
});

const piSessionsDir = "/home/box/.pi/agent/sessions/openteam";

describe("Pi session paths", () => {
  test("a turn only reopens a session inside the current session root", () => {
    expect(assertSessionPath(piSessionsDir, `${piSessionsDir}/one_ctx.jsonl`)).toBe(`${piSessionsDir}/one_ctx.jsonl`);
    for (const path of ["/home/box/.pi/agent/sessions/legacy/x.jsonl", `${piSessionsDir}/../escape.jsonl`])
      expect(() => assertSessionPath(piSessionsDir, path)).toThrow("outside the OpenTeam session directory");
  });

  test("discarding never leaves the sessions parent directory or drops a non-session file", () => {
    for (const path of ["/etc/passwd", "/home/box/.pi/agent/credentials.json", "/home/box/.pi/agent/sessions/../../secret.jsonl", "/home/box/.pi/agent/sessions"])
      expect(disposableSessionPath(piSessionsDir, path), path).toBeNull();
  });
});
