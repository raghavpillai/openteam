import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BoxStoreDirtyHint, type BoxStoreManifest, BoxStoreSync } from "../src/box-store-sync";

let root: string | null = null;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

/** Creates home/sand-data, home/.pi/agent and a workspace under `root/<prefix>`. */
const layout = async (prefix: string, workspaceName = `${prefix}-workspace`) => {
  const home = join(root!, `${prefix}-home`);
  const sandRoot = join(home, "sand-data");
  const workspaceRoot = join(root!, workspaceName);
  await Promise.all([mkdir(sandRoot, { recursive: true }), mkdir(join(home, ".pi", "agent"), { recursive: true }), mkdir(workspaceRoot, { recursive: true })]);
  return { home, sandRoot, workspaceRoot };
};
const blob = async (manifest: BoxStoreManifest, path: string) =>
  readFile(join(root!, "store", "blobs", manifest.files.find((file) => file.path === path)!.sha256), "utf8");

describe("OpenTeam-compatible box-store synchronization", () => {
  test("stat reuse detects same-size content changes even when mtime is restored", async () => {
    root = await mkdtemp(join(tmpdir(), "openteam-box-store-signature-safety-"));
    const dirs = await layout("source");
    const path = join(dirs.workspaceRoot, "same-size.txt");
    await writeFile(path, "aaaa");
    const sync = new BoxStoreSync({ storeRoot: join(root, "replica"), ...dirs });
    const before = await sync.snapshotOut();
    const beforeStats = await stat(path);
    await writeFile(path, "bbbb");
    await utimes(path, beforeStats.atime, beforeStats.mtime);
    const after = await sync.snapshotOut();
    expect(after.files[0]?.sha256).not.toBe(before.files[0]?.sha256);
    expect(sync.diagnostics()).toMatchObject({ sourceFilesRead: 2, contentHashes: 2 });
  });

  test("coalesces a burst during an active snapshot into one merged rerun", async () => {
    root = await mkdtemp(join(tmpdir(), "openteam-box-store-coalescing-"));
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => (signalStarted = resolve));
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    class ControlledSync extends BoxStoreSync {
      readonly hints: BoxStoreDirtyHint[] = [];

      override async snapshotOut(hint: BoxStoreDirtyHint = { all: true }): Promise<BoxStoreManifest> {
        this.hints.push(hint);
        if (this.hints.length === 1) {
          signalStarted?.();
          await firstGate;
        }
        return { version: 1, revision: this.hints.length, generatedAt: new Date(0).toISOString(), files: [], tombstones: [], etag: `run-${this.hints.length}` };
      }
    }
    const sync = new ControlledSync({ storeRoot: join(root, "replica") });
    sync.scheduleSnapshot(0, { workspace: true });
    await started;
    for (let index = 0; index < 100; index += 1) {
      sync.scheduleSnapshot(0, { agentIds: [index % 2 === 0 ? "agent-a" : "agent-b"], pi: true, chrome: true });
    }
    releaseFirst?.();
    await sync.flushScheduledSnapshots();

    expect(sync.hints).toHaveLength(2);
    expect(sync.hints[0]).toMatchObject({ workspace: true });
    expect(sync.hints[1]).toMatchObject({ all: false, agentIds: ["agent-a", "agent-b"], pi: true, chrome: true });
    expect(sync.diagnostics()).toMatchObject({ scheduledRequests: 101, coalescedRequests: 100 });
  });

  test("snapshots WAL databases with VACUUM and hydrates by hash without pruning extras", async () => {
    root = await mkdtemp(join(tmpdir(), "openteam-box-store-"));
    const replica = join(root, "replica");
    const sourceDirs = await layout("source");
    await mkdir(join(sourceDirs.sandRoot, "agents", "probe"), { recursive: true });
    await writeFile(join(sourceDirs.sandRoot, "agents", "probe", "profile.json"), "source-profile\n");
    await writeFile(join(sourceDirs.workspaceRoot, "workspace.txt"), "workspace-source\n");
    const database = new Database(join(sourceDirs.sandRoot, "agents", "probe", "store.db"), { create: true });
    database.exec("PRAGMA journal_mode=WAL; CREATE TABLE values_table(value TEXT) STRICT");
    database.query("INSERT INTO values_table(value) VALUES (?)").run("wal-visible");

    const source = new BoxStoreSync({ storeRoot: replica, ...sourceDirs });
    const manifest = await source.snapshotOut();
    expect(manifest.files.some(({ path }) => path.endsWith("store.db-wal"))).toBeFalse();
    const storeHash = manifest.files.find(({ path }) => path.endsWith("/store.db"))!.sha256;
    const first = source.diagnostics();
    await source.snapshotOut();
    // An unchanged tree, even after a restart, is reused from stat signatures alone.
    expect(source.diagnostics()).toMatchObject({ sourceFilesRead: first.sourceFilesRead, contentHashes: first.contentHashes, sqliteVacuums: first.sqliteVacuums });
    const restartedSource = new BoxStoreSync({ storeRoot: replica, ...sourceDirs });
    await restartedSource.snapshotOut();
    expect(restartedSource.diagnostics()).toMatchObject({ sourceFilesRead: 0, contentHashes: 0, sqliteVacuums: 0, signatureReuses: manifest.files.length });
    database.query("INSERT INTO values_table(value) VALUES (?)").run("wal-changed");
    expect((await source.snapshotOut()).files.find(({ path }) => path.endsWith("/store.db"))?.sha256).not.toBe(storeHash);
    database.close(false);

    const targetDirs = await layout("target");
    await mkdir(join(targetDirs.sandRoot, "agents", "probe"), { recursive: true });
    await writeFile(join(targetDirs.sandRoot, "agents", "probe", "profile.json"), "stale-profile\n");
    await writeFile(join(targetDirs.sandRoot, "local-extra.txt"), "keep-local\n");
    const target = new BoxStoreSync({ storeRoot: replica, ...targetDirs });
    expect(await target.copyIn()).toMatchObject({ copied: manifest.files.length, skipped: 0 });
    expect(await readFile(join(targetDirs.sandRoot, "agents", "probe", "profile.json"), "utf8")).toBe("source-profile\n");
    expect(await readFile(join(targetDirs.sandRoot, "local-extra.txt"), "utf8")).toBe("keep-local\n");
    const restored = new Database(join(targetDirs.sandRoot, "agents", "probe", "store.db"), { readonly: true });
    try {
      expect(restored.query("SELECT value FROM values_table").get()).toEqual({ value: "wal-visible" });
    } finally {
      restored.close(false);
    }
    expect(await target.copyIn()).toEqual({ copied: 0, skipped: manifest.files.length });
  });

  test("propagates tombstones, recursively repairs transfer temps, and refuses live DB clobbers", async () => {
    root = await mkdtemp(join(tmpdir(), "openteam-box-store-recovery-"));
    const replica = join(root, "replica");
    const sourceDirs = await layout("source");
    const agentDirectory = join(sourceDirs.sandRoot, "agents", "probe");
    await mkdir(agentDirectory, { recursive: true });
    await writeFile(join(agentDirectory, "profile.json"), "first\n");
    const database = new Database(join(agentDirectory, "store.db"), { create: true });
    database.exec("CREATE TABLE value_table(value TEXT) STRICT");
    database.close(false);
    const source = new BoxStoreSync({ storeRoot: replica, ...sourceDirs });
    await source.snapshotOut();
    await rm(join(agentDirectory, "profile.json"));
    expect((await source.snapshotOut()).tombstones?.some(({ path }) => path.endsWith("/profile.json"))).toBeTrue();

    const targetDirs = await layout("target");
    const { home: targetHome, sandRoot: targetSand, workspaceRoot: targetWorkspace } = targetDirs;
    const removed = [join(targetSand, "agents", "probe", "profile.json"), join(targetSand, "agents", "probe", "nested", ".box-store-part-leaked"), join(replica, ".box-store-part-manifest-leaked")];
    const untouched = [join(targetHome, "unrelated-cache", "deep", ".box-store-part-unrelated"), join(targetWorkspace, ".git", "objects", ".box-store-part-git-cache")];
    for (const path of [...removed, ...untouched]) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, path);
    }
    const target = new BoxStoreSync({ storeRoot: replica, ...targetDirs });
    await target.start();
    await target.copyIn();
    for (const path of removed) await expect(readFile(path)).rejects.toThrow();
    for (const path of untouched) expect(await readFile(path, "utf8")).toBe(path);
    expect(target.diagnostics().repairDirectoriesVisited).toBeLessThan(10);

    await writeFile(join(targetSand, "agents", "probe", "store.db"), "different bytes");
    const liveTarget = new BoxStoreSync({ storeRoot: replica, ...targetDirs, hasLiveAgentHandle: (id) => id === "probe" });
    await expect(liveTarget.copyIn()).rejects.toThrow("live-agent");
  });

  test("skips Chromium caches in profiles while keeping sign-in state and same-named workspace folders", async () => {
    root = await mkdtemp(join(tmpdir(), "openteam-box-store-chrome-caches-"));
    const home = join(root, "home");
    const sandRoot = join(home, "sand-data");
    const workspaceRoot = join(root, "workspace");
    const profile = join(home, "chrome-profile-2");
    const cached = [
      "Default/Service Worker/CacheStorage/origin/entry_0",
      "component_crx_cache/component",
      "extensions_crx_cache/extension",
      "Default/DawnGraphiteCache/data_1",
      "Default/DawnWebGPUCache/data_1",
    ];
    const kept = ["Default/Cookies", "Default/Service Worker/ScriptCache/script", "Default/Local Storage/leveldb/000003.log"];
    for (const path of [...cached, ...kept, "../../workspace/CacheStorage/note.txt"]) {
      await mkdir(join(profile, path, ".."), { recursive: true });
      await writeFile(join(profile, path), path);
    }
    await mkdir(sandRoot, { recursive: true });
    const sync = new BoxStoreSync({ storeRoot: join(root, "store"), home, sandRoot, workspaceRoot });
    const paths = (await sync.snapshotOut()).files.map(({ path }) => path);
    expect(paths).toEqual([
      ...kept.map((path) => `home/box/chrome-profile-2/${path}`).sort(),
      "workspace/CacheStorage/note.txt",
    ]);
    const chrome = (await sync.snapshotOut({ all: false, chrome: true })).files.map(({ path }) => path);
    expect(chrome).toEqual(paths);
  });

  test("snapshots a running browser's profile at most once per interval, and on browser requests and exit", async () => {
    root = await mkdtemp(join(tmpdir(), "openteam-box-store-live-profile-"));
    const home = join(root, "home");
    const sandRoot = join(home, "sand-data");
    const workspaceRoot = join(root, "workspace");
    const profile = join(home, "chrome-profile");
    await mkdir(join(profile, "Default"), { recursive: true });
    await mkdir(sandRoot, { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    // Chromium holds this symlink for as long as it runs and removes it on exit.
    await symlink("openteam-1234", join(profile, "SingletonLock"));
    const preferences = join(profile, "Default", "Preferences");
    const note = join(workspaceRoot, "note.txt");
    const sync = new BoxStoreSync({ storeRoot: join(root, "store"), home, sandRoot, workspaceRoot });
    const saved = blob;
    const profilePath = "home/box/chrome-profile/Default/Preferences";

    await writeFile(preferences, "v1");
    await writeFile(note, "w1");
    expect(await saved(await sync.snapshotOut(), profilePath)).toBe("v1");

    await writeFile(preferences, "v2");
    await writeFile(note, "w2");
    const periodic = await sync.snapshotOut();
    expect(await saved(periodic, profilePath)).toBe("v1");
    expect(await saved(periodic, "workspace/note.txt")).toBe("w2");
    expect(periodic.tombstones ?? []).toEqual([]);

    expect(await saved(await sync.snapshotOut({ all: true, chrome: true }), profilePath)).toBe("v2");
    await writeFile(preferences, "v3");
    expect(await saved(await sync.snapshotOut({ all: false, chrome: true }), profilePath)).toBe("v3");

    await writeFile(preferences, "v4");
    expect(await saved(await sync.snapshotOut(), profilePath)).toBe("v3");
    await rm(join(profile, "SingletonLock"));
    expect(await saved(await sync.snapshotOut(), profilePath)).toBe("v4");

    const shortInterval = new BoxStoreSync({ storeRoot: join(root, "store"), home, sandRoot, workspaceRoot, chromeProfileIntervalMs: 1_000 });
    await symlink("openteam-1234", join(profile, "SingletonLock"));
    await shortInterval.snapshotOut();
    await writeFile(preferences, "v5");
    expect(await saved(await shortInterval.snapshotOut(), profilePath)).toBe("v4");
    await Bun.sleep(1_100);
    expect(await saved(await shortInterval.snapshotOut(), profilePath)).toBe("v5");
  });

  test("a turn's browser request captures only that bot's running profile", async () => {
    root = await mkdtemp(join(tmpdir(), "openteam-box-store-profile-request-"));
    const home = join(root, "home");
    const sandRoot = join(home, "sand-data");
    const workspaceRoot = join(root, "workspace");
    await mkdir(sandRoot, { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    const used = "home/box/chrome-profile-2/Default/Preferences";
    const idle = "home/box/chrome-profile/Default/Preferences";
    for (const name of ["chrome-profile", "chrome-profile-2"]) {
      await mkdir(join(home, name, "Default"), { recursive: true });
      // Both browsers are running.
      await symlink("openteam-1234", join(home, name, "SingletonLock"));
    }
    const write = (path: string, value: string) => writeFile(join(home, path.slice("home/box/".length)), value);
    const sync = new BoxStoreSync({ storeRoot: join(root, "store"), home, sandRoot, workspaceRoot });
    const saved = blob;

    await write(used, "v1");
    await write(idle, "v1");
    await sync.snapshotOut();
    await write(used, "v2");
    await write(idle, "v2");
    const turnEnd = await sync.snapshotOut({ all: false, chromeProfiles: ["chrome-profile-2"] });
    expect(await saved(turnEnd, used)).toBe("v2");
    expect(await saved(turnEnd, idle)).toBe("v1");

    // A periodic full snapshot that absorbs the request still captures that profile.
    await write(used, "v3");
    await write(idle, "v3");
    const merged = await sync.snapshotOut({ all: true, chromeProfiles: ["chrome-profile-2"] });
    expect(await saved(merged, used)).toBe("v3");
    expect(await saved(merged, idle)).toBe("v1");
  });

});
