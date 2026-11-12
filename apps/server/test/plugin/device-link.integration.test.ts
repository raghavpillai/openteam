import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { Effect } from "effect";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioMcpManager } from "../../../computer/src/mcp-manager";
import { PluginService } from "../../src/services/plugin-service";
import { PluginManagement, pluginDigest } from "../../src/services/plugin/management";
import { parsePluginDefinition } from "@openteam/plugin-sdk";

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
    import { appendFile, readFile } from "node:fs/promises";
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
      if (name === "link_status") value = await readFile(join(process.env.OPENTEAM_PLUGIN_STATE_DIR, "status-override.json"), "utf8")
        .then(text => JSON.parse(text)).catch(() => ({linked:false,linking}));
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
    version: "1.0.0", publisher: "Synthetic test", description: "Synthetic lifecycle fixture",
    category: "Developer Tools", featured: false,
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
  const marker = join(root, "accounts", createHash("sha256").update(id).digest("hex").slice(0, 32), "synthetic-boots");
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

integration.each([true, false])("computer outage recovery through a fresh host resumes persisted state without new approval (still linked: %s)", async stillLinked => {
  const f = await fixture();
  try {
    await f.connect();
    const statusPath = join(f.marker, "../status-override.json");
    await writeFile(statusPath, JSON.stringify({ linked: true }));
    await f.poll();
    expect((await f.row()).status).toBe("ready");
    const starts = f.calls.filter(call => call.tool === "start_link").length;
    await f.manager.closeAll();
    await writeFile(statusPath, JSON.stringify({ linked: stillLinked, linking: false }));
    await f.db.pluginConnection.update({ where: { id: f.id }, data: {
      status: "error", statusMessage: "Local runtime unavailable: The computer is not reachable.",
    } });
    await (f.otherService as any).refreshLocalConnections();
    const after = await f.row();
    expect(after.status).toBe(stillLinked ? "ready" : "needs_auth");
    expect(after.credentials).not.toHaveProperty("deviceLink");
    expect(after.credentials).toHaveProperty("syntheticPrivate", "synthetic-host-private");
    expect(f.calls.filter(call => call.tool === "start_link")).toHaveLength(starts);
    expect((await readFile(f.marker, "utf8")).trim().split("\n")).toHaveLength(2);
  } finally { await f.close(); }
}, 15_000);

integration("compatible updates preserve private state and subsequent removal still deletes it", async () => {
  const f = await fixture();
  try {
    await f.connect();
    const marker = await readFile(f.marker, "utf8");
    const next = parsePluginDefinition({ ...parsePluginDefinition(f.installation.manifest), version: "1.1.0" });
    const management = new PluginManagement(f.db, async () => [next], async () => {}, async () => {},
      async id => f.manager.close(id));
    expect(await Effect.runPromise(management.update(f.pluginKey, pluginDigest(next)))).toMatchObject({ updated: true });
    expect(await readFile(f.marker, "utf8")).toBe(marker);
    expect((await f.row()).connectorKey).toBe("device");
    await Effect.runPromise(f.otherService.removeAccount(f.id));
    await expect(readFile(f.marker, "utf8")).rejects.toThrow("ENOENT");
    } finally {
      await f.close();
    }
  },
  15_000
);

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

integration("rotating challenge and image-free bootstrap survive a fresh host service without restarting approval", async () => {
  const f = await fixture();
  try {
    await f.connect();
    const row = await f.row();
    const credentials = row.credentials as any;
    const sessionId = credentials.deviceLink.sessionId;
    const sessionExpiresAt = Date.now() + 180_000;
    await f.db.pluginConnection.update({ where: { id: f.id }, data: { credentials: {
      ...credentials, deviceLink: { ...credentials.deviceLink, sessionExpiresAt, challengeGeneration: 0 },
    } } });
    const statusPath = join(f.marker, "../status-override.json");
    const qrCodeDataUrl = "data:image/png;base64,cm90YXRlZA==";
    await writeFile(statusPath, JSON.stringify({ linked: false, linking: true, sessionId,
      challenge: { generation: 1, qrCodeDataUrl, expiresAt: Date.now() + 60_000 } }));
    await f.poll();
    let status = await Effect.runPromise(f.service.pollConnectionStatuses([f.id]));
    expect(status.connections[0]!.deviceLink).toMatchObject({ sessionId, qrCodeDataUrl, challengeGeneration: 1, sessionExpiresAt });
    await writeFile(statusPath, JSON.stringify({ linked: false, linking: true, sessionId,
      challenge: { generation: 2, qrCodeDataUrl: null, expiresAt: Date.now() + 60_000 } }));
    await Effect.runPromise(f.otherService.pollDeviceLink(f.id));
    status = await Effect.runPromise(f.otherService.pollConnectionStatuses([f.id]));
    expect(status.connections[0]!.deviceLink).toMatchObject({ sessionId, qrCodeDataUrl: null, challengeGeneration: 2 });
    const stored = await f.row();
    await f.db.pluginConnection.update({ where: { id: f.id }, data: { credentials: {
      ...(stored.credentials as any), deviceLink: { ...(stored.credentials as any).deviceLink, expiresAt: Date.now() - 1 },
    } } });
    await Effect.runPromise(f.otherService.pollDeviceLink(f.id));
    expect((await f.row()).status).toBe("needs_auth");
    expect(f.calls.filter(call => call.tool === "cancel_link")).toHaveLength(0);
    await writeFile(statusPath, JSON.stringify({ linked: true, sessionId }));
    await Effect.runPromise(f.otherService.pollDeviceLink(f.id));
    expect((await f.row()).status).toBe("ready");
    expect((await f.row()).credentials).not.toHaveProperty("deviceLink");
    expect(await readFile(f.marker, "utf8")).toBe("boot\n");
    expect(f.calls.filter(call => call.tool === "start_link")).toHaveLength(1);
  } finally { await f.close(); }
}, 15_000);
