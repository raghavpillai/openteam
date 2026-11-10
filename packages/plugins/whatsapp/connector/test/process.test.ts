import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachmentPath, downloadPath, executableBytes, prepareStore, settings, WacliProcess } from "../process";

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
  const first = settings({ OPENTEAM_PLUGIN_ACCOUNT_ID: "../../first", OTHER_API_KEY: "secret", WACLI_READONLY: "1", WACLI_DEVICE_LABEL: "Other client" }, "/home/box");
  const same = settings({ OPENTEAM_PLUGIN_ACCOUNT_ID: "../../first" }, "/home/box");
  const second = settings({ OPENTEAM_PLUGIN_ACCOUNT_ID: "second" }, "/home/box");
  expect(first.store).toBe(same.store); expect(first.store).not.toBe(second.store);
  expect(first.store).toStartWith("/home/box/.local/share/openteam/whatsapp/");
  expect(first.store).not.toContain("..");
  expect(first.env.OTHER_API_KEY).toBeUndefined(); expect(first.env.WACLI_READONLY).toBeUndefined();
  expect(first.env.WACLI_DEVICE_LABEL).toBe("OpenTeam Plugin");
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

test("subprocess output is bounded and timed-out commands are terminated", async () => {
  const f = await fixture(); await writeFile(join(f.configuration.store, "mode"), "large");
  await expect(f.process.execute(["messages", "list"])).rejects.toThrow("too large");
  await writeFile(join(f.configuration.store, "mode"), "hang");
  await expect(f.process.execute(["send", "text"], false, 10)).rejects.toThrow("may have gone through");
}, 6000);

test("long-running events are parsed privately and shutdown reaps the child", async () => {
  const f = await fixture(); const events: string[] = [];
  const running = f.process.follow(["auth"], (event) => events.push(event.event));
  try {
    const deadline = Date.now() + 2000;
    while (!events.length && Date.now() < deadline) await Bun.sleep(10);
    expect(events).toEqual(["qr_code"]);
  } finally { await running.stop(); }
  expect(await running.done).toBe(0);
});

test("connector shutdown terminates a pending one-shot command and prevents new children", async () => {
  const f = await fixture(); await writeFile(join(f.configuration.store, "mode"), "hang");
  const pending = f.process.execute(["send", "text"]);
  const outcome = pending.then(() => null, (error) => error);
  await Bun.sleep(50); await f.process.close();
  expect(await outcome).toBeInstanceOf(Error);
  await expect(f.process.execute(["auth", "status"])).rejects.toThrow("shutting down");
}, 8000);

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

test("both shipped Linux executables verify and unsupported platforms fail clearly", async () => {
  const root = new URL("../../", import.meta.url).pathname;
  for (const arch of ["x64", "arm64"]) {
    const bytes = await executableBytes(root, "linux", arch);
    expect(bytes.subarray(0, 4).toString("hex")).toBe("7f454c46");
  }
  await expect(executableBytes(root, "darwin", "arm64")).rejects.toThrow("Linux computer");
});

test("explicit re-pairing archives only marked-revoked session files and preserves retained history", async () => {
  const f = await fixture(); const store = f.configuration.store;
  await writeFile(join(store, "session.db"), "revoked-session");
  await writeFile(join(store, "wacli.db"), "retained-history");
  await f.process.resetRevokedSession();
  expect(await readFile(join(store, "session.db"), "utf8")).toBe("revoked-session");
  await writeFile(join(store, "SESSION_REVOKED"), "revoked");
  await f.process.resetRevokedSession();
  const backup = (await readdir(store)).find((name) => name.startsWith(".revoked-"))!;
  expect(await readFile(join(store, backup, "session.db"), "utf8")).toBe("revoked-session");
  expect(await readFile(join(store, "wacli.db"), "utf8")).toBe("retained-history");
  expect(await readFile(join(store, "SESSION_REVOKED"), "utf8")).toBe("revoked");
});
