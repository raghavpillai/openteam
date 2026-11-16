import { expect, spyOn, test } from "bun:test";
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
        resolve(import.meta.dirname, "../src/browser-network-worker.ts"),
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
  const logs: string[] = [];
  const logger = spyOn(console, "warn").mockImplementation((line) => { logs.push(String(line)); });
  try {
    const modulePath = join(directory, "supervisor.mjs");
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dirname, "../src/browser-network.ts")],
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
        if (!configured) {
          configured = true;
          console.log(JSON.stringify({diagnostic:{event:'computer_network.proxy_socket_error',side:'upstream',code:'ECONNRESET',address:'44.209.157.185',port:443,message:'fixture-never-print',headers:{authorization:'fixture-never-print'}}}));
          console.log(JSON.stringify({diagnostic:{event:'fixture-never-print',code:'fixture-never-print'}}));
          // A pipe read may contain many valid lines exceeding the per-line limit in aggregate.
          console.log(Array.from({length:40}, () => JSON.stringify({diagnostic:{event:'proxy_capacity',limit:80,message:'fixture-never-print'.repeat(30)}})).join('\\n'));
          console.log(JSON.stringify({started:true})); return;
        }
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
    expect(logs.map((line) => JSON.parse(line))).toContainEqual(expect.objectContaining({
      event: "computer_network.proxy_socket_error", code: "ECONNRESET", side: "upstream", address: "44.209.157.185", port: 443,
    }));
    expect(logs.join("")).not.toContain("fixture-never-print");
  } finally {
    await network?.close();
    logger.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);

test("chaos: workers that miss their start deadline are restarted one at a time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openteam-network-restarts-"));
  let network:
    | Awaited<ReturnType<typeof import("../src/browser-network").startBrowserNetwork>>
    | undefined;
  const logger = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dirname, "../src/browser-network.ts")],
      target: "bun",
      outdir: directory,
      naming: "supervisor.mjs",
    });
    expect(build.success).toBe(true);
    // The first worker starts and then exits, as on a route change. Every later
    // one is too slow to report ready, as on a starved host.
    await writeFile(
      join(directory, "browser-network-worker.mjs"),
      `
      import { appendFileSync, readFileSync } from 'node:fs';
      const log = new URL('./spawns.log', import.meta.url);
      appendFileSync(log, 'x');
      if (readFileSync(log, 'utf8').length === 1) {
        console.log(JSON.stringify({ started: true }));
        setTimeout(() => process.exit(0), 100);
      } else setInterval(() => {}, 1000);
    `
    );
    const { startBrowserNetwork } = await import(join(directory, "supervisor.mjs"));
    network = await startBrowserNetwork("http://127.0.0.1:1", "token", { startMs: 300, retryMs: 50 });
    await Bun.sleep(3000);
    const spawns = (await Bun.file(join(directory, "spawns.log")).text()).length;
    // About one spawn per 350 ms cycle. Duplicated restart chains double every cycle.
    expect(spawns).toBeLessThanOrEqual(12);
    expect(spawns).toBeGreaterThanOrEqual(4);
  } finally {
    await network?.close();
    logger.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);

test("chaos: a first start that misses its deadline on a starved host is retried instead of failing the computer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openteam-network-first-start-"));
  let network:
    | Awaited<ReturnType<typeof import("../src/browser-network").startBrowserNetwork>>
    | undefined;
  const logger = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dirname, "../src/browser-network.ts")],
      target: "bun",
      outdir: directory,
      naming: "supervisor.mjs",
    });
    expect(build.success).toBe(true);
    // The first two workers are too slow to report ready; the third starts.
    await writeFile(
      join(directory, "browser-network-worker.mjs"),
      `
      import { appendFileSync, readFileSync } from 'node:fs';
      const log = new URL('./spawns.log', import.meta.url);
      appendFileSync(log, 'x');
      if (readFileSync(log, 'utf8').length >= 3) console.log(JSON.stringify({ started: true }));
      setInterval(() => {}, 1000);
    `
    );
    const { startBrowserNetwork } = await import(join(directory, "supervisor.mjs"));
    network = await startBrowserNetwork("http://127.0.0.1:1", "token", { startMs: 200, retryMs: 50 });
    const spawns = async () => (await Bun.file(join(directory, "spawns.log")).text()).length;
    expect(await spawns()).toBe(3);
    // The slow attempts leave no restart behind to replace the running worker.
    await Bun.sleep(500);
    expect(await spawns()).toBe(3);
  } finally {
    await network?.close();
    logger.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
