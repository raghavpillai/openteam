import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

test("the Node network worker shuts down when its parent pipe closes and never prints its credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openteam-network-worker-"));
  const output = join(directory, "worker.mjs");
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const build = Bun.spawn(
      [
        process.execPath,
        "build",
        resolve("apps/computer/src/browser-network-worker.ts"),
        "--target",
        "node",
        "--outfile",
        output,
      ],
      { stdout: "ignore", stderr: "inherit" }
    );
    expect(await build.exited).toBe(0);
    child = spawn("node", [output], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk) => (stdout += chunk));
    child.stderr!.resume();
    const exited = new Promise<number | null>((r) => child!.once("exit", r));
    child.stdin!.write(
      JSON.stringify({
        serverUrl: "http://127.0.0.1:1",
        token: "fixture-credential-never-print",
        port: 0,
      }) + "\n"
    );
    for (let i = 0; i < 500 && !stdout.includes('"started":true'); i++) await Bun.sleep(10);
    expect(stdout.includes('"started":true')).toBe(true);
    expect(stdout.includes("fixture-credential-never-print")).toBe(false);
    child.stdin!.end();
    expect(await exited).toBe(0);
  } finally {
    child?.kill();
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);
