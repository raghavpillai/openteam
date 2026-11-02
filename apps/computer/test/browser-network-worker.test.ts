import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    for (let i = 0; i < 30 && !stdout.includes('"ready":false'); i++) await Bun.sleep(10);
    expect(stdout.includes('"ready":false')).toBe(true);
    expect(stdout.includes("fixture-credential-never-print")).toBe(false);
    child.stdin!.end();
    expect(await exited).toBe(0);
  } finally {
    child?.kill();
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);

test("chaos: diagnostic admission uses live worker state rather than its last status snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openteam-network-supervisor-"));
  let network:
    | Awaited<ReturnType<typeof import("../src/browser-network").startBrowserNetwork>>
    | undefined;
  try {
    const modulePath = join(directory, "supervisor.mjs");
    const build = await Bun.build({
      entrypoints: [resolve("apps/computer/src/browser-network.ts")],
      target: "bun",
      outdir: directory,
      naming: "supervisor.mjs",
    });
    expect(build.success).toBe(true);
    await writeFile(
      join(directory, "browser-network-worker.mjs"),
      `
      import { createInterface } from 'node:readline';
      let configured = false;
      createInterface({ input: process.stdin }).on('line', line => {
        if (!configured) { configured = true; console.log(JSON.stringify({started:true})); return; }
        const command = JSON.parse(line);
        console.log(JSON.stringify(command.op === 'egress'
          ? { id: command.id, result: { ip:'203.0.113.7', location:'Fixture', epoch:'current', sourceId:'server', checkedAt:new Date().toISOString() } }
          : { id: command.id, error:true }));
      });
    `
    );
    const { startBrowserNetwork } = await import(modulePath);
    network = await startBrowserNetwork("http://127.0.0.1:1", "fixture-never-print");
    // The worker can already answer, but its periodic snapshot has not arrived.
    expect(network!.status().ready).toBe(false);
    expect(await network!.egress()).toMatchObject({ ip: "203.0.113.7", epoch: "current" });
    await expect(network!.quality()).rejects.toThrow("Could not check");
  } finally {
    await network?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);
