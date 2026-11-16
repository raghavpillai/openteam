import { afterEach, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@openteam/db";
import { Effect } from "effect";
import { PluginService } from "../../src/services/plugin-service";
import { deviceLinkResult, publicDeviceLink } from "../../src/services/plugin/device-link";

// Synthetic computer + in-memory DB only. No Signal processes, network, or user data.
const services: PluginService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });
const envelope = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const linkTools = ["start_link", "finish_link", "link_status", "cancel_link", "remove_account"];
const rawTool = (name: string, hostOnly = false) => ({
  name, description: `Synthetic ${name}`, inputSchema: { type: "object" },
  ...(hostOnly ? { _meta: { "openteam/hostOnly": true } } : {}),
});
const qr = (sessionId = "synthetic-session") => ({
  sessionId, expiresAt: Date.now() + 120_000, qrCodeDataUrl: "data:image/png;base64,aGVsbG8=",
});

function fixture() {
  const manifest = {
    key: "synthetic-device", name: "Synthetic device", skills: [], components: ["mcp"],
    connections: [{
      key: "device", auth: "none", transport: "stdio", tools: [], persistentState: true,
      configuration: { command: "synthetic-no-process" },
      deviceLink: { startTool: "start_link", finishTool: "finish_link", statusTool: "link_status",
        cancelTool: "cancel_link", removeTool: "remove_account", instructions: "Synthetic setup only" },
    }],
  };
  let connection: any = {
    id: crypto.randomUUID(), installationId: crypto.randomUUID(), connectorKey: "device", name: "Device", alias: "default",
    transport: "stdio", authType: "none", endpoint: null, runtimeGeneration: 0, configuration: { command: "synthetic-no-process" },
    credentials: {}, status: "disconnected", statusMessage: null, connectedAt: null, toolSnapshot: [],
    updatedAt: new Date(), createdAt: new Date(), installation: { pluginKey: manifest.key, status: "installed", manifest },
  };
  const writes: any[] = [];
  const events: any[] = [];
  let deleted = false;
  const rows = [connection];
  const locks: string[] = [];
  const lookup = (input: any) => {
    const row = deleted ? undefined : rows.find(row => matches(row, input.where));
    return row ? structuredClone({ ...row, installation: connection.installation }) : null;
  };
  const matches = (row: any, where: any) => Object.entries(where).every(([key, value]) =>
    value instanceof Date ? row[key]?.getTime() === value.getTime() : row[key] === value);
  const update = ({ data }: any, row = connection) => {
    writes.push(structuredClone(data));
    for (const [key, value] of Object.entries(data)) row[key] =
      value && typeof value === "object" && "increment" in value
        ? row[key] + (value as any).increment : structuredClone(value);
    row.updatedAt = new Date(row.updatedAt.getTime() + 1);
    return structuredClone(row);
  };
  const prisma: any = {
    pluginInstallation: {
      findUnique: async () => deleted ? null : structuredClone({ ...connection.installation,
        id: connection.installationId, name: "Synthetic", connections: rows }),
      update: async ({ data }: any) => { Object.assign(connection.installation, data); return connection.installation; },
      delete: async () => { deleted = true; return {}; },
    },
    processSecret: { deleteMany: async () => ({ count: 0 }) },
    pluginConnection: {
      findUnique: async (input: any) => lookup(input),
      findUniqueOrThrow: async (input: any) => { const row = lookup(input); if (!row) throw new Error("Synthetic row deleted"); return row; },
      findMany: async () => [structuredClone(connection)], count: async () => 1,
      update: async (input: any) => update(input, rows.find(row => matches(row, input.where))),
      updateMany: async (input: any) => {
        const selected = deleted ? [] : rows.filter(row => matches(row, input.where));
        selected.forEach(row => update(input, row));
        return { count: selected.length };
      },
    },
    pluginActivity: { create: async (input: any) => { events.push(input); return input; } },
    event: { create: async (input: any) => { events.push(input); return input; } },
    pluginInvocation: { findUnique: async () => null, create: async (input: any) => input.data },
    $queryRaw: async (sql: TemplateStringsArray) => { locks.push(sql.join("?")); return []; },
    $executeRaw: async () => 0,
  };
  // Model transactional row serialization, rather than silently accepting stale CAS writes.
  let transaction = Promise.resolve();
  prisma.$transaction = (run: any) => {
    const pending = transaction.then(() => run(prisma));
    transaction = pending.catch(() => undefined);
    return pending;
  };
  const calls: Array<{ method: string; path: string; body: any; generation?: string | null; signal?: AbortSignal | null }> = [];
  const runtime = {
    state: "ready", linked: false, tools: [rawTool("read_synthetic"), ...linkTools.map(name => rawTool(name, true))],
    failFinish: false, sequence: 0,
    onCall: undefined as undefined | ((name: string, args: any) => Promise<unknown>),
    onForget: undefined as undefined | (() => Promise<Response>),
    onStop: undefined as undefined | (() => Promise<Response>),
    onStatus: undefined as undefined | (() => Promise<Response>),
  };
  const fetchComputer = async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body, generation: new Headers(init?.headers).get("x-openteam-mcp-generation"), signal: init?.signal });
    if (path.endsWith("/state")) return runtime.onForget ? runtime.onForget() : Response.json({ ok: true });
    if (method === "GET") return runtime.onStatus ? runtime.onStatus() : Response.json({ state: runtime.state, tools: runtime.tools });
    if (method === "DELETE") {
      if (runtime.onStop) return runtime.onStop();
      runtime.state = "stopped"; return Response.json({ ok: true });
    }
    if (path.endsWith("/discover")) { runtime.state = "ready"; return Response.json({ tools: runtime.tools }); }
    let result: unknown;
    if (runtime.onCall) result = await runtime.onCall(body.toolName, body.arguments);
    if (result === undefined) {
      if (body.toolName === "link_status") result = envelope({ linked: runtime.linked });
      else if (body.toolName === "start_link") result = envelope(qr(`synthetic-${++runtime.sequence}`));
      else if (body.toolName === "finish_link" && runtime.failFinish) throw new Error("Synthetic finish transport failure");
      else result = envelope({ pending: true });
    }
    return Response.json({ result });
  };
  const newService = () => {
    const service = new PluginService(prisma as PrismaClient, fetchComputer);
    services.push(service);
    return service;
  };
  const service = newService();
  return { service, newService, runtime, calls, writes, events, rows, locks,
    get deleted() { return deleted; },
    get connection() { return connection; },
    toolCalls: (name: string) => calls.filter(call => call.body?.toolName === name),
    connect: () => Effect.runPromise(service.connect(connection.id)),
    poll: () => Effect.runPromise(service.pollDeviceLink(connection.id)),
  };
}

describe("generic device link host lifecycle (fake DB/computer)", () => {
  test("public QR projection whitelists fields and rejects expired/non-PNG/oversized payloads", () => {
    const link = { ...qr(), instructions: "Scan privately", privateToken: "synthetic-private", deviceLinkUri: "synthetic-uri" };
    expect(publicDeviceLink({ deviceLink: link })).toEqual({
      sessionId: link.sessionId, expiresAt: link.expiresAt, qrCodeDataUrl: link.qrCodeDataUrl, instructions: link.instructions,
    });
    for (const change of [{ expiresAt: Date.now() - 1 }, { qrCodeDataUrl: "data:image/svg+xml;base64,YQ==" },
      { qrCodeDataUrl: "data:image/png;base64," + "A".repeat(70_001) }])
      expect(publicDeviceLink({ deviceLink: { ...link, ...change } })).toBeNull();
    expect(() => deviceLinkResult({ ...envelope({}), isError: true })).toThrow("Device linking failed");
    // An active rotating approval survives its QR image expiring or being invalidated.
    const rotating = { ...qr(), expiresAt: Date.now() - 1, sessionExpiresAt: Date.now() + 120_000,
      challengeGeneration: 4, instructions: "Finish approval on your phone", providerSecret: "synthetic-private" };
    expect(publicDeviceLink({ deviceLink: rotating })).toMatchObject({
      sessionId: rotating.sessionId, qrCodeDataUrl: null, expiresAt: rotating.expiresAt,
      sessionExpiresAt: rotating.sessionExpiresAt, challengeGeneration: 4,
    });
    const invalidated = publicDeviceLink({ deviceLink: { ...rotating, expiresAt: Date.now() + 10_000, qrCodeDataUrl: null } });
    expect(invalidated?.sessionId).toBe(rotating.sessionId);
    expect(invalidated?.qrCodeDataUrl).toBeNull();
    expect(invalidated).not.toHaveProperty("providerSecret");
    expect(publicDeviceLink({ deviceLink: { ...rotating, sessionExpiresAt: Date.now() - 1 } })).toBeNull();
  });

  test("concurrent connects share one start; linking clears the QR and metadata hides host tools", async () => {
    const f = fixture();
    const results = await Promise.all([f.connect(), f.connect()]);
    expect(results.map(result => result.status)).toEqual(["needs_auth", "needs_auth"]);
    expect(f.toolCalls("start_link")).toHaveLength(1);
    expect(f.toolCalls("finish_link")).toHaveLength(1);
    expect(f.connection.toolSnapshot.map((tool: any) => tool.name)).toEqual(["read_synthetic"]);
    expect(publicDeviceLink(f.connection.credentials)?.sessionId).toBe("synthetic-1");
    f.runtime.linked = true;
    await f.poll();
    expect(f.connection.status).toBe("ready");
    expect(f.connection.credentials.deviceLink).toBeUndefined();
    expect(f.calls.find(call => call.path.endsWith("/discover"))?.body.configuration.persistentState).toBe(true);
  });

  test("disconnect fences a delayed linked status and reconnect obtains a new code", async () => {
    const f = fixture();
    await f.connect();
    const entered = deferred<void>(), status = deferred<unknown>();
    f.runtime.onCall = async name => {
      if (name === "link_status") { entered.resolve(); return status.promise; }
    };
    const polling = f.poll().then(value => ({ value }), error => ({ error }));
    await entered.promise;
    await Effect.runPromise(f.service.disconnect(f.connection.id));
    status.resolve(envelope({ linked: true }));
    await polling;
    expect(f.connection.status).toBe("disconnected");
    expect(f.connection.credentials.deviceLink).toBeUndefined();
    expect(f.calls.some(call => call.method === "DELETE" && call.generation === "1")).toBe(true);
    f.runtime.onCall = undefined;
    await f.connect();
    expect(f.connection.credentials.deviceLink.sessionId).toBe("synthetic-2");
    expect(f.toolCalls("remove_account")).toHaveLength(0);
  });

  test.each([
    { state: "ready", recovering: false }, { state: "stopped", recovering: true },
  ])("a previously ready account resumes after a computer outage (%j) without provisioning", async ({ state, recovering }) => {
    const f = fixture();
    f.connection.status = "error";
    f.connection.statusMessage = "Local runtime unavailable: The computer is not reachable.";
    f.runtime.state = state;
    f.runtime.linked = true;
    if (recovering) f.connection.credentials.deviceRecoveryPending = true;
    await (f.service as any).refreshLocalConnections();
    expect(f.connection.status).toBe("ready");
    expect(f.toolCalls("link_status")).toHaveLength(1);
    expect(f.toolCalls("start_link")).toHaveLength(0);
    expect(f.toolCalls("finish_link")).toHaveLength(0);
    expect(f.connection.credentials.deviceLink).toBeUndefined();
    expect(f.connection.credentials.deviceRecoveryPending).toBeUndefined();
  });

  test("expiration cancels the matching session and prevents Bot invocation", async () => {
    const f = fixture();
    await f.connect();
    f.connection.credentials.deviceLink.expiresAt = Date.now() - 1;
    await f.poll();
    expect(f.toolCalls("cancel_link")[0]?.body.arguments).toEqual({ sessionId: "synthetic-1" });
    expect(f.connection.credentials.deviceLink).toBeUndefined();
    expect(f.connection.status).toBe("needs_auth");
    await expect(f.service.invoke({ connectionId: f.connection.id, botId: "synthetic-bot", runId: "synthetic-run",
      callId: "synthetic-call", toolName: "read_synthetic", arguments: {} })).rejects.toThrow("not ready");
  });

  test("Bot invocation cannot execute any manifest-declared lifecycle tool from a polluted tool snapshot", async () => {
    const f = fixture();
    f.runtime.linked = true;
    await f.connect();
    // Simulate stale discovery from a connector version that omitted hostOnly metadata.
    f.connection.toolSnapshot.push(...linkTools.map(name => ({ ...rawTool(name), risk: "destructive" })));
    let executions = 0;
    (f.service as any).transport.executeInvocation = async () => { executions++; return { synthetic: true }; };
    for (const toolName of linkTools) {
      const outcome = await f.service.invoke({ connectionId: f.connection.id, botId: "synthetic-bot", runId: "synthetic-run",
        callId: `synthetic-${toolName}`, toolName, arguments: {} }).then(() => "executed", () => "rejected");
      expect(outcome).toBe("rejected");
    }
    expect(executions).toBe(0);
  });

  test("removal durably gates another service before stop and through forget acknowledgement, then keeps the fenced generation", async () => {
    const f = fixture();
    await f.connect();
    f.locks.length = 0;
    const stopping = deferred<void>(), stopped = deferred<Response>();
    const forgetting = deferred<void>(), forgotten = deferred<Response>();
    f.runtime.onStop = async () => { stopping.resolve(); return stopped.promise; };
    f.runtime.onForget = async () => { forgetting.resolve(); return forgotten.promise; };
    const removing = Effect.runPromise(f.service.removeAccount(f.connection.id));
    const other = f.newService();
    try {
      await stopping.promise;
      expect(f.locks[0]).toContain('"PluginConnection"');
      expect(f.locks[0]).toContain("FOR UPDATE");
      expect(f.connection.credentials.stateRemovalPending).toBe(true);
      expect(f.connection.credentials.deviceLink).toBeUndefined();
      expect(f.connection.runtimeGeneration).toBe(1);
      expect(f.connection.status).toBe("disconnected");
      for (const phase of ["stop", "forget"]) {
        const calls = f.calls.length;
        await expect(Effect.runPromise(other.connect(f.connection.id))).rejects.toThrow("removal is still pending");
        expect(f.calls).toHaveLength(calls);
        if (phase === "stop") {
          stopped.resolve(Response.json({ ok: true }));
          await forgetting.promise;
          expect(f.connection.credentials.stateRemovalPending).toBe(true);
        }
      }
    } finally {
      stopped.resolve(Response.json({ ok: true }));
      forgotten.resolve(Response.json({ ok: true }));
      await removing;
    }
    expect(f.connection.credentials).toEqual({});
    expect(f.connection.runtimeGeneration).toBe(1);
    expect(f.calls.filter(call => call.method === "DELETE").map(call => call.generation)).toEqual(["1", "1"]);
    expect(f.toolCalls("remove_account")).toHaveLength(0);
    await Effect.runPromise(other.connect(f.connection.id));
    expect(publicDeviceLink(f.connection.credentials)?.sessionId).toBe("synthetic-2");
  });

  test("uninstall fences every account before cleanup and rejects reconnect from another service", async () => {
    const f = fixture();
    await f.connect();
    f.rows.push({ ...structuredClone(f.connection), id: crypto.randomUUID(), alias: "other", runtimeGeneration: 7 });
    f.locks.length = 0;
    const entered = deferred<void>(), forgotten = deferred<Response>();
    f.runtime.onForget = async () => { entered.resolve(); return forgotten.promise; };
    const uninstalling = Effect.runPromise(f.service.uninstall("synthetic-device"));
    try {
      await entered.promise;
      expect(f.locks[0]).toContain('"PluginInstallation"');
      expect(f.locks[0]).toContain("FOR UPDATE");
      expect(f.connection.installation.status).toBe("error");
      expect(f.rows.map(row => row.status)).toEqual(["disconnected", "disconnected"]);
      expect(f.rows[1].runtimeGeneration).toBe(8);
      const firstForget = f.calls.findIndex(call => call.path.endsWith("/state"));
      expect(f.calls.slice(0, firstForget).filter(call => call.method === "DELETE").map(call => call.generation)).toEqual(["1", "8"]);
      await expect(Effect.runPromise(f.newService().connect(f.connection.id))).rejects.toThrow("not installed");
      expect(f.toolCalls("start_link")).toHaveLength(1);
      expect(f.deleted).toBe(false);
    } finally { forgotten.resolve(Response.json({ ok: true })); await uninstalling; }
    expect(f.deleted).toBe(true);
  });

  test("poll clears an interrupted QR without starting another link and explicit connect recovers", async () => {
    const f = fixture();
    await f.connect();
    f.connection.credentials.values = { synthetic: "preserved" };
    f.runtime.onCall = async name => name === "link_status" ? envelope({ linked: false, linking: false }) : undefined;
    await f.poll();
    expect(publicDeviceLink(f.connection.credentials)).toBeNull();
    expect(f.connection.credentials.values).toEqual({ synthetic: "preserved" });
    expect(f.connection.status).toBe("needs_auth");
    expect(f.connection.statusMessage).toContain("interrupted");
    expect(f.toolCalls("cancel_link").at(-1)?.body.arguments).toEqual({ sessionId: "synthetic-1" });
    expect(f.toolCalls("start_link")).toHaveLength(1);
    expect(f.toolCalls("finish_link")).toHaveLength(1);
    const calls = f.calls.length;
    await f.poll();
    expect(f.calls).toHaveLength(calls);
    await f.connect();
    expect(publicDeviceLink(f.connection.credentials)?.sessionId).toBe("synthetic-2");
  });
});

describe("rotating device approval challenges", () => {
  const rotatedImage = "data:image/png;base64,cm90YXRlZA==";
  function rotating() {
    const f = fixture();
    const start = { ...qr("rotating-session"), expiresAt: Date.now() + 30_000,
      sessionExpiresAt: Date.now() + 180_000, challengeGeneration: 0 };
    let status: Record<string, unknown> = { linked: false, linking: true, sessionId: start.sessionId };
    f.runtime.onCall = async name => name === "start_link" ? envelope(start)
      : name === "link_status" ? envelope(status) : undefined;
    return { ...f, start, setStatus: (next: Record<string, unknown>) => { status = next; } };
  }
  const active = (sessionId: string, challenge?: Record<string, unknown>) => ({
    linked: false, linking: true, sessionId, ...(challenge ? { challenge } : {}),
  });

  test("only a newer challenge for the current session replaces the image; stale, equal and foreign statuses are ignored", async () => {
    const f = rotating();
    await f.connect();
    const deadline = f.connection.credentials.deviceLink.sessionExpiresAt;
    const generation = f.connection.runtimeGeneration;
    const expiresAt = Date.now() + 60_000;
    f.setStatus(active(f.start.sessionId, { generation: 2, qrCodeDataUrl: rotatedImage, expiresAt }));
    await f.poll();
    expect(publicDeviceLink(f.connection.credentials)).toMatchObject({
      sessionId: f.start.sessionId, qrCodeDataUrl: rotatedImage, expiresAt, sessionExpiresAt: deadline, challengeGeneration: 2,
    });
    expect(f.connection.runtimeGeneration).toBe(generation);
    const stored = structuredClone(f.connection.credentials.deviceLink);
    for (const status of [
      ...[2, 1, 0].map(generation => ({ ...active(f.start.sessionId, { generation, qrCodeDataUrl: null, expiresAt }), sessionExpiresAt: Date.now() + 500_000 })),
      { linked: true, sessionId: "foreign-session" },
      { linked: false, linking: false, authorizationError: "synthetic stale failure", sessionId: "foreign-session" },
      active("foreign-session", { generation: 50, qrCodeDataUrl: rotatedImage, expiresAt: Date.now() + 60_000 }),
    ]) {
      f.setStatus(status);
      await f.poll();
      expect(f.connection.status).toBe("needs_auth");
      expect(f.connection.credentials.deviceLink).toEqual(stored);
    }
    expect(f.toolCalls("start_link")).toHaveLength(1);
    expect(f.toolCalls("finish_link")).toHaveLength(1);
    expect(f.toolCalls("cancel_link")).toHaveLength(0);
  });

  test("Get new code replaces a dynamic session and fences its late successful status", async () => {
    const f = fixture();
    const entered = deferred<void>(), delayed = deferred<unknown>();
    let sequence = 0, currentSession = "", holdStatus = false;
    f.runtime.onCall = async name => {
      if (name === "start_link") {
        currentSession = `dynamic-${++sequence}`;
        return envelope({ ...qr(currentSession), expiresAt: Date.now() + 30_000,
          sessionExpiresAt: Date.now() + 180_000, challengeGeneration: 0 });
      }
      if (name === "link_status") {
        if (holdStatus) { entered.resolve(); return delayed.promise; }
        return envelope(active(currentSession));
      }
    };
    await f.connect();
    holdStatus = true;
    const polling = f.poll().then(value => ({ value }), error => ({ error }));
    await entered.promise;
    holdStatus = false;
    await Effect.runPromise(f.service.restart(f.connection.id));
    expect(f.connection.credentials.deviceLink.sessionId).toBe("dynamic-2");
    expect(f.connection.runtimeGeneration).toBe(1);
    delayed.resolve(envelope({ linked: true, sessionId: "dynamic-1" }));
    await polling;
    expect(f.connection.status).toBe("needs_auth");
    expect(f.connection.credentials.deviceLink.sessionId).toBe("dynamic-2");
    expect(f.toolCalls("start_link")).toHaveLength(2);
    expect(f.toolCalls("finish_link")).toHaveLength(2);
  });
});
