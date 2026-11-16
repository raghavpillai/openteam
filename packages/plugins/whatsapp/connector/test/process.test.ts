import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachmentPath, downloadPath, prepareStore, settings, WacliProcess } from "../process";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "wa-process-")); directories.push(home);
  const media = join(home, "workspace"); await mkdir(media);
  const configuration = settings({ PATH: process.env.PATH, OPENTEAM_PLUGIN_ACCOUNT_ID: "account-a", WHATSAPP_MEDIA_ROOT: media }, home);
  await prepareStore(configuration);
  const executable = join(home, "wacli");
  await writeFile(executable, await readFile(new URL("fixtures/wacli.ts", import.meta.url))); await chmod(executable, 0o700);
  return { home, configuration, process: new WacliProcess(executable, configuration) };
}

test("account stores are stable, isolated, and do not inherit provider secrets", () => {
  const first = settings({ OPENTEAM_PLUGIN_ACCOUNT_ID: "../../first", OTHER_API_KEY: "secret", WACLI_READONLY: "1", WACLI_DEVICE_LABEL: "Other client", WACLI_DEVICE_PLATFORM: "MACOS" }, "/home/box");
  const same = settings({ OPENTEAM_PLUGIN_ACCOUNT_ID: "../../first" }, "/home/box");
  const second = settings({ OPENTEAM_PLUGIN_ACCOUNT_ID: "second" }, "/home/box");
  expect(first.store).toBe(same.store); expect(first.store).not.toBe(second.store);
  expect(first.store).toStartWith("/home/box/.local/share/openteam/whatsapp/");
  expect(first.store).not.toContain("..");
  expect(first.env.OTHER_API_KEY).toBeUndefined(); expect(first.env.WACLI_READONLY).toBeUndefined();
  expect(first.env.WACLI_DEVICE_LABEL).toBe("OpenTeam Plugin");
  expect(first.env.WACLI_DEVICE_PLATFORM).toBeUndefined();
  expect(() => settings({})).toThrow("account ID");
  expect(() => settings({ OPENTEAM_PLUGIN_ACCOUNT_ID: "a", WHATSAPP_MAX_MESSAGES: "0" })).toThrow("storage limit");
});

test("CLI invocations preserve JSON paging and pass query text as literal arguments", async () => {
  const f = await fixture(); const query = "--store /tmp/other $(touch bad) `evil`\nnext";
  const result = await f.process.execute(["messages", "search", "--limit", "20", "--", query], true);
  expect(result.data.page.next_cursor).toBe("next"); expect(result.data.source.scope).toBe("local_archive");
  const args = JSON.parse((await readFile(join(f.configuration.store, "calls"), "utf8")).trim());
  expect(args).toContain("--read-only"); expect(args.at(-1)).toBe(query);
  expect(args[args.indexOf("--store") + 1]).toBe(f.configuration.store);
});

test("subprocess failures and uncertain-send warnings survive without retries", async () => {
  const f = await fixture();
  await writeFile(join(f.configuration.store, "mode"), "error");
  await expect(f.process.execute(["send", "text"])).rejects.toThrow("specific upstream error");
  await writeFile(join(f.configuration.store, "mode"), "store_warning");
  const sent = await f.process.execute(["send", "text"]);
  expect(sent.data.sent).toBe(true); expect(sent.data.store_warning).toBe("local store unavailable");
  expect((await readFile(join(f.configuration.store, "calls"), "utf8")).trim().split("\n")).toHaveLength(2);
});

for (const mode of ["follow", "execute"]) test.skipIf(process.platform !== "linux")(`killing the connector reaps a native ${mode} process that ignores graceful termination`, async () => {
  const f = await fixture();
  await writeFile(join(f.configuration.store, "mode"), "hang");
  const owner = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/process-owner.ts"), f.home, f.process.executable, mode], { stdout: "ignore", stderr: "pipe" });
  let nativePid: number | undefined;
  const running = async (pid: number) => {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
    } catch { return false; }
  };
  try {
    const deadline = Date.now() + 3000;
    while (!nativePid && Date.now() < deadline) {
      const value = await Bun.file(join(f.configuration.store, "native.pid")).text().catch(() => "");
      if (value) nativePid = Number(value);
      else await Bun.sleep(10);
    }
    expect(nativePid).toBeGreaterThan(0);
    owner.kill("SIGKILL"); await owner.exited;
    const stoppedBy = Date.now() + 2000;
    while (await running(nativePid!) && Date.now() < stoppedBy) await Bun.sleep(10);
    expect(await running(nativePid!)).toBe(false);
  } finally {
    owner.kill("SIGKILL"); await owner.exited;
    if (nativePid && await running(nativePid)) process.kill(nativePid, "SIGKILL");
    await f.process.close();
  }
}, 7000);

test("attachments reject traversal, symlink escapes, and session files", async () => {
  const f = await fixture(); const root = f.configuration.mediaRoot;
  await writeFile(join(root, "report.txt"), "intended attachment");
  expect((await attachmentPath(f.configuration, join(root, "report.txt"))).size).toBe(19);
  await writeFile(join(f.configuration.store, "session.db"), "private");
  await symlink(join(f.configuration.store, "session.db"), join(root, "keys.txt"));
  await expect(attachmentPath(f.configuration, join(root, "keys.txt"))).rejects.toThrow("attachment folder");
  const broad = { ...f.configuration, mediaRoot: f.home };
  await expect(attachmentPath(broad, join(f.configuration.store, "session.db"))).rejects.toThrow("session files");
  const output = await downloadPath(f.configuration);
  expect(output).toStartWith(join(await realpath(root), "whatsapp", f.configuration.accountKey));
  await rm(join(root, "whatsapp"), { recursive: true }); await symlink(f.configuration.store, join(root, "whatsapp"));
  await expect(downloadPath(f.configuration)).rejects.toThrow("attachment folder");
});

test("migration rejects active native writer locks and symlinks without moving provider state", async () => {
  const f = await fixture();
  const configuration = settings({ OPENTEAM_PLUGIN_ACCOUNT_ID: "account-a", OPENTEAM_PLUGIN_STATE_DIR: join(f.home, "managed") }, f.home);
  const { open } = await import("node:fs/promises");
  const { dlopen, FFIType } = await import("bun:ffi");
  const native = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
  const lock = await open(join(f.configuration.store, "LOCK"), "a+");
  try {
    expect(native.symbols.flock(lock.fd, 2 | 4)).toBe(0);
    await expect(prepareStore(configuration)).rejects.toThrow("in use");
  } finally { native.symbols.flock(lock.fd, 8); native.close(); await lock.close(); }
  const outside = join(f.home, "other"); await mkdir(outside);
  await symlink(outside, join(f.configuration.store, "media"));
  await expect(prepareStore(configuration)).rejects.toThrow("symlink");
  await rm(join(f.configuration.store, "media"));
  await symlink(outside, configuration.store);
  await expect(prepareStore(configuration)).rejects.toThrow("symlink");
  expect(() => settings({ OPENTEAM_PLUGIN_ACCOUNT_ID: "a", OPENTEAM_PLUGIN_STATE_DIR: "relative" }, f.home)).toThrow("absolute");
});
