import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoxStoreSync } from "../src/box-store-sync";
import { fileDigest, stageFile } from "../src/box-store/file-stream";

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });
const fixture = async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "openteam-streamed-store-")));
  const options = { home: join(root, "home"), sandRoot: join(root, "sand"), workspaceRoot: join(root, "workspace"), storeRoot: join(root, "store") };
  await mkdir(options.workspaceRoot, { recursive: true });
  return { ...options, file: join(options.workspaceRoot, "large.bin"), sync: new BoxStoreSync(options) };
};

test("large snapshots and restores preserve bytes, modes and unchanged-file reuse", async () => {
  const f = await fixture();
  const bytes = Buffer.alloc(5 * 1024 * 1024 + 17, 0xa5);
  bytes[bytes.length - 1] = 0xff;
  await writeFile(f.file, bytes); await chmod(f.file, 0o750);
  const manifest = await f.sync.snapshotOut();
  const entry = manifest.files.find((file) => file.path === "workspace/large.bin")!;
  expect(entry.size).toBe(bytes.length);
  expect(entry.sha256).toBe(await fileDigest(f.file));
  expect(entry.mode).toBe(0o750);
  await f.sync.snapshotOut();
  expect(f.sync.diagnostics().sourceFilesRead).toBe(1);
  await rm(f.file);
  expect(await f.sync.copyIn()).toEqual({ copied: 1, skipped: 0 });
  expect(await readFile(f.file)).toEqual(bytes);
  expect((await stat(f.file)).mode & 0o777).toBe(0o750);
  expect(await f.sync.copyIn()).toEqual({ copied: 0, skipped: 1 });
});

test("corrupt large blobs never replace a destination or leave a staged file", async () => {
  const f = await fixture();
  await writeFile(f.file, Buffer.alloc(5 * 1024 * 1024, 0x11));
  const manifest = await f.sync.snapshotOut();
  const entry = manifest.files.find((file) => file.path === "workspace/large.bin")!;
  await writeFile(join(f.storeRoot, "blobs", entry.sha256), Buffer.alloc(5 * 1024 * 1024, 0x22));
  await writeFile(f.file, "keep this destination");
  await expect(f.sync.copyIn()).rejects.toThrow("box-store blob failed hash");
  expect(await readFile(f.file, "utf8")).toBe("keep this destination");
  expect((await readdir(f.workspaceRoot)).filter((name) => name.startsWith(".box-store-part-"))).toEqual([]);
});

test("staging an unreadable source cleans temporary files", async () => {
  const f = await fixture();
  await expect(stageFile(join(root!, "missing"), f.workspaceRoot)).rejects.toThrow();
  expect(await readdir(f.workspaceRoot)).toEqual([]);
});
