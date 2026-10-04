import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioMcpManager } from "../../src/mcp-manager";

const directory = await mkdtemp(join(tmpdir(), "mcp-stress-"));
const fixture = join(import.meta.dir, "gated-mcp.mjs");
const manager = new StdioMcpManager(directory, 5_000);
const config = { command: "node", args: [fixture, directory] };
const lines = async (name = "starts") =>
  (await readFile(join(directory, name), "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 8_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "condition timed out");
    await Bun.sleep(10);
  }
}
const passed: string[] = [];
async function scenario(name: string, run: () => Promise<void>) {
  try { await run(); passed.push(name); }
  catch (error) { throw new Error(`Stress scenario failed: ${name}`, { cause: error }); }
  finally { await manager.closeAll(); }
}
try {
  await scenario("500 overlapping discoveries/calls and 10,000 passive probes", async () => {
    const before = (await lines()).length;
    const pending = Array.from({ length: 500 }, (_, i) => i % 2
      ? manager.discover("burst", config)
      : manager.call("burst", config, "pid", {}));
    await waitFor(async () => (await lines()).length === before + 1);
    for (let i = 0; i < 10_000; i++) assert.equal(manager.status("burst").state, "starting");
    await writeFile(join(directory, "approved"), "yes");
    await Promise.all(pending);
    assert.equal((await lines()).length, before + 1);
    assert.equal(manager.status("burst").state, "ready");
  });
  await scenario("16 independent connectors each receive 40 simultaneous requests", async () => {
    const before = (await lines()).length;
    await Promise.all(Array.from({ length: 16 }, (_, id) =>
      Promise.all(Array.from({ length: 40 }, () => manager.discover(`parallel-${id}`, config)))));
    assert.equal((await lines()).length, before + 16);
    assert.ok(Array.from({ length: 16 }, (_, id) => manager.status(`parallel-${id}`).state).every(s => s === "ready"));
  });
  await scenario("a child crashing before initialization cannot cause a retry storm", async () => {
    const before = (await lines()).length;
    const broken = { ...config, env: { MCP_FIXTURE_EXIT_BEFORE_INIT: "yes" } };
    const results = await Promise.allSettled(Array.from({ length: 200 }, () => manager.discover("crash", broken)));
    assert.ok(results.every(result => result.status === "rejected"));
    for (let i = 0; i < 1_000; i++) {
      assert.equal(manager.status("crash").state, "error");
      await assert.rejects(manager.discover("crash", broken), /Reconnect/);
    }
    assert.equal((await lines()).length, before + 1);
  });
  await scenario("cancel while tools/list is blocked; explicit retry gets a fresh process", async () => {
    const before = (await lines()).length;
    const stalled = { ...config, env: { MCP_FIXTURE_WAIT_FOR_LIST: "yes" } };
    const listBefore = (await lines("lists")).length;
    const pending = Promise.allSettled(Array.from({ length: 100 }, () => manager.discover("list", stalled)));
    await waitFor(async () => (await lines("lists")).length > listBefore);
    await manager.close("list");
    assert.ok((await pending).every(result => result.status === "rejected"));
    assert.equal(manager.status("list").state, "stopped");
    await writeFile(join(directory, "listed"), "yes");
    await manager.discover("list", stalled);
    assert.equal((await lines()).length, before + 2);
  });
  await scenario("20 rapid cancel/reconnect cycles leave no live child behind", async () => {
    await rm(join(directory, "approved"));
    const allPids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const before = (await lines()).length;
      const pending = Promise.allSettled(Array.from({ length: 50 }, () => manager.discover("cancel", config)));
      await waitFor(async () => (await lines()).length === before + 1);
      allPids.push((await lines()).at(-1)!);
      await Promise.all(Array.from({ length: 10 }, () => manager.close("cancel")));
      assert.ok((await pending).every(result => result.status === "rejected"));
      assert.equal(manager.status("cancel").state, "stopped");
    }
    for (const pid of allPids) assert.throws(() => process.kill(Number(pid), 0), { code: "ESRCH" });
    await writeFile(join(directory, "approved"), "yes");
  });
  await scenario("server notifications update cached tools without replacing the process", async () => {
    const before = (await lines()).length;
    await manager.discover("notify", config);
    await manager.call("notify", config, "pid", { changeTools: true });
    await waitFor(() => (manager.status("notify").tools[0] as { name: string })?.name === "updated");
    assert.equal((await lines()).length, before + 1);
  });
  await scenario("token rotation cannot interrupt consent; 200 requests replace a ready child once", async () => {
    await rm(join(directory, "approved"));
    const before = (await lines()).length;
    const original = { ...config, env: { ACCESS_TOKEN: "old-token" } };
    const rotated = { ...config, env: { ACCESS_TOKEN: "new-token" } };
    const pending = manager.discover("tokens", original);
    await waitFor(async () => (await lines()).length === before + 1);
    const attempts = await Promise.allSettled(Array.from({ length: 200 }, () => manager.discover("tokens", rotated)));
    assert.ok(attempts.every(result => result.status === "rejected"));
    assert.equal(manager.status("tokens").state, "starting");
    assert.equal((await lines()).length, before + 1);
    await writeFile(join(directory, "approved"), "yes");
    await pending;
    await Promise.all(Array.from({ length: 200 }, () => manager.discover("tokens", rotated)));
    assert.equal((await lines()).length, before + 2);
  });
  await scenario("cancel during package resolution prevents a late child from spawning", async () => {
    const before = (await lines()).length;
    const packages = (manager as unknown as { packages: { resolve(input: unknown): Promise<unknown> } }).packages;
    const original = packages.resolve;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    packages.resolve = async input => { await held; return original.call(packages, input); };
    const pending = Promise.allSettled(Array.from({ length: 100 }, () => manager.discover("package", config)));
    try {
      assert.equal(manager.status("package").state, "starting");
      await manager.close("package");
    } finally {
      packages.resolve = original;
      release();
    }
    assert.ok((await pending).every(result => result.status === "rejected"));
    assert.equal(manager.status("package").state, "stopped");
    assert.equal((await lines()).length, before);
  });
  await scenario("delayed old discovery, tool calls, and DELETE cannot affect a new generation", async () => {
    const before = (await lines()).length;
    await manager.discover("fenced", config, 5);
    await manager.close("fenced", 6);
    await Promise.all(Array.from({ length: 100 }, () => manager.discover("fenced", config, 6)));
    const results = await Promise.allSettled(Array.from({ length: 200 }, (_, i) => i % 2
      ? manager.discover("fenced", config, 5)
      : manager.call("fenced", config, "pid", { exit: true }, 5)));
    assert.ok(results.every(result => result.status === "rejected"));
    await manager.close("fenced", 5);
    assert.equal(manager.status("fenced").state, "ready");
    assert.equal((await lines()).length, before + 2);
    const pid = (await lines()).at(-1)!;
    assert.ok(JSON.stringify(await manager.call("fenced", config, "pid", {}, 6)).includes(pid));
    const call = manager.call("fenced", config, "pid", { exit: true }, 6);
    const discovery = manager.discover("fenced", config, 6);
    const stopping = manager.close("fenced", 7);
    await assert.rejects(call, /stale request/);
    await assert.rejects(discovery, /stale request/);
    await stopping;
    assert.equal(manager.status("fenced").state, "stopped");
    for (const generation of [-1, NaN, 1.5, Infinity]) await assert.rejects(manager.discover("invalid", config, generation), /Invalid/);
    assert.equal(manager.status("invalid").state, "stopped");
  });
  await scenario("same configuration with reordered JSON keys reuses the current process", async () => {
    const before = (await lines()).length;
    const original = { ...config, env: { FIRST: "one", SECOND: "two" } };
    await manager.discover("order", original);
    const reordered = { env: { SECOND: "two", FIRST: "one" }, args: config.args, command: config.command };
    await manager.discover("order", reordered);
    assert.equal((await lines()).length, before + 1);
  });
  console.log(JSON.stringify({ passed, childProcessesStarted: (await lines()).length }));
} finally {
  await manager.closeAll();
  await rm(directory, { recursive: true, force: true });
}
