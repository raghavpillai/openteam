import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as filesystem from "node:fs/promises";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { StdioMcpManager } from "../../src/mcp-manager";
import { McpRuntimeRouter } from "../../src/mcp-runtime-router";
import type { PluginRuntimeAsset } from "@openteam/plugin-sdk";

const managers: StdioMcpManager[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.closeAll()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const statePath = (root: string, id: string) => join(root, "accounts", createHash("sha256").update(id).digest("hex").slice(0, 32));
const legacyStatePath = (root: string, id: string) => join(root, "accounts", createHash("sha256").update(id).digest("hex"));
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "synthetic-managed-account-")));
  directories.push(root);
  const manager = new StdioMcpManager(root, 5_000);
  managers.push(manager);
  // Local synthetic MCP only, no Signal code, credentials, messages, or network.
  const source = `
    import { Server } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/index.js"))};
    import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
    import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/types.js"))};
    import { readFile, writeFile } from "node:fs/promises";
    import { join } from "node:path";
    const server = new Server({name:"synthetic-state",version:"1"},{capabilities:{tools:{}}});
    server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:"state",description:"Synthetic state",inputSchema:{type:"object"}}]}));
    server.setRequestHandler(CallToolRequestSchema,async request=>{
      const directory=process.env.OPENTEAM_PLUGIN_STATE_DIR;
      const path=join(directory,"synthetic-marker");
      if(request.params.arguments?.marker) await writeFile(path,request.params.arguments.marker,{mode:0o600});
      const marker=await readFile(path,"utf8").catch(()=>null);
      return {content:[{type:"text",text:JSON.stringify({directory,marker,pid:process.pid,runtime:process.env.OPENTEAM_RUNTIME_SYNTHETIC})}]};
    });
    await server.connect(new StdioServerTransport());
  `;
  const input: { command: string; args: string[]; persistentState: boolean; runtimeAssets?: PluginRuntimeAsset[] } =
    { command: process.execPath, args: ["--eval", source], persistentState: true };
  const info = async (id: string, marker?: string, generation = 0) => {
    const result: any = await manager.call(id, input, "state", marker ? { marker } : {}, generation);
    return JSON.parse(result.content[0].text);
  };
  return { root, manager, input, info };
}

test("persistent accounts are private, isolated, survive disconnect/restart, and removal preserves caches", async () => {
  const f = await fixture();
  const first = await f.info("account-a", "synthetic-a");
  const second = await f.info("account-b", "synthetic-b");
  expect(first.directory).toBe(statePath(f.root, "account-a"));
  expect(second.directory).not.toBe(first.directory);
  expect((await stat(first.directory)).mode & 0o777).toBe(0o700);
  await f.manager.close("account-a", 1);
  expect(await readFile(join(first.directory, "synthetic-marker"), "utf8")).toBe("synthetic-a");
  const reconnected = await f.info("account-a", undefined, 1);
  expect(reconnected.marker).toBe("synthetic-a");
  expect(reconnected.pid).not.toBe(first.pid);
  await f.manager.closeAll();
  const restarted = new StdioMcpManager(f.root, 5_000);
  managers.push(restarted);
  const router = new McpRuntimeRouter(restarted);
  const result: any = await router.call("account-a", f.input, "state", {}, 1);
  expect(JSON.parse(result.content[0].text).marker).toBe("synthetic-a");
  const cache = join(f.root, "managed", "synthetic-shared-runtime");
  await mkdir(join(f.root, "managed"), { recursive: true });
  await writeFile(cache, "synthetic-pin");
  await router.forget("account-a", 2);
  expect(await Bun.file(join(first.directory, "synthetic-marker")).exists()).toBe(false);
  expect(await readFile(join(second.directory, "synthetic-marker"), "utf8")).toBe("synthetic-b");
  expect(await readFile(cache, "utf8")).toBe("synthetic-pin");
  await expect(router.discover("account-a", f.input, 1)).rejects.toThrow("stale request");
  await expect(router.forget("account-a", 1)).rejects.toThrow("stale request");
}, 15_000);

test("stale removal cannot delete a newer account generation", async () => {
  const f = await fixture();
  const latest = await f.info("account", "synthetic-new", 3);
  await expect(f.manager.forget("account", 2)).rejects.toThrow("stale request");
  expect(await readFile(join(latest.directory, "synthetic-marker"), "utf8")).toBe("synthetic-new");
  expect(f.manager.status("account").state).toBe("ready");
});

test("an overlapping stale forget failure cannot poison a newer account removal", async () => {
  const f = await fixture();
  const latest = await f.info("account", "synthetic-new", 3);
  const other = await f.info("other", "synthetic-other");
  const stale = f.manager.forget("account", 2);
  const staleResult = stale.then(() => null, error => error);
  const current = f.manager.forget("account", 4);
  expect(await staleResult).toBeInstanceOf(Error);
  expect(String(await staleResult)).toContain("stale request");
  await current;
  await expect(stat(latest.directory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.manager.status("account").state).toBe("stopped");
  expect(await readFile(join(other.directory, "synthetic-marker"), "utf8")).toBe("synthetic-other");
  await expect(f.manager.discover("account", f.input, 3)).rejects.toThrow("stale request");
  expect((await f.info("account", undefined, 4)).marker).toBeNull();
}, 15_000);

test.each([3, 4])("discovery at valid generation %i survives an overlapping rejected stale forget", async (generation) => {
  const f = await fixture();
  const latest = await f.info("account", "synthetic-preserved", 3);
  const stale = f.manager.forget("account", 2).then(() => null, error => error);
  const discovery = f.manager.discover("account", f.input, generation);
  expect(String(await stale)).toContain("stale request");
  expect(await discovery).toHaveLength(1);
  expect(f.manager.status("account").state).toBe("ready");
  expect((await f.info("account", undefined, generation)).marker).toBe("synthetic-preserved");
  expect(await readFile(join(latest.directory, "synthetic-marker"), "utf8")).toBe("synthetic-preserved");
}, 15_000);

test("discovery waiting for removal independently rejects a generation made stale while waiting", async () => {
  const f = await fixture();
  const id = "waiting-discovery";
  await f.info(id, "synthetic-old", 3);
  const directory = statePath(f.root, id);
  const entered = deferred<void>(), released = deferred<void>();
  const originalRm = filesystem.rm;
  const remove = spyOn(filesystem, "rm");
  remove.mockImplementation((async (...args: Parameters<typeof filesystem.rm>) => {
    if (String(args[0]) === directory) {
      entered.resolve();
      await released.promise;
    }
    return Reflect.apply(originalRm, filesystem, args);
  }) as typeof filesystem.rm);
  const forgetting = f.manager.forget(id, 4);
  let discovery: Promise<unknown> | undefined;
  try {
    await entered.promise;
    discovery = f.manager.discover(id, f.input, 4).then(() => null, error => error);
    await f.manager.close(id, 5);
    released.resolve();
    await forgetting;
    expect(String(await discovery)).toContain("stale request");
    expect(f.manager.status(id).state).toBe("stopped");
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await f.info(id, undefined, 5)).marker).toBeNull();
  } finally {
    released.resolve();
    await Promise.allSettled([forgetting, ...(discovery ? [discovery] : [])]);
    remove.mockRestore();
  }
});

test.each(["parent", "account"] as const)("rejects an existing %s state-directory symlink before a child can write outside owned state", async (kind) => {
  const f = await fixture();
  const id = "symlinked-state";
  const outside = join(f.root, "synthetic-outside");
  await mkdir(outside, { mode: 0o755 });
  await writeFile(join(outside, "sentinel"), "synthetic-untouched");
  const parent = join(f.root, "accounts"), directory = statePath(f.root, id);
  if (kind === "account") await mkdir(parent);
  await symlink(outside, kind === "parent" ? parent : directory);
  await expect(f.info(id, "synthetic-escaped-write")).rejects.toThrow(/real directory/);
  expect(f.manager.status(id).state).toBe("error");
  expect(await readdir(outside)).toEqual(["sentinel"]);
  expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("synthetic-untouched");
  expect((await lstat(outside)).mode & 0o777).toBe(0o755);
  if (kind === "parent") await expect(f.manager.forget(id, 1)).rejects.toThrow(/real owned directory/);
  else await f.manager.forget(id, 1);
  expect(await readdir(outside)).toEqual(["sentinel"]);
  expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("synthetic-untouched");
});

test("forget preserves outside account-shaped data when the accounts parent is a symlink", async () => {
  const f = await fixture();
  const id = "outside-account-shaped-data";
  const outside = join(f.root, "synthetic-outside");
  const outsideAccount = statePath(outside, id);
  await mkdir(outsideAccount, { recursive: true });
  const marker = join(outsideAccount, "synthetic-marker");
  await writeFile(marker, "synthetic-untouched");
  await symlink(join(outside, "accounts"), join(f.root, "accounts"));
  // Startup must fail closed, and subsequent removal must also stay confined.
  await expect(f.manager.discover(id, f.input)).rejects.toThrow(/real directory/);
  await f.manager.forget(id, 1).catch(() => {});
  expect(await readFile(marker, "utf8")).toBe("synthetic-untouched");
});

test("repairs permissions of an existing real account state directory before launch", async () => {
  const f = await fixture();
  const directory = statePath(f.root, "existing-state");
  await mkdir(directory, { recursive: true });
  await chmod(directory, 0o755);
  await writeFile(join(directory, "synthetic-marker"), "synthetic-preserved");
  expect((await f.info("existing-state")).marker).toBe("synthetic-preserved");
  expect((await lstat(directory)).mode & 0o777).toBe(0o700);
});

test("legacy account directories migrate together without losing keys/history across restart", async () => {
  const f = await fixture();
  const id = "legacy-migration", legacy = legacyStatePath(f.root, id), current = statePath(f.root, id);
  await mkdir(join(legacy, "wacli"), { recursive: true });
  await writeFile(join(legacy, "synthetic-marker"), "synthetic-history");
  await writeFile(join(legacy, "wacli", "session.db"), "synthetic-keys");
  await chmod(legacy, 0o755);
  const first = await f.info(id);
  expect(first.directory).toBe(current);
  expect(first.marker).toBe("synthetic-history");
  await expect(lstat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(current, "wacli", "session.db"), "utf8")).toBe("synthetic-keys");
  expect((await lstat(current)).mode & 0o777).toBe(0o700);
  await f.manager.closeAll();
  const restarted = new StdioMcpManager(f.root, 5_000);
  managers.push(restarted);
  const result: any = await restarted.call(id, f.input, "state", {});
  expect(JSON.parse(result.content[0].text).marker).toBe("synthetic-history");
  expect(await readFile(join(current, "wacli", "session.db"), "utf8")).toBe("synthetic-keys");
}, 15_000);

test("migration refuses existing legacy/current pairs without merging or replacing either", async () => {
  const f = await fixture();
  const id = "migration-conflict", legacy = legacyStatePath(f.root, id), current = statePath(f.root, id);
  await mkdir(legacy, { recursive: true });
  await mkdir(current);
  await writeFile(join(legacy, "synthetic-marker"), "synthetic-old");
  await writeFile(join(current, "synthetic-marker"), "synthetic-new");
  await expect(f.info(id)).rejects.toThrow("Both legacy and current account state exist");
  expect(await readFile(join(legacy, "synthetic-marker"), "utf8")).toBe("synthetic-old");
  expect(await readFile(join(current, "synthetic-marker"), "utf8")).toBe("synthetic-new");
});

test("legacy state symlinks fail closed and offline removal does not follow their targets", async () => {
  const f = await fixture();
  const id = "legacy-symlink", outside = join(f.root, "outside"), legacy = legacyStatePath(f.root, id);
  await mkdir(outside);
  await mkdir(join(f.root, "accounts"));
  await writeFile(join(outside, "synthetic-marker"), "synthetic-outside");
  await symlink(outside, legacy);
  await expect(f.info(id, "must-not-write")).rejects.toThrow("Legacy account state must be a real directory");
  await f.manager.forget(id, 1);
  await expect(lstat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(outside, "synthetic-marker"), "utf8")).toBe("synthetic-outside");
});

test("offline removal deletes both owned path versions without launching or touching another account", async () => {
  const f = await fixture();
  const id = "offline-legacy", legacy = legacyStatePath(f.root, id), current = statePath(f.root, id);
  const other = legacyStatePath(f.root, "another-account");
  for (const path of [legacy, current, other]) {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "synthetic-marker"), "synthetic-preserved");
  }
  await f.manager.forget(id, 1);
  await expect(lstat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(current)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(other, "synthetic-marker"), "utf8")).toBe("synthetic-preserved");
  expect(f.manager.status(id).state).toBe("stopped");
});

test("production state paths leave room for a real Unix send socket", async () => {
  const manager = new StdioMcpManager("/agent-data/plugin-runtimes");
  const production = (manager as any).accountStateDirectory("synthetic-socket-account");
  const targetBytes = Buffer.byteLength(join(production, ".send.sock"));
  expect(production).toMatch(/^\/agent-data\/plugin-runtimes\/accounts\/[a-f0-9]{32}$/);
  expect(targetBytes).toBe(80);
  expect(Buffer.byteLength(join(production, "wacli", ".send.sock"))).toBeLessThan(108);
  const root = await realpath(await mkdtemp("/tmp/socket-"));
  directories.push(root);
  const directory = join(root, "x".repeat(targetBytes - Buffer.byteLength(root) - 12));
  await mkdir(directory);
  const socket = join(directory, ".send.sock");
  expect(Buffer.byteLength(socket)).toBe(targetBytes);
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, () => resolve());
    });
    expect((await lstat(socket)).isSocket()).toBe(true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test.each(["close", "closeAll", "forget"] as const)("%s joins pending state-directory creation before completing teardown", async (operation) => {
  const f = await fixture();
  const id = "paused-state-creation";
  const directory = statePath(f.root, id);
  const entered = deferred<void>(), released = deferred<void>();
  const originalMkdir = filesystem.mkdir;
  const mkdir = spyOn(filesystem, "mkdir");
  mkdir.mockImplementation((async (...args: Parameters<typeof filesystem.mkdir>) => {
    if (String(args[0]) === directory) {
      entered.resolve();
      await released.promise;
    }
    return Reflect.apply(originalMkdir, filesystem, args);
  }) as typeof filesystem.mkdir);
  const starting = f.manager.discover(id, f.input, 0).then(() => null, error => error);
  let teardown: Promise<void> | undefined;
  try {
    await entered.promise;
    let completed = false;
    teardown = (operation === "closeAll" ? f.manager.closeAll() : f.manager[operation](id, 1))
      .then(() => { completed = true; });
    // Cross a turn with mkdir still paused so premature teardown can be observed.
    await Bun.sleep(20);
    expect(completed).toBe(false);
    expect(f.manager.status(id).state).toBe("stopped");
    // Release only after asserting teardown is pending; awaiting it first deadlocks.
    released.resolve();
    await teardown;
    expect(await starting).toBeInstanceOf(Error);
    if (operation === "forget") {
      await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect((await stat(directory)).isDirectory()).toBe(true);
      await expect(stat(join(directory, "synthetic-marker"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(f.manager.status(id).state).toBe("stopped");
  } finally {
    released.resolve();
    await Promise.allSettled([starting, ...(teardown ? [teardown] : [])]);
    mkdir.mockRestore();
  }
});

test("forget during package preparation prevents the cancelled start from recreating account state", async () => {
  const f = await fixture();
  const entered = deferred<void>(), released = deferred<unknown>();
  const packages = (f.manager as any).packages;
  packages.resolve = async () => { entered.resolve(); return released.promise; };
  const starting = f.manager.discover("cancelled-account", f.input, 0).then(() => null, error => error);
  await entered.promise;
  await f.manager.forget("cancelled-account", 1);
  released.resolve(f.input);
  expect(await starting).toBeInstanceOf(Error);
  expect(await stat(statePath(f.root, "cancelled-account")).then(() => true, () => false)).toBe(false);
  expect(f.manager.status("cancelled-account").state).toBe("stopped");
});

const payload = Buffer.from("synthetic-pinned-runtime");
const asset: PluginRuntimeAsset = {
  name: "SYNTHETIC",
  sources: { [`${process.platform}-${process.arch}`]: {
    url: "https://synthetic.invalid/runtime", sha256: createHash("sha256").update(payload).digest("hex"),
    bytes: payload.length, maxExtractedBytes: payload.length, format: "file", path: "bin/synthetic",
  } },
};

test("managed runtime pins are shared across accounts; state removal preserves them and corrupt entry points fail closed", async () => {
  const f = await fixture();
  f.input.runtimeAssets = [asset];
  let downloads = 0;
  (f.manager as any).runtimes.download = async () => { downloads++; return new Response(payload); };
  const first = await f.info("one", "synthetic-one");
  const second = await f.info("two", "synthetic-two");
  expect(first.runtime).toBe(second.runtime);
  expect(await readFile(first.runtime, "utf8")).toBe(payload.toString());
  expect(downloads).toBe(1);
  await f.manager.forget("one", 1);
  expect(await readFile(second.runtime, "utf8")).toBe(payload.toString());
  await writeFile(second.runtime, "synthetic-corruption");
  await expect(f.manager.discover("three", f.input)).rejects.toThrow("verification failed");
  expect(downloads).toBe(1);
}, 15_000);

test("cancelling one account's shared managed-runtime download leaves the other account's startup alive", async () => {
  const f = await fixture();
  f.input.runtimeAssets = [asset];
  const entered = deferred<void>(), download = deferred<Response>();
  let signal: AbortSignal | undefined;
  let downloads = 0;
  (f.manager as any).runtimes.download = async (_url: unknown, options: RequestInit) => {
    downloads++; signal = options.signal as AbortSignal; entered.resolve(); return download.promise;
  };
  const first = f.manager.discover("one", f.input).then(() => null, error => error);
  const second = f.manager.discover("two", f.input);
  await entered.promise;
  const pending = () => [...(f.manager as any).runtimes.pending.values()][0] as { users: number };
  for (let index = 0; index < 100 && pending()?.users !== 2; index++) await Bun.sleep(1);
  expect(pending().users).toBe(2);
  await f.manager.close("one", 1);
  expect(signal?.aborted).toBe(false);
  download.resolve(new Response(payload));
  expect(await first).toBeInstanceOf(Error);
  expect(await second).toHaveLength(1);
  expect(f.manager.status("two").state).toBe("ready");
  expect(downloads).toBe(1);
}, 15_000);


test("managed runtimes accept a cache directory with a symlink ancestor (including macOS /var)", async () => {
  const f = await fixture();
  const physical = join(f.root, "physical"), alias = join(f.root, "cache-alias");
  await mkdir(physical);
  await symlink(physical, alias);
  const manager = new StdioMcpManager(alias, 5_000);
  managers.push(manager);
  (manager as any).runtimes.download = async () => new Response(payload);
  f.input.runtimeAssets = [asset];
  expect(await manager.discover("synthetic", f.input)).toHaveLength(1);
}, 15_000);
