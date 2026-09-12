import { expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

test("development supervisor builds, reloads every entry and lazy chunk, and shuts down", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-dev-electron-"));
  const desktop = join(root, "desktop");
  const logPath = join(root, "supervisor.log");
  const log = await open(logPath, "w");
  const eventsPath = join(root, "electron-pids");
  let electronPids: number[] = [];
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let output = "";
  const put = async (path: string, contents: string) => {
    const target = join(desktop, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  };
  const until = async (check: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      output = await readFile(logPath, "utf8");
      electronPids = (await readFile(eventsPath, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(Number);
      if (await check()) return;
      if (child?.exitCode !== null) throw new Error(`Supervisor exited early: ${output}`);
      await Bun.sleep(25);
    }
    throw new Error(`Supervisor timed out: ${output}`);
  };
  const starts = () => electronPids.length;
  const bundleContains = async (path: string, text: string) =>
    (await readFile(join(desktop, "dist-electron", path), "utf8").catch(() => "")).includes(text);

  try {
    await put("package.json", '{"type":"module"}');
    await mkdir(join(desktop, "scripts"));
    await mkdir(join(desktop, "dist-electron"));
    for (const name of ["dev-electron.ts", "dev-electron-utils.ts"]) {
      await copyFile(
        new URL(`../scripts/${name}`, import.meta.url),
        join(desktop, "scripts", name)
      );
    }
    // Only the native window and Vite readiness are stubbed; builds, filesystem
    // notifications, process restarts and signal cleanup use the real supervisor.
    await put("node_modules/wait-on/index.js", "module.exports = async () => {};");
    await put(
      "node_modules/wait-on/package.json",
      '{"name":"wait-on","main":"index.js","type":"commonjs"}'
    );
    await put(
      "node_modules/electron/index.js",
      'module.exports = require("node:path").join(__dirname, "fake-electron");'
    );
    await put(
      "node_modules/electron/package.json",
      '{"name":"electron","main":"index.js","type":"commonjs"}'
    );
    await put(
      "node_modules/electron/fake-electron",
      `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(eventsPath)}, process.pid + "\\n");\nsetInterval(() => {}, 1000);\n`
    );
    await chmod(join(desktop, "node_modules/electron/fake-electron"), 0o755);
    await put("src/main/index.ts", 'console.log("initial main");');
    await put("src/main/host/utility.ts", 'console.log("initial utility");');
    await put("src/preload/index.ts", 'console.log("initial preload");');
    await put("../cli/src/main.ts", 'console.log("initial updater");');

    child = Bun.spawn([process.execPath, "scripts/dev-electron.ts"], {
      cwd: desktop,
      stdin: "ignore",
      stdout: log.fd,
      stderr: log.fd,
    });
    await until(() => starts() === 1);
    expect(await bundleContains("openteam-cli.js", "initial updater")).toBe(true);

    for (const [source, artifact, marker] of [
      ["../cli/src/main.ts", "openteam-cli.js", "updated updater"],
      ["src/main/host/utility.ts", "host-utility.js", "updated utility"],
      ["src/preload/index.ts", "preload.cjs", "updated preload"],
    ]) {
      const before = starts();
      await put(source!, `console.log(${JSON.stringify(marker)});`);
      await until(async () => starts() > before && (await bundleContains(artifact!, marker!)));
    }

    await put("src/main/lazy.ts", 'export const value = "initial lazy";');
    let before = starts();
    await put("src/main/index.ts", 'void import("./lazy").then(console.log);');
    await until(
      async () => starts() > before && (await bundleContains("chunks/lazy.js", "initial lazy"))
    );
    before = starts();
    await put("src/main/lazy.ts", 'export const value = "updated lazy";');
    await until(
      async () => starts() > before && (await bundleContains("chunks/lazy.js", "updated lazy"))
    );

    child.kill("SIGTERM");
    expect(await Promise.race([child.exited, Bun.sleep(5_000).then(() => "timeout")])).toBe(0);
    for (const pid of electronPids) expect(() => process.kill(pid, 0)).toThrow();
    const finalMain = await readFile(join(desktop, "dist-electron/main.js"), "utf8");
    await put("src/main/index.ts", 'console.log("must not rebuild after shutdown");');
    await Bun.sleep(150);
    expect(await readFile(join(desktop, "dist-electron/main.js"), "utf8")).toBe(finalMain);
  } finally {
    if (child?.exitCode === null) {
      child.kill("SIGTERM");
      await child.exited;
    }
    await log.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
