import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BoxStoreDirtyHint, type BoxStoreManifest, BoxStoreSync } from "../src/box-store-sync";
import { BotAgentStore } from "../src/bot-agent-store";

let root: string | null = null;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

describe("OpenTeam-compatible box-store synchronization", () => {
  test("stat reuse detects same-size content changes even when mtime is restored", async () => {
    root = await mkdtemp(join(tmpdir(), "openteam-box-store-signature-safety-"));
    const home = join(root, "home");
    const sandRoot = join(home, "sand-data");
    const workspaceRoot = join(root, "workspace");
    const path = join(workspaceRoot, "same-size.txt");
    await Promise.all([
      mkdir(sandRoot, { recursive: true }),
      mkdir(join(home, ".pi", "agent"), { recursive: true }),
      mkdir(workspaceRoot, { recursive: true }),
    ]);
    await writeFile(path, "aaaa");
    const sync = new BoxStoreSync({
      storeRoot: join(root, "replica"),
      home,
      sandRoot,
      workspaceRoot,
    });
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
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    class ControlledSync extends BoxStoreSync {
      readonly hints: BoxStoreDirtyHint[] = [];

      override async snapshotOut(
        hint: BoxStoreDirtyHint = { all: true }
      ): Promise<BoxStoreManifest> {
        this.hints.push(hint);
        if (this.hints.length === 1) {
          signalStarted?.();
          await firstGate;
        }
        return {
          version: 1,
          revision: this.hints.length,
          generatedAt: new Date(0).toISOString(),
          files: [],
          tombstones: [],
          etag: `run-${this.hints.length}`,
        };
      }
    }
    const sync = new ControlledSync({ storeRoot: join(root, "replica") });
    sync.scheduleSnapshot(0, { workspace: true });
    await started;
    for (let index = 0; index < 100; index += 1) {
      sync.scheduleSnapshot(0, {
        agentIds: [index % 2 === 0 ? "agent-a" : "agent-b"],
        pi: true,
        chrome: true,
      });
    }
    releaseFirst?.();
    await sync.flushScheduledSnapshots();

    expect(sync.hints).toHaveLength(2);
    expect(sync.hints[0]).toMatchObject({ workspace: true });
    expect(sync.hints[1]).toMatchObject({
      all: false,
      agentIds: ["agent-a", "agent-b"],
      pi: true,
      chrome: true,
    });
    expect(sync.diagnostics()).toMatchObject({
      scheduledRequests: 101,
      coalescedRequests: 100,
    });
  });

  test("partial snapshots preserve clean roots and retain exact deletion tombstones", async () => {
    root = await mkdtemp(join(tmpdir(), "openteam-box-store-dirty-paths-"));
    const sourceHome = join(root, "source-home");
    const sourceSand = join(sourceHome, "sand-data");
    const sourceWorkspace = join(root, "source-workspace");
    const agentOne = join(sourceSand, "agents", "one");
    const agentTwo = join(sourceSand, "agents", "two");
    await Promise.all([
      mkdir(agentOne, { recursive: true }),
      mkdir(agentTwo, { recursive: true }),
      mkdir(join(sourceHome, ".pi", "agent"), { recursive: true }),
      mkdir(sourceWorkspace, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(agentOne, "profile.json"), "one-before\n"),
      writeFile(join(agentTwo, "profile.json"), "two-before\n"),
      writeFile(join(sourceWorkspace, "workspace.txt"), "workspace-before\n"),
      writeFile(join(sourceHome, ".pi", "agent", "session.jsonl"), "pi-before\n"),
      writeFile(join(sourceSand, "search-index.db"), "search-before\n"),
    ]);
    const sync = new BoxStoreSync({
      storeRoot: join(root, "replica"),
      home: sourceHome,
      sandRoot: sourceSand,
      workspaceRoot: sourceWorkspace,
    });
    const initial = await sync.snapshotOut();
    const metricsAfterInitial = sync.diagnostics();

    await writeFile(join(agentOne, "profile.json"), "one-after\n");
    await writeFile(join(sourceWorkspace, "workspace.txt"), "workspace-untracked\n");
    const partial = await sync.snapshotOut({ agentIds: ["one"] });
    const partialMetrics = sync.diagnostics();
    expect(partial.files).toHaveLength(initial.files.length);
    expect(partialMetrics.sourceFilesInspected - metricsAfterInitial.sourceFilesInspected).toBe(1);
    expect(partialMetrics.sourceFilesRead - metricsAfterInitial.sourceFilesRead).toBe(1);
    const workspaceBefore = initial.files.find(({ path }) => path === "workspace/workspace.txt");
    expect(partial.files.find(({ path }) => path === "workspace/workspace.txt")).toEqual(
      workspaceBefore
    );

    const full = await sync.snapshotOut();
    expect(full.files.find(({ path }) => path === "workspace/workspace.txt")?.sha256).not.toBe(
      workspaceBefore?.sha256
    );
    const searchBefore = full.files.find(
      ({ path }) => path === "home/box/sand-data/search-index.db"
    );
    await writeFile(join(sourceSand, "search-index.db"), "search-after\n");
    const metricsBeforeSandPath = sync.diagnostics();
    const sandPathSnapshot = await sync.snapshotOut({ sandPaths: ["search-index.db"] });
    expect(
      sync.diagnostics().sourceFilesInspected - metricsBeforeSandPath.sourceFilesInspected
    ).toBe(1);
    expect(
      sandPathSnapshot.files.find(({ path }) => path === "home/box/sand-data/search-index.db")
        ?.sha256
    ).not.toBe(searchBefore?.sha256);
    await rm(join(agentOne, "profile.json"));
    const deleted = await sync.snapshotOut({ agentIds: ["one"] });
    expect(deleted.files.some(({ path }) => path.endsWith("/one/profile.json"))).toBeFalse();
    expect(deleted.tombstones).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "home/box/sand-data/agents/one/profile.json" }),
      ])
    );
    expect(deleted.files.some(({ path }) => path.endsWith("/two/profile.json"))).toBeTrue();
  });

  test("snapshotting an unstarted agent store does not create WAL sidecars", async () => {
    root = await mkdtemp(join(tmpdir(), "openteam-box-store-unstarted-"));
    const sourceHome = join(root, "source-home");
    const sourceSand = join(sourceHome, "sand-data");
    const sourceWorkspace = join(root, "source-workspace");
    await Promise.all([
      mkdir(join(sourceHome, ".pi", "agent"), { recursive: true }),
      mkdir(sourceWorkspace, { recursive: true }),
    ]);
    const stores = new BotAgentStore(sourceSand, join(root, "orphans"));
    await stores.initializeAgent("probe");
    const directory = stores.agentDirectory("probe");
    expect(await readdir(directory)).toEqual(["store.db"]);

    const sync = new BoxStoreSync({
      storeRoot: join(root, "replica"),
      home: sourceHome,
      sandRoot: sourceSand,
      workspaceRoot: sourceWorkspace,
    });
    await sync.snapshotOut();
    expect(await readdir(directory)).toEqual(["store.db"]);
  });

  test("snapshots WAL databases with VACUUM and hydrates by hash without pruning extras", async () => {
    root = await mkdtemp(join(tmpdir(), "openteam-box-store-"));
    const sourceHome = join(root, "source-home");
    const sourceSand = join(sourceHome, "sand-data");
    const sourceWorkspace = join(root, "source-workspace");
    const replica = join(root, "replica");
    await Promise.all([
      mkdir(join(sourceSand, "agents", "probe"), { recursive: true }),
      mkdir(join(sourceHome, ".pi", "agent"), { recursive: true }),
      mkdir(sourceWorkspace, { recursive: true }),
    ]);
    await writeFile(join(sourceSand, "agents", "probe", "profile.json"), "source-profile\n");
    await writeFile(join(sourceWorkspace, "workspace.txt"), "workspace-source\n");

    const databasePath = join(sourceSand, "agents", "probe", "store.db");
    const database = new Database(databasePath, { create: true });
    database.exec("PRAGMA journal_mode=WAL; CREATE TABLE values_table(value TEXT) STRICT");
    database.query("INSERT INTO values_table(value) VALUES (?)").run("wal-visible");

    const source = new BoxStoreSync({
      storeRoot: replica,
      home: sourceHome,
      sandRoot: sourceSand,
      workspaceRoot: sourceWorkspace,
    });
    const manifest = await source.snapshotOut();
    expect(manifest.revision).toBe(1);
    expect(manifest.files.some(({ path }) => path.endsWith("store.db-wal"))).toBeFalse();
    const storeEntry = manifest.files.find(({ path }) => path.endsWith("/store.db"));
    expect(storeEntry).toBeDefined();
    const metricsAfterFirst = source.diagnostics();
    const unchanged = await source.snapshotOut();
    const metricsAfterUnchanged = source.diagnostics();
    expect(unchanged.revision).toBe(2);
    expect(metricsAfterUnchanged.sourceFilesRead).toBe(metricsAfterFirst.sourceFilesRead);
    expect(metricsAfterUnchanged.contentHashes).toBe(metricsAfterFirst.contentHashes);
    expect(metricsAfterUnchanged.sqliteVacuums).toBe(metricsAfterFirst.sqliteVacuums);
    expect(metricsAfterUnchanged.signatureReuses - metricsAfterFirst.signatureReuses).toBe(
      manifest.files.length
    );
    const restartedSource = new BoxStoreSync({
      storeRoot: replica,
      home: sourceHome,
      sandRoot: sourceSand,
      workspaceRoot: sourceWorkspace,
    });
    await restartedSource.snapshotOut();
    expect(restartedSource.diagnostics()).toMatchObject({
      sourceFilesRead: 0,
      contentHashes: 0,
      sqliteVacuums: 0,
      signatureReuses: manifest.files.length,
    });
    database.query("INSERT INTO values_table(value) VALUES (?)").run("wal-changed");
    const changed = await source.snapshotOut();
    expect(changed.files.find(({ path }) => path.endsWith("/store.db"))?.sha256).not.toBe(
      storeEntry?.sha256
    );
    expect(source.diagnostics().sqliteVacuums).toBe(metricsAfterFirst.sqliteVacuums + 1);
    database.close(false);

    const targetHome = join(root, "target-home");
    const targetSand = join(targetHome, "sand-data");
    const targetWorkspace = join(root, "target-workspace");
    await Promise.all([
      mkdir(join(targetSand, "agents", "probe"), { recursive: true }),
      mkdir(targetWorkspace, { recursive: true }),
    ]);
    await writeFile(join(targetSand, "agents", "probe", "profile.json"), "stale-profile\n");
    await writeFile(join(targetSand, "local-extra.txt"), "keep-local\n");

    const target = new BoxStoreSync({
      storeRoot: replica,
      home: targetHome,
      sandRoot: targetSand,
      workspaceRoot: targetWorkspace,
    });
    expect(await target.copyIn()).toMatchObject({ copied: manifest.files.length, skipped: 0 });
    expect(await readFile(join(targetSand, "agents", "probe", "profile.json"), "utf8")).toBe(
      "source-profile\n"
    );
    expect(await readFile(join(targetSand, "local-extra.txt"), "utf8")).toBe("keep-local\n");

    const restored = new Database(join(targetSand, "agents", "probe", "store.db"), {
      readonly: true,
    });
    try {
      expect(restored.query("SELECT value FROM values_table").get()).toEqual({
        value: "wal-visible",
      });
    } finally {
      restored.close(false);
    }
    expect(await target.copyIn()).toEqual({ copied: 0, skipped: manifest.files.length });
  });

  test("propagates tombstones, recursively repairs transfer temps, and refuses live DB clobbers", async () => {
    root = await mkdtemp(join(tmpdir(), "openteam-box-store-recovery-"));
    const sourceHome = join(root, "source-home");
    const sourceSand = join(sourceHome, "sand-data");
    const sourceWorkspace = join(root, "source-workspace");
    const replica = join(root, "replica");
    const agentDirectory = join(sourceSand, "agents", "probe");
    await Promise.all([
      mkdir(join(sourceHome, ".pi", "agent"), { recursive: true }),
      mkdir(sourceWorkspace, { recursive: true }),
      mkdir(agentDirectory, { recursive: true }),
    ]);
    await writeFile(join(agentDirectory, "profile.json"), "first\n");
    const database = new Database(join(agentDirectory, "store.db"), { create: true });
    database.exec("CREATE TABLE value_table(value TEXT) STRICT");
    database.query("INSERT INTO value_table(value) VALUES (?)").run("source");
    database.close(false);

    const source = new BoxStoreSync({
      storeRoot: replica,
      home: sourceHome,
      sandRoot: sourceSand,
      workspaceRoot: sourceWorkspace,
    });
    await source.snapshotOut();
    await rm(join(agentDirectory, "profile.json"));
    const deletedManifest = await source.snapshotOut();
    expect(
      deletedManifest.tombstones?.some(({ path }) => path.endsWith("/profile.json"))
    ).toBeTrue();

    const targetHome = join(root, "target-home");
    const targetSand = join(targetHome, "sand-data");
    const targetWorkspace = join(root, "target-workspace");
    await Promise.all([
      mkdir(join(targetSand, "agents", "probe", "nested"), { recursive: true }),
      mkdir(targetWorkspace, { recursive: true }),
      mkdir(join(targetHome, ".pi", "agent"), { recursive: true }),
      mkdir(join(targetHome, "unrelated-cache", "deep"), { recursive: true }),
      mkdir(join(targetWorkspace, ".git", "objects"), { recursive: true }),
    ]);
    await writeFile(join(targetSand, "agents", "probe", "profile.json"), "must-delete\n");
    await writeFile(
      join(targetSand, "agents", "probe", "nested", ".box-store-part-leaked"),
      "partial"
    );
    await writeFile(join(replica, ".box-store-part-manifest-leaked"), "partial manifest");
    await writeFile(
      join(targetHome, "unrelated-cache", "deep", ".box-store-part-unrelated"),
      "not a snapshot source"
    );
    await writeFile(
      join(targetWorkspace, ".git", "objects", ".box-store-part-git-cache"),
      "excluded source cache"
    );
    const target = new BoxStoreSync({
      storeRoot: replica,
      home: targetHome,
      sandRoot: targetSand,
      workspaceRoot: targetWorkspace,
    });
    await target.start();
    await target.copyIn();
    await expect(readFile(join(targetSand, "agents", "probe", "profile.json"))).rejects.toThrow();
    await expect(
      readFile(join(targetSand, "agents", "probe", "nested", ".box-store-part-leaked"))
    ).rejects.toThrow();
    await expect(readFile(join(replica, ".box-store-part-manifest-leaked"))).rejects.toThrow();
    expect(
      await readFile(
        join(targetHome, "unrelated-cache", "deep", ".box-store-part-unrelated"),
        "utf8"
      )
    ).toBe("not a snapshot source");
    expect(
      await readFile(join(targetWorkspace, ".git", "objects", ".box-store-part-git-cache"), "utf8")
    ).toBe("excluded source cache");
    expect(target.diagnostics().repairDirectoriesVisited).toBeLessThan(10);

    await writeFile(join(targetSand, "agents", "probe", "store.db"), "different bytes");
    const liveTarget = new BoxStoreSync({
      storeRoot: replica,
      home: targetHome,
      sandRoot: targetSand,
      workspaceRoot: targetWorkspace,
      hasLiveAgentHandle: (id) => id === "probe",
    });
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
    const hash = (manifest: BoxStoreManifest, path: string) =>
      manifest.files.find((file) => file.path === path)?.sha256;
    const saved = async (manifest: BoxStoreManifest, path: string) =>
      (await readFile(join(root!, "store", "blobs", hash(manifest, path)!), "utf8"));
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

    const shortInterval = new BoxStoreSync({
      storeRoot: join(root, "store"),
      home,
      sandRoot,
      workspaceRoot,
      chromeProfileIntervalMs: 1_000,
    });
    await symlink("openteam-1234", join(profile, "SingletonLock"));
    await shortInterval.snapshotOut();
    await writeFile(preferences, "v5");
    expect(await saved(await shortInterval.snapshotOut(), profilePath)).toBe("v4");
    await Bun.sleep(1_100);
    expect(await saved(await shortInterval.snapshotOut(), profilePath)).toBe("v5");
  });

  test("keeps a pending browser request when a periodic full snapshot absorbs it", async () => {
    root = await mkdtemp(join(tmpdir(), "openteam-box-store-chrome-merge-"));
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    class ControlledSync extends BoxStoreSync {
      readonly hints: BoxStoreDirtyHint[] = [];

      override async snapshotOut(
        hint: BoxStoreDirtyHint = { all: true }
      ): Promise<BoxStoreManifest> {
        this.hints.push(hint);
        if (this.hints.length === 1) await firstGate;
        return {
          version: 1,
          revision: this.hints.length,
          generatedAt: new Date(0).toISOString(),
          files: [],
          tombstones: [],
          etag: `run-${this.hints.length}`,
        };
      }
    }
    const sync = new ControlledSync({ storeRoot: join(root, "replica") });
    sync.scheduleSnapshot(0, { workspace: true });
    await Bun.sleep(5);
    sync.scheduleSnapshot(0, { agentIds: ["agent-a"], chrome: true });
    sync.scheduleSnapshot(0, { all: true });
    releaseFirst?.();
    await sync.flushScheduledSnapshots();
    expect(sync.hints).toHaveLength(2);
    expect(sync.hints[1]).toEqual({ all: true, chrome: true });

    sync.scheduleSnapshot(0, { all: true });
    await sync.flushScheduledSnapshots();
    expect(sync.hints[2]).toEqual({ all: true });
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
    const saved = async (manifest: BoxStoreManifest, path: string) =>
      readFile(join(root!, "store", "blobs", manifest.files.find((file) => file.path === path)!.sha256), "utf8");

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

  test("keeps a pending profile request when a periodic full snapshot absorbs it", async () => {
    root = await mkdtemp(join(tmpdir(), "openteam-box-store-profile-merge-"));
    const hints: BoxStoreDirtyHint[] = [];
    class RecordingSync extends BoxStoreSync {
      override async snapshotOut(hint: BoxStoreDirtyHint = { all: true }): Promise<BoxStoreManifest> {
        hints.push(hint);
        return { version: 1, revision: hints.length, generatedAt: new Date(0).toISOString(), files: [], tombstones: [], etag: `run-${hints.length}` };
      }
    }
    const sync = new RecordingSync({ storeRoot: join(root, "replica") });
    sync.scheduleSnapshot(0, { agentIds: ["agent-a"], workspace: true, pi: true, chromeProfiles: ["chrome-profile-2", "../escape"] });
    sync.scheduleSnapshot(0, { all: true });
    await sync.flushScheduledSnapshots();
    expect(hints).toEqual([{ all: true, chromeProfiles: ["chrome-profile-2"] }]);

    // A turn that used no browser asks for none.
    sync.scheduleSnapshot(0, { agentIds: ["agent-a"], workspace: true, pi: true });
    await sync.flushScheduledSnapshots();
    expect(hints[1]?.chrome).toBeFalsy();
    expect(hints[1]?.chromeProfiles).toBeUndefined();
  });
});
