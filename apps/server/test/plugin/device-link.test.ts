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
  });

  test("lifecycle results reject JSON primitives and arrays instead of treating them as status objects", () => {
    for (const value of [null, [], true, 1, "not-a-status"])
      expect(() => deviceLinkResult(envelope(value))).toThrow();
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

  test("connect accepts an account recovered between the status check and QR start", async () => {
    const f = fixture();
    f.runtime.onCall = async (name) => {
      if (name === "start_link") {
        f.runtime.linked = true;
        throw new Error("Account recovered and is already linked");
      }
    };
    expect(await f.connect()).toMatchObject({ status: "ready" });
    expect(f.connection.status).toBe("ready");
    expect(f.connection.credentials.deviceLink).toBeUndefined();
    expect(f.toolCalls("finish_link")).toHaveLength(0);
    expect(f.toolCalls("link_status")).toHaveLength(2);
  });

  test("a running collector's recovery is observed after the host leaves ready without provisioning", async () => {
    const f = fixture();
    f.runtime.linked = true;
    await f.connect();
    f.runtime.onCall = async (name) =>
      name === "link_status" ? envelope({ linked: false, recovering: true }) : undefined;
    expect(await f.poll()).toMatchObject({ recovering: true });
    expect(f.connection.status).toBe("error");
    expect(f.connection.credentials.deviceRecoveryPending).toBe(true);
    f.runtime.onCall = undefined;
    const otherService = f.newService();
    await (otherService as any).refreshLocalConnections();
    expect(f.connection.status).toBe("ready");
    expect(f.connection.credentials.deviceRecoveryPending).toBeUndefined();
    expect(f.toolCalls("start_link")).toHaveLength(0);
  });

  test.each([
    "stopped",
    "error",
  ])("recovery polling observes %s runtimes without starting them", async (state) => {
    const f = fixture();
    f.connection.status = "error";
    f.connection.credentials.deviceRecoveryPending = true;
    f.runtime.state = state;
    const before = f.calls.length;
    await f.poll();
    expect(f.calls.slice(before)).toEqual([expect.objectContaining({ method: "GET" })]);
    expect(f.connection.credentials.deviceRecoveryPending).toBeUndefined();
    expect(f.connection.status).toBe("needs_auth");
  });

  test("disconnect clears recovery state and fences a delayed recovered status", async () => {
    const f = fixture();
    f.connection.status = "error";
    f.connection.credentials.deviceRecoveryPending = true;
    const entered = deferred<void>(),
      release = deferred<unknown>();
    f.runtime.onCall = async (name) => {
      if (name === "link_status") {
        entered.resolve();
        return release.promise;
      }
    };
    const polling = f.poll().catch(() => {});
    await entered.promise;
    await Effect.runPromise(f.service.disconnect(f.connection.id));
    release.resolve(envelope({ linked: true }));
    await polling;
    expect(f.connection.status).toBe("disconnected");
    expect(f.connection.credentials.deviceRecoveryPending).toBeUndefined();
  });

  test("a delayed recovery success cannot clear a newer QR at the same generation", async () => {
    const f = fixture();
    f.connection.status = "error";
    f.connection.credentials.deviceRecoveryPending = true;
    const entered = deferred<void>(),
      release = deferred<unknown>();
    f.runtime.onCall = async (name) => {
      if (name === "link_status") {
        entered.resolve();
        return release.promise;
      }
    };
    const polling = f.poll().catch(() => {});
    await entered.promise;
    f.connection.credentials = { deviceLink: { ...qr("newer-session"), instructions: "Scan" } };
    f.connection.status = "needs_auth";
    f.connection.updatedAt = new Date(f.connection.updatedAt.getTime() + 1);
    release.resolve(envelope({ linked: true }));
    await polling;
    expect(f.connection.status).toBe("needs_auth");
    expect(f.connection.credentials.deviceLink.sessionId).toBe("newer-session");
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

  test("stale QR cancellation cannot disconnect a newer linking session", async () => {
    const f = fixture();
    await f.connect();
    f.connection.credentials.deviceLink.sessionId = "synthetic-newer-session";
    const generation = f.connection.runtimeGeneration;
    await expect(Effect.runPromise(f.service.cancelDeviceLink(f.connection.id, "synthetic-1"))).rejects.toThrow("newer linking session");
    expect(f.connection.credentials.deviceLink.sessionId).toBe("synthetic-newer-session");
    expect(f.connection.runtimeGeneration).toBe(generation);
    expect(f.calls.filter(call => call.method === "DELETE")).toHaveLength(0);
  });

  test("QR cancellation closes the process before a concurrent reconnect starts", async () => {
    const f = fixture();
    await f.connect();
    const entered = deferred<void>(), stopped = deferred<Response>();
    f.runtime.onStop = async () => { entered.resolve(); return stopped.promise; };
    const cancelling = Effect.runPromise(f.service.cancelDeviceLink(f.connection.id, "synthetic-1"));
    await entered.promise;
    const starts = f.toolCalls("start_link").length;
    const reconnecting = f.connect();
    await Promise.race([reconnecting, Bun.sleep(100)]);
    const startsWhileCancelling = f.toolCalls("start_link").length - starts;
    stopped.resolve(Response.json({ ok: true }));
    await Promise.allSettled([cancelling, reconnecting]);
    expect(startsWhileCancelling).toBe(0);
  });

  test("explicit reconnect recovers when finish failed after QR persistence", async () => {
    const f = fixture();
    f.runtime.failFinish = true;
    await expect(f.connect()).rejects.toThrow("Synthetic finish transport failure");
    expect(publicDeviceLink(f.connection.credentials)).not.toBeNull();
    f.runtime.failFinish = false;
    await f.connect();
    // A reused QR must restart the finish waiter, otherwise it cannot complete.
    expect(f.toolCalls("finish_link")).toHaveLength(2);
  });

  test("reconnect after computer restart replaces the QR whose in-memory session was lost", async () => {
    const f = fixture();
    await f.connect();
    f.runtime.state = "stopped";
    // The restarted connector reports neither a linked account nor an active waiter.
    f.runtime.onCall = async name => name === "link_status" ? envelope({ linked: false, linking: false }) : undefined;
    await f.connect();
    expect(f.connection.credentials.deviceLink.sessionId).not.toBe("synthetic-1");
    expect(f.toolCalls("start_link")).toHaveLength(2);
  });

  test("manifest-declared lifecycle tools stay absent from Bot discovery even without MCP metadata", async () => {
    const f = fixture();
    f.runtime.tools = [rawTool("read_synthetic"), ...linkTools.map(name => rawTool(name))];
    f.runtime.linked = true;
    await f.connect();
    const namespaces = await f.service.dynamicNamespaces("synthetic-bot");
    expect(namespaces.flatMap(namespace => namespace.tools.map(tool => tool.name))).toEqual(["read_synthetic"]);
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

  test("offline removal never provisions a runtime and reports inability to delete state", async () => {
    const f = fixture();
    f.runtime.state = "stopped";
    f.runtime.onForget = async () => new Response("synthetic offline", { status: 503 });
    await expect(Effect.runPromise(f.service.removeAccount(f.connection.id))).rejects.toThrow("state could not be removed");
    expect(f.toolCalls("remove_account")).toHaveLength(0);
    expect(f.calls.some(call => call.path.endsWith("/discover"))).toBe(false);
    expect(f.connection.status).toBe("disconnected");
    expect(f.connection.runtimeGeneration).toBe(1);
    expect(f.connection.credentials.stateRemovalPending).toBe(true);
    const calls = f.calls.length;
    await expect(Effect.runPromise(f.newService().connect(f.connection.id))).rejects.toThrow("removal is still pending");
    expect(f.calls).toHaveLength(calls);
    f.runtime.onForget = undefined;
    await expect(Effect.runPromise(f.service.removeAccount(f.connection.id))).resolves.toEqual({ removed: true, reset: true });
    expect(f.connection.credentials).toEqual({});
    expect(f.connection.runtimeGeneration).toBe(2);
    expect(f.calls.filter(call => call.path.endsWith("/state")).map(call => call.generation)).toEqual(["1", "2"]);
    await f.connect();
    expect(f.toolCalls("start_link")).toHaveLength(1);
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

  test("failed removal stop keeps the durable gate and skips deletion until a successful retry", async () => {
    const f = fixture();
    await f.connect();
    f.runtime.onStop = async () => new Response("synthetic refusal", { status: 503 });
    await expect(Effect.runPromise(f.service.removeAccount(f.connection.id))).rejects.toThrow("runtime stopped");
    expect(f.connection.credentials.stateRemovalPending).toBe(true);
    expect(f.connection.credentials.deviceLink).toBeUndefined();
    expect(f.calls.filter(call => call.path.endsWith("/state"))).toHaveLength(0);
    const calls = f.calls.length;
    await expect(Effect.runPromise(f.newService().connect(f.connection.id))).rejects.toThrow("removal is still pending");
    expect(f.calls).toHaveLength(calls);
    f.runtime.onStop = undefined;
    await Effect.runPromise(f.service.removeAccount(f.connection.id));
    expect(f.connection.credentials).toEqual({});
    expect(f.connection.runtimeGeneration).toBe(2);
    expect(f.calls.filter(call => call.path.endsWith("/state")).map(call => call.generation)).toEqual(["2"]);
    expect(f.toolCalls("remove_account")).toHaveLength(0);
  });

  test("account removal waits for deletion and subsequent reset before permitting reconnect", async () => {
    const f = fixture();
    f.runtime.state = "stopped";
    const entered = deferred<void>(), forgotten = deferred<Response>();
    f.runtime.onForget = async () => { entered.resolve(); return forgotten.promise; };
    const removing = Effect.runPromise(f.service.removeAccount(f.connection.id));
    await entered.promise;
    const reconnecting = f.connect();
    // Same-service connects wait for removal; other services reject via the durable gate.
    await Promise.race([reconnecting, Bun.sleep(100)]);
    const startsDuringRemoval = f.toolCalls("start_link").length;
    forgotten.resolve(Response.json({ ok: true }));
    await Promise.allSettled([removing, reconnecting]);
    expect(startsDuringRemoval).toBe(0);
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

  test("failed uninstall cleanup retains the fenced installation for a successful retry", async () => {
    const f = fixture();
    await f.connect();
    f.runtime.onForget = async () => new Response("synthetic refusal", { status: 503 });
    await expect(Effect.runPromise(f.service.uninstall("synthetic-device"))).rejects.toThrow("state could not be removed");
    expect(f.deleted).toBe(false);
    expect(f.connection.installation.status).toBe("error");
    expect(f.connection.status).toBe("disconnected");
    const staleLink = f.connection.credentials.deviceLink;
    await expect(f.connect()).rejects.toThrow("not installed");
    f.runtime.onForget = undefined;
    await Effect.runPromise(f.service.uninstall("synthetic-device"));
    expect(f.deleted).toBe(true);
    expect(staleLink).toBeUndefined();
  });

  test("uninstall cannot delete account state or installation after a failed runtime stop", async () => {
    const f = fixture();
    await f.connect();
    f.runtime.onStop = async () => new Response("synthetic refusal", { status: 503 });
    await expect(Effect.runPromise(f.service.uninstall("synthetic-device"))).rejects.toThrow("runtime stopped");
    expect(f.calls.filter(call => call.path.endsWith("/state"))).toHaveLength(0);
    expect(f.deleted).toBe(false);
    expect(f.connection.installation.status).toBe("error");
    expect(f.connection.runtimeGeneration).toBe(1);
  });

  for (const failure of ["http503", "transport", "abort"] as const) {
    test(`disconnect surfaces ${failure}, clears the code, and remains retryable`, async () => {
      const f = fixture();
      await f.connect();
      f.runtime.onStop = async () => {
        if (failure === "http503") return new Response("synthetic refusal", { status: 503 });
        throw failure === "abort" ? new DOMException("Synthetic timeout", "TimeoutError") : new Error("Synthetic transport failure");
      };
      await expect(Effect.runPromise(f.service.disconnect(f.connection.id))).rejects.toThrow();
      expect(f.connection.status).toBe("error");
      expect(f.connection.statusMessage).toContain("Could not confirm the runtime stopped");
      expect(f.connection.runtimeGeneration).toBe(1);
      expect(f.connection.connectedAt).toBeNull();
      expect(f.connection.credentials.deviceLink).toBeUndefined();
      const stop = f.calls.find(call => call.method === "DELETE");
      expect(stop?.generation).toBe("1");
      expect(stop?.signal).toBeInstanceOf(AbortSignal);
      f.runtime.onStop = undefined;
      await expect(Effect.runPromise(f.service.disconnect(f.connection.id))).resolves.toEqual({ disconnected: true });
      expect(f.connection.status).toBe("disconnected");
    });
  }

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

  for (const state of ["stopped", "error"]) {
    for (const background of [false, true]) {
      test(`${background ? "background" : "explicit"} poll passively clears a QR when runtime state is ${state} without any host call`, async () => {
        const f = fixture();
        await f.connect();
        f.connection.credentials.values = { synthetic: "preserved" };
        f.runtime.state = state;
        const calls = f.calls.length;
        if (background) await (f.service as any).refreshLocalConnections();
        else await f.poll();
        expect(f.calls.slice(calls).map(call => [call.method, call.path])).toEqual([
          ["GET", `/v1/mcp/connections/${f.connection.id}`],
        ]);
        expect(f.runtime.state).toBe(state);
        expect(f.connection.runtimeGeneration).toBe(0);
        expect(f.connection.credentials).toEqual({ values: { synthetic: "preserved" } });
        expect(f.connection.status).toBe("needs_auth");
        expect(f.connection.statusMessage).toContain("Connect again");
        expect(f.connection.connectedAt).toBeNull();
        const after = f.calls.length;
        await f.poll();
        expect(f.calls).toHaveLength(after);
        await f.connect();
        expect(publicDeviceLink(f.connection.credentials)?.sessionId).toBe("synthetic-2");
      });
    }
  }

  test("a delayed stopped-runtime probe cannot clear a newer QR at the same generation", async () => {
    const f = fixture();
    await f.connect();
    const entered = deferred<void>(), status = deferred<Response>();
    f.runtime.onStatus = async () => { entered.resolve(); return status.promise; };
    const polling = f.poll();
    try {
      await entered.promise;
      f.runtime.onStatus = undefined;
      await f.connect();
    } finally {
      status.resolve(Response.json({ state: "stopped", tools: [] }));
      await polling;
    }
    expect(publicDeviceLink(f.connection.credentials)?.sessionId).toBe("synthetic-2");
    expect(f.connection.runtimeGeneration).toBe(0);
    expect(f.connection.statusMessage).toContain("Scan the code");
  });

  test("interrupted status from an old poll cannot clear a newer QR at the same generation", async () => {
    const f = fixture();
    await f.connect();
    const entered = deferred<void>(), status = deferred<unknown>();
    f.runtime.onCall = async name => {
      if (name === "link_status") { entered.resolve(); return status.promise; }
    };
    const polling = f.poll();
    await entered.promise;
    f.runtime.onCall = undefined;
    await f.connect();
    status.resolve(envelope({ linked: false, linking: false }));
    await polling;
    expect(publicDeviceLink(f.connection.credentials)?.sessionId).toBe("synthetic-2");
    expect(f.connection.status).toBe("needs_auth");
  });
});
