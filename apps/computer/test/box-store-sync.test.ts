import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
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
});
