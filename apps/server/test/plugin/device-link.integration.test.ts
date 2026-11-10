import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { Effect } from "effect";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioMcpManager } from "../../../computer/src/mcp-manager";
import { PluginService } from "../../src/services/plugin-service";

// Opt in to an existing test database. Only uniquely owned rows and a temporary
// MCP state directory are created/deleted; no schema reset or Signal data is used.
const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const integration = test.skipIf(!databaseUrl);
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const observed = <T,>(promise: Promise<T>) => promise.then(value => ({ value }), error => ({ error }));
const barrier = <T,>(promise: Promise<T>) => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Synthetic lifecycle barrier was not reached")), 5_000);
  promise.then(resolve, reject).finally(() => clearTimeout(timer));
});

async function fixture() {
  const db = createPrismaClient(databaseUrl!);
  const root = await mkdtemp(join(tmpdir(), "openteam-device-link-integration-"));
  const manager = new StdioMcpManager(root, 5_000);
  const pluginKey = `synthetic-device-${crypto.randomUUID()}`;
  const sdk = (path: string) => Bun.resolveSync(`@modelcontextprotocol/sdk/${path}`, join(import.meta.dir, "../../../computer"));
  // This process implements only synthetic linking. Each boot writes a marker so
  // tests can distinguish observation from an unintended process/state restart.
  const source = `
    import { Server } from ${JSON.stringify(sdk("server/index.js"))};
    import { StdioServerTransport } from ${JSON.stringify(sdk("server/stdio.js"))};
    import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(sdk("types.js"))};
    import { appendFile } from "node:fs/promises";
    import { join } from "node:path";
    const marker = join(process.env.OPENTEAM_PLUGIN_STATE_DIR, "synthetic-boots");
    await appendFile(marker, "boot\\n");
    let linking = false;
    const server = new Server({name:"synthetic-device-link",version:"1"},{capabilities:{tools:{}}});
    server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:
      ["read_synthetic","link_status","start_link","finish_link","cancel_link","remove_account"]
      .map(name => ({name,inputSchema:{type:"object"}}))}));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      const name = request.params.name;
      let value = {pending:true};
      if (name === "link_status") value = {linked:false,linking};
      if (name === "start_link") {
        linking = true;
        value = {sessionId:crypto.randomUUID(),expiresAt:Date.now()+120000,
          qrCodeDataUrl:"data:image/png;base64,aGVsbG8=",privateToken:"synthetic-provider-private"};
      }
      if (name === "cancel_link" || name === "remove_account") linking = false;
      return {content:[{type:"text",text:JSON.stringify(value)}]};
    });
    await server.connect(new StdioServerTransport());
  `;
  const configuration = { command: process.execPath, args: ["--eval", source] };
  const manifest = {
    key: pluginKey, name: "Synthetic device link", skills: [], components: ["mcp"],
    connections: [{ key: "device", name: "Device", auth: "none", transport: "stdio", tools: [], persistentState: true, configuration,
      deviceLink: { startTool: "start_link", finishTool: "finish_link", statusTool: "link_status",
        cancelTool: "cancel_link", removeTool: "remove_account", instructions: "Synthetic setup only" } }],
  };
  const installation = await db.pluginInstallation.create({ data: {
    pluginKey, name: manifest.name, version: "1.0.0", publisher: "Synthetic test", manifest,
    connections: { create: { connectorKey: "device", name: "Device", transport: "stdio", authType: "none", configuration,
      credentials: { syntheticPrivate: "synthetic-host-private" } } },
  }, include: { connections: true } });
  const id = installation.connections[0]!.id;
  const calls: Array<{ method: string; path: string; generation: number | null; tool?: string }> = [];
  const hooks = {
    beforeDiscover: undefined as undefined | (() => Promise<void>),
    beforeStop: undefined as undefined | (() => Promise<void>),
    beforeForget: undefined as undefined | (() => Promise<void>),
    afterForget: undefined as undefined | (() => Promise<void>),
  };
  const fetchComputer = async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const header = new Headers(init?.headers).get("x-openteam-mcp-generation");
    const generation = header === null ? undefined : Number(header);
    const connectionId = path.split("/")[4]!;
    calls.push({ method, path, generation: generation ?? null, tool: body.toolName });
    try {
      if (path.endsWith("/state")) {
        await hooks.beforeForget?.();
        await manager.forget(connectionId, generation);
        await hooks.afterForget?.();
        return Response.json({ ok: true });
      }
      if (method === "DELETE") {
        await hooks.beforeStop?.();
        await manager.close(connectionId, generation);
        return Response.json({ ok: true });
      }
      if (method === "GET") return Response.json(manager.status(connectionId));
      if (path.endsWith("/discover")) {
        await hooks.beforeDiscover?.();
        return Response.json({ tools: await manager.discover(connectionId, body.configuration, body.runtimeGeneration) });
      }
      return Response.json({ result: await manager.call(connectionId, body.configuration, body.toolName, body.arguments, body.runtimeGeneration) });
    } catch (error) { return Response.json({ error: (error as Error).message }, { status: 503 }); }
  };
  const service = new PluginService(db, fetchComputer);
  const otherService = new PluginService(db, fetchComputer);
  const row = () => db.pluginConnection.findUniqueOrThrow({ where: { id } });
  const marker = join(root, "accounts", createHash("sha256").update(id).digest("hex"), "synthetic-boots");
  const close = async () => {
    await Promise.all([service.close(), otherService.close()]);
    await manager.closeAll();
    const activity = await db.pluginActivity.findMany({ where: { OR: [
      { installationId: installation.id }, { connectionId: id }, { metadata: { path: ["pluginKey"], equals: pluginKey } },
    ] }, select: { id: true } });
    await db.pluginActivity.deleteMany({ where: { id: { in: activity.map(row => row.id) } } });
    await db.event.deleteMany({ where: { entityId: { in: [installation.id, id] } } });
    await db.pluginInstallation.deleteMany({ where: { id: installation.id } });
    await db.$disconnect();
    await rm(root, { recursive: true, force: true });
  };
  return { db, manager, service, otherService, hooks, calls, id, pluginKey, installation, row, marker, close,
    connect: () => Effect.runPromise(service.connect(id)),
    poll: () => Effect.runPromise(service.pollDeviceLink(id)),
  };
}

integration("uninstall fences delayed MCP discovery and every sibling before deleting persistent state", async () => {
  const f = await fixture();
  const entered = deferred<void>(), release = deferred<void>();
  let connecting: ReturnType<typeof observed> | undefined;
  try {
    const sibling = await f.db.pluginConnection.create({ data: { installationId: f.installation.id,
      connectorKey: "device", alias: "sibling", name: "Other device", transport: "stdio", authType: "none", runtimeGeneration: 9 } });
    f.hooks.beforeDiscover = async () => { entered.resolve(); await release.promise; };
    connecting = observed(f.connect());
    await barrier(entered.promise);
    f.hooks.afterForget = async () => {
      expect((await f.db.pluginInstallation.findUniqueOrThrow({ where: { id: f.installation.id } })).status).toBe("error");
      expect((await f.row()).status).toBe("disconnected");
      expect((await f.db.pluginConnection.findUniqueOrThrow({ where: { id: sibling.id } })).runtimeGeneration).toBeGreaterThanOrEqual(10);
      await expect(Effect.runPromise(f.otherService.connect(f.id))).rejects.toThrow("not installed");
    };
    await Effect.runPromise(f.otherService.uninstall(f.pluginKey));
    release.resolve();
    expect(await connecting).toHaveProperty("error");
    expect(f.manager.status(f.id).state).toBe("stopped");
    await expect(readFile(f.marker, "utf8")).rejects.toThrow("ENOENT");
    expect(await f.db.pluginInstallation.findUnique({ where: { id: f.installation.id } })).toBeNull();
    expect(await f.db.pluginConnection.count({ where: { installationId: f.installation.id } })).toBe(0);
  } finally { release.resolve(); await connecting; await f.close(); }
}, 15_000);

integration("public status exposes only the QR projection and interrupted links clear after process restart", async () => {
  const f = await fixture();
  try {
    await f.connect();
    const before = await Effect.runPromise(f.service.pollConnectionStatuses([f.id]));
    expect(before.connections[0]!.deviceLink?.sessionId).toBeString();
    expect(before.connections[0]!.tools.map(tool => tool.name)).toEqual(["read_synthetic"]);
    expect(JSON.stringify(before)).not.toContain("synthetic-host-private");
    expect(JSON.stringify(before)).not.toContain("synthetic-provider-private");
    await f.manager.closeAll();
    await f.poll();
    const after = await Effect.runPromise(f.service.pollConnectionStatuses([f.id]));
    expect(after.connections[0]!.deviceLink).toBeNull();
    expect(after.connections[0]!.status).toBe("needs_auth");
    expect(after.connections[0]!.statusMessage).toContain("interrupted");
    expect(f.calls.filter(call => call.tool === "start_link")).toHaveLength(1);
    await f.connect();
    expect((await Effect.runPromise(f.service.pollConnectionStatuses([f.id]))).connections[0]!.deviceLink?.sessionId)
      .not.toBe(before.connections[0]!.deviceLink?.sessionId);
  } finally { await f.close(); }
}, 15_000);

integration("background polling of an interrupted link leaves a stopped MCP process stopped", async () => {
  const f = await fixture();
  try {
    await f.connect();
    await f.manager.closeAll();
    const before = await readFile(f.marker, "utf8");
    const calls = f.calls.length;
    await (f.service as any).refreshLocalConnections();
    const row = await f.row();
    expect(row.credentials).not.toHaveProperty("deviceLink");
    expect(row.status).toBe("needs_auth");
    expect(row.statusMessage).toContain("Connect again");
    expect(f.calls.slice(calls)).toEqual([
      { method: "GET", path: `/v1/mcp/connections/${f.id}`, generation: null, tool: undefined },
    ]);
    // Checking link status must not launch/download a runtime while waiting for
    // the user to explicitly connect again after a computer/process restart.
    expect(await readFile(f.marker, "utf8")).toBe(before);
    expect(f.manager.status(f.id).state).toBe("stopped");
    await (f.service as any).refreshLocalConnections();
    expect(f.calls).toHaveLength(calls + 1);
    await f.connect();
    expect(await readFile(f.marker, "utf8")).toBe(before + "boot\n");
    expect(f.manager.status(f.id).state).toBe("ready");
  } finally { await f.close(); }
}, 15_000);

integration("account removal rejects another service before RPC while forget acknowledgement is withheld", async () => {
  const f = await fixture();
  const forgotten = deferred<void>(), acknowledge = deferred<void>();
  let removing: ReturnType<typeof observed> | undefined;
  try {
    await f.connect();
    const generation = (await f.row()).runtimeGeneration + 1;
    f.hooks.afterForget = async () => { forgotten.resolve(); await acknowledge.promise; };
    removing = observed(Effect.runPromise(f.service.removeAccount(f.id)));
    await barrier(forgotten.promise);
    const pending = await f.row();
    expect(pending.runtimeGeneration).toBe(generation);
    expect(pending.credentials).toHaveProperty("stateRemovalPending", true);
    expect(pending.credentials).not.toHaveProperty("deviceLink");
    expect(f.manager.status(f.id).state).toBe("stopped");
    await expect(readFile(f.marker, "utf8")).rejects.toThrow("ENOENT");
    let discoveries = 0;
    f.hooks.beforeDiscover = async () => { discoveries++; };
    const calls = f.calls.length;
    await expect(barrier(Effect.runPromise(f.otherService.connect(f.id)))).rejects.toThrow("removal is still pending");
    expect(discoveries).toBe(0);
    expect(f.calls).toHaveLength(calls);
    acknowledge.resolve();
    expect(await removing).toHaveProperty("value");
    expect((await f.row()).status).toBe("disconnected");
    expect((await f.row()).credentials).toEqual({});
    // Capture both process and disk evidence before asserting either invariant.
    const evidence = { state: f.manager.status(f.id).state, boots: await readFile(f.marker, "utf8").catch(() => null),
      generation: (await f.row()).runtimeGeneration, stops: f.calls.filter(call => call.method === "DELETE") };
    expect(evidence).toMatchObject({ state: "stopped", boots: null, generation });
    expect(evidence.stops.map(call => call.generation)).toEqual([generation, generation]);
    expect(f.calls.filter(call => call.tool === "remove_account")).toHaveLength(0);
    await Effect.runPromise(f.otherService.connect(f.id));
    expect(discoveries).toBe(1);
    expect(f.manager.status(f.id).state).toBe("ready");
    expect(await readFile(f.marker, "utf8")).toBe("boot\n");
    expect((await f.row()).runtimeGeneration).toBe(generation);
  } finally { acknowledge.resolve(); await removing; await f.close(); }
}, 15_000);

integration("account removal fences an already-dispatched discovery without recreating deleted state", async () => {
  const f = await fixture();
  const entered = deferred<void>(), release = deferred<void>();
  let connecting: ReturnType<typeof observed> | undefined;
  try {
    f.hooks.beforeDiscover = async () => { entered.resolve(); await release.promise; };
    connecting = observed(f.connect());
    await barrier(entered.promise);
    await expect(Effect.runPromise(f.otherService.removeAccount(f.id))).resolves.toEqual({ removed: true, reset: true });
    release.resolve();
    expect(await connecting).toHaveProperty("error");
    const row = await f.row();
    expect(row.runtimeGeneration).toBe(1);
    expect(row.status).toBe("disconnected");
    expect(row.credentials).toEqual({});
    expect(f.manager.status(f.id).state).toBe("stopped");
    await expect(readFile(f.marker, "utf8")).rejects.toThrow("ENOENT");
    f.hooks.beforeDiscover = undefined;
    await f.connect();
    expect(f.manager.status(f.id).state).toBe("ready");
    expect(await readFile(f.marker, "utf8")).toBe("boot\n");
    expect((await f.row()).runtimeGeneration).toBe(1);
  } finally { release.resolve(); await connecting; await f.close(); }
}, 15_000);

for (const failure of ["stop", "forget"] as const) {
  integration(`failed account ${failure} keeps the database gate across services until removal is retried`, async () => {
    const f = await fixture();
    try {
      await f.connect();
      const fail = async () => { throw new Error("Synthetic cleanup refusal"); };
      if (failure === "stop") f.hooks.beforeStop = fail;
      else f.hooks.beforeForget = fail;
      await expect(Effect.runPromise(f.service.removeAccount(f.id))).rejects.toThrow(
        failure === "stop" ? "runtime stopped" : "state could not be removed"
      );
      const pending = await f.row();
      expect(pending.runtimeGeneration).toBe(1);
      expect(pending.credentials).toHaveProperty("stateRemovalPending", true);
      expect(pending.credentials).not.toHaveProperty("deviceLink");
      expect(await readFile(f.marker, "utf8")).toBe("boot\n");
      if (failure === "stop") expect(f.calls.filter(call => call.path.endsWith("/state"))).toHaveLength(0);
      const calls = f.calls.length;
      await expect(Effect.runPromise(f.otherService.connect(f.id))).rejects.toThrow("removal is still pending");
      expect(f.calls).toHaveLength(calls);
      f.hooks.beforeStop = undefined;
      f.hooks.beforeForget = undefined;
      await expect(Effect.runPromise(f.otherService.removeAccount(f.id))).resolves.toEqual({ removed: true, reset: true });
      expect((await f.row()).credentials).toEqual({});
      expect((await f.row()).runtimeGeneration).toBe(2);
      expect(f.manager.status(f.id).state).toBe("stopped");
      await expect(readFile(f.marker, "utf8")).rejects.toThrow("ENOENT");
      expect(f.calls.filter(call => call.path.endsWith("/state")).at(-1)?.generation).toBe(2);
      expect(f.calls.filter(call => call.tool === "remove_account")).toHaveLength(0);
      await f.connect();
      expect(f.manager.status(f.id).state).toBe("ready");
      expect(await readFile(f.marker, "utf8")).toBe("boot\n");
    } finally { await f.close(); }
  }, 15_000);
}

integration("failed uninstall cleanup does not expose an interrupted QR through public status", async () => {
  const f = await fixture();
  try {
    await f.connect();
    f.hooks.beforeForget = async () => { throw new Error("Synthetic cleanup refusal"); };
    await expect(Effect.runPromise(f.service.uninstall(f.pluginKey))).rejects.toThrow("state could not be removed");
    expect((await f.db.pluginInstallation.findUniqueOrThrow({ where: { id: f.installation.id } })).status).toBe("error");
    const status = await Effect.runPromise(f.service.pollConnectionStatuses([f.id]));
    expect(status.connections[0]!.status).toBe("disconnected");
    const credentials = (await f.row()).credentials;
    f.hooks.beforeForget = undefined;
    await Effect.runPromise(f.service.uninstall(f.pluginKey));
    expect(await f.db.pluginInstallation.findUnique({ where: { id: f.installation.id } })).toBeNull();
    expect(status.connections[0]!.deviceLink).toBeNull();
    expect(credentials).not.toHaveProperty("deviceLink");
  } finally { await f.close(); }
}, 15_000);
