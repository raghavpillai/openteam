import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { BoxStoreSync } from "../src/box-store-sync";
import { GrokAgentStore } from "../src/grok-agent-store";

let root: string | null = null;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

describe("Grok-compatible box-store synchronization", () => {
  test("snapshotting an unstarted agent store does not create WAL sidecars", async () => {
    root = await mkdtemp(join(tmpdir(), "openbot-box-store-unstarted-"));
    const sourceHome = join(root, "source-home");
    const sourceSand = join(sourceHome, "sand-data");
    const sourceWorkspace = join(root, "source-workspace");
    await Promise.all([
      mkdir(join(sourceHome, ".pi", "agent"), { recursive: true }),
      mkdir(sourceWorkspace, { recursive: true }),
    ]);
    const stores = new GrokAgentStore(sourceSand, join(root, "orphans"));
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
    root = await mkdtemp(join(tmpdir(), "openbot-box-store-"));
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
    root = await mkdtemp(join(tmpdir(), "openbot-box-store-recovery-"));
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
    ]);
    await writeFile(join(targetSand, "agents", "probe", "profile.json"), "must-delete\n");
    await writeFile(
      join(targetSand, "agents", "probe", "nested", ".box-store-part-leaked"),
      "partial"
    );
    await writeFile(join(replica, ".box-store-part-manifest-leaked"), "partial manifest");
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
