import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoxStoreSync } from "../src/box-store-sync";
import { fileDigest, STREAM_FILE_THRESHOLD } from "../src/box-store/file-stream";

let root: string | undefined;
let database: Database | undefined;
afterEach(async () => {
  database?.close();
  database = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});
const fixture = async () => {
  root = await mkdtemp(join(tmpdir(), "openteam-sqlite-streaming-"));
  const workspaceRoot = join(root, "workspace");
  const storeRoot = join(root, "store");
  await mkdir(workspaceRoot);
  const file = join(workspaceRoot, "store.db");
  const sync = new BoxStoreSync({
    workspaceRoot,
    storeRoot,
    home: join(root, "home"),
    sandRoot: join(root, "sand"),
  });
  return { workspaceRoot, storeRoot, file, sync };
};

for (const wal of [true, false]) {
  test(`large SQLite ${wal ? "WAL" : "unopened"} snapshot preserves data, hash, restore and signature reuse`, async () => {
    const f = await fixture();
    database = new Database(f.file, { create: true });
    database.exec(
      `PRAGMA journal_mode=${wal ? "WAL" : "DELETE"}; PRAGMA wal_autocheckpoint=0; CREATE TABLE payload(id INTEGER PRIMARY KEY, value BLOB);`
    );
    const bytes = Buffer.alloc(1024 * 1024, 0x93);
    database.transaction(() => {
      for (let i = 0; i < 6; i++)
        database!.query("INSERT INTO payload(value) VALUES (?)").run(bytes);
    })();
    if (wal) {
      // Most bytes are only in the WAL: the main file size must not select the buffering path.
      expect((await stat(f.file)).size).toBeLessThan(STREAM_FILE_THRESHOLD);
    } else {
      database.close();
      database = undefined;
    }
    const manifest = await f.sync.snapshotOut();
    const entry = manifest.files.find((file) => file.path === "workspace/store.db")!;
    expect(entry.size).toBeGreaterThan(STREAM_FILE_THRESHOLD);
    expect(entry.sha256).toBe(await fileDigest(join(f.storeRoot, "blobs", entry.sha256)));
    expect(f.sync.diagnostics().sqliteVacuums).toBe(wal ? 1 : 0);
    await f.sync.snapshotOut();
    expect(f.sync.diagnostics().sourceFilesRead).toBe(1);
    expect(
      (await readdir(f.workspaceRoot)).filter((name) => name.startsWith(".box-store-"))
    ).toEqual([]);
    expect(
      (await readdir(join(f.storeRoot, "blobs"))).filter((name) => name.startsWith(".box-store-"))
    ).toEqual([]);
    if (!wal) expect(await readdir(f.workspaceRoot)).toEqual(["store.db"]);

    const restoredRoot = join(root!, "restored");
    const restored = new BoxStoreSync({
      workspaceRoot: restoredRoot,
      storeRoot: f.storeRoot,
      home: join(root!, "restore-home"),
      sandRoot: join(root!, "restore-sand"),
    });
    expect(await restored.copyIn()).toEqual({ copied: 1, skipped: 0 });
    const copy = new Database(join(restoredRoot, "store.db"), { readonly: true });
    try {
      expect(copy.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      const rows = copy.query("SELECT value FROM payload ORDER BY id").all() as {
        value: Uint8Array;
      }[];
      expect(rows).toHaveLength(6);
      for (const row of rows) expect(Buffer.from(row.value)).toEqual(bytes);
    } finally {
      copy.close();
    }
    if (wal) {
      database!
        .query("UPDATE payload SET value=? WHERE id=6")
        .run(Buffer.alloc(bytes.length, 0x24));
      const changed = await f.sync.snapshotOut();
      expect(changed.files.find((file) => file.path === entry.path)?.sha256).not.toBe(entry.sha256);
      expect(f.sync.diagnostics().sqliteVacuums).toBe(2);
    }
  });
}

test("a commit during snapshot copying is picked up by the next scan", async () => {
  const f = await fixture();
  database = new Database(f.file, { create: true });
  database.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE payload(value BLOB); INSERT INTO payload VALUES (zeroblob(6291456));"
  );
  const internal = f.sync as unknown as {
    sqliteSnapshotContent(path: string): Promise<unknown>;
  };
  const readSnapshot = internal.sqliteSnapshotContent.bind(f.sync);
  let changed = false;
  internal.sqliteSnapshotContent = async (path) => {
    const content = await readSnapshot(path);
    if (!changed && path.includes(".box-store-snap-")) {
      changed = true;
      database!.query("INSERT INTO payload(value) VALUES (?)").run("committed during copy");
    }
    return content;
  };
  const first = await f.sync.snapshotOut();
  const second = await f.sync.snapshotOut();
  const previous = first.files.find((entry) => entry.path === "workspace/store.db")!;
  const current = second.files.find((entry) => entry.path === previous.path)!;
  expect(current.sha256).not.toBe(previous.sha256);
  const copy = new Database(join(f.storeRoot, "blobs", current.sha256), { readonly: true });
  try {
    expect(copy.query("SELECT count(*) AS n FROM payload").get()).toEqual({ n: 2 });
    expect(copy.query("SELECT value FROM payload WHERE rowid=2").get()).toEqual({
      value: "committed during copy",
    });
  } finally {
    copy.close();
  }
  const reads = f.sync.diagnostics().sourceFilesRead;
  await f.sync.snapshotOut();
  expect(f.sync.diagnostics().sourceFilesRead).toBe(reads);
});
