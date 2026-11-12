import { afterEach, expect, test } from "bun:test";
import { McpHttpClientManager } from "../../src/plugins/mcp-client-manager";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

const managers: McpHttpClientManager[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.closeAll()));
  for (const server of servers.splice(0)) server.stop(true);
});

function fixture() {
  const manager = new McpHttpClientManager();
  managers.push(manager);
  const entered = gate(), release = gate(), called = gate(), finishCall = gate(), cancelled = gate();
  const initializations: string[] = [];
  const methods: string[] = [];
  const writes = new Map<string, number>();
  const sessions = new Set<string>();
  let unavailable = false, deliveries = 0;
  let droppedResponse: boolean | "truncated" = false;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.method === "GET") return new Response(null, { status: 405 });
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      const path = new URL(request.url).pathname;
      const message = await request.json() as { id?: number; method: string; params?: { name?: string; arguments?: { requestId?: string } } };
      methods.push(message.method);
      if (message.method !== "initialize" && !sessions.has(request.headers.get("mcp-session-id") ?? ""))
        return new Response("Session expired", { status: 404 });
      if (unavailable) return new Response("Provider unavailable", { status: 503 });
      let result: unknown;
      if (message.method === "initialize") {
        initializations.push(path);
        if (path === "/slow" && initializations.filter(p => p === path).length === 1) {
          entered.release(); await release.promise;
        }
        result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "chaos", version: "1" } };
      } else if (message.method === "tools/list") {
        result = { tools: [{ name: path.slice(1) || "echo", inputSchema: { type: "object" } }] };
      } else if (message.method === "tools/call") {
        deliveries++;
        if (message.params?.name === "wait") { called.release(); await finishCall.promise; }
        const requestId = message.params?.arguments?.requestId;
        if (requestId && !writes.has(requestId)) writes.set(requestId, writes.size + 1);
        if (droppedResponse === "truncated") return new Response('{"jsonrpc":"2.0","id":', { headers: { "content-type": "application/json" } });
        if (droppedResponse) return new Response("Reply lost after applying write", { status: 503 });
        result = { content: [{ type: "text", text: requestId ? String(writes.get(requestId)) : "ok" }] };
      } else {
        if (message.method === "notifications/cancelled") cancelled.release();
        return new Response(null, { status: 202 });
      }
      const session = crypto.randomUUID();
      if (message.method === "initialize") sessions.add(session);
      return Response.json({ jsonrpc: "2.0", id: message.id, result }, {
        headers: message.method === "initialize" ? { "mcp-session-id": session } : {},
      });
    },
  });
  servers.push(server);
  return {
    manager, entered, release, called, finishCall, cancelled, methods, initializations, writes,
    options: (path = "echo") => ({ endpoint: `http://127.0.0.1:${server.port}/${path}` }),
    unavailable: (value: boolean) => { unavailable = value; },
    dropResponse: (value: boolean | "truncated") => { droppedResponse = value; },
    deliveries: () => deliveries,
    expireSessions: () => sessions.clear(),
  };
}

test("a burst of discovery requests shares one initialization", async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 20 }, () => f.manager.discover("burst", f.options())));
  expect(results.every(tools => tools[0]?.name === "echo")).toBe(true);
  expect(f.initializations).toHaveLength(1);
});

test("a lost server session is discarded without replaying the tool and an explicit retry reconnects", async () => {
  const f = fixture();
  await f.manager.discover("expired", f.options());
  f.expireSessions();
  await expect(f.manager.call("expired", f.options(), "write", { requestId: "after-restart" })).rejects.toThrow();
  expect(f.deliveries()).toBe(0);
  expect(await f.manager.call("expired", f.options(), "write", { requestId: "after-restart" })).toMatchObject({ content: [{ text: "1" }] });
  expect(f.initializations).toHaveLength(2);
  expect(f.deliveries()).toBe(1);
});

test("cancelling one caller during shared startup returns promptly without cancelling another caller", async () => {
  const f = fixture();
  const controller = new AbortController();
  const cancelled = f.manager.call("startup-cancel", f.options("slow"), "write", {}, controller.signal)
    .then(() => "completed", () => "cancelled");
  const observer = f.manager.discover("startup-cancel", f.options("slow"));
  try {
    await f.entered.promise;
    controller.abort();
    expect(await Promise.race([cancelled, Bun.sleep(500).then(() => "blocked")])).toBe("cancelled");
    f.release.release();
    expect((await observer)[0]?.name).toBe("slow");
    expect(f.deliveries()).toBe(0);
    expect(f.initializations).toHaveLength(1);
  } finally { f.release.release(); await observer; await cancelled; }
});

test("disconnect while initialization is blocked cannot resurrect its session", async () => {
  const f = fixture();
  const pending = f.manager.discover("closed", f.options("slow")).then(() => "ready", () => "closed");
  try {
    await f.entered.promise;
    await f.manager.close("closed");
    f.release.release();
    expect(await pending).toBe("closed");
    expect((await f.manager.discover("closed", f.options("slow")))[0]?.name).toBe("slow");
    expect(f.initializations).toHaveLength(2);
  } finally { f.release.release(); }
});

test("a slow obsolete endpoint cannot replace a newer session", async () => {
  const f = fixture();
  const old = f.manager.discover("changed", f.options("slow")).then(() => "ready", () => "replaced");
  try {
    await f.entered.promise;
    expect((await f.manager.discover("changed", f.options("new")))[0]?.name).toBe("new");
    f.release.release();
    expect(await old).toBe("replaced");
    expect((await f.manager.discover("changed", f.options("new")))[0]?.name).toBe("new");
    expect(f.initializations.filter(path => path === "/new")).toHaveLength(1);
  } finally { f.release.release(); }
});

test("an unavailable provider can reconnect after recovery", async () => {
  const f = fixture();
  f.unavailable(true);
  await expect(f.manager.discover("outage", f.options())).rejects.toThrow();
  f.unavailable(false);
  expect((await f.manager.discover("outage", f.options()))[0]?.name).toBe("echo");
  expect(await f.manager.call("outage", f.options(), "echo", {})).toMatchObject({ content: [{ text: "ok" }] });
});

test("a lost write response is not automatically replayed; the caller can retry its stable request ID", async () => {
  const f = fixture();
  await f.manager.discover("write", f.options());
  f.dropResponse(true);
  await expect(f.manager.call("write", f.options(), "write", { requestId: "one-job" })).rejects.toThrow();
  expect(f.deliveries()).toBe(1);
  expect(f.writes.size).toBe(1);
  f.dropResponse(false);
  expect(await f.manager.call("write", f.options(), "write", { requestId: "one-job" })).toMatchObject({ content: [{ text: "1" }] });
  expect(f.writes.size).toBe(1);
});

test("a truncated successful response cannot cause automatic write replay", async () => {
  const f = fixture();
  f.dropResponse("truncated");
  await expect(f.manager.call("truncated", f.options(), "write", { requestId: "partial-reply" })).rejects.toThrow();
  expect(f.deliveries()).toBe(1);
  expect(f.writes.size).toBe(1);
  f.dropResponse(false);
  expect(await f.manager.call("truncated", f.options(), "write", { requestId: "partial-reply" })).toMatchObject({ content: [{ text: "1" }] });
  expect(f.writes.size).toBe(1);
});

test("an already cancelled call does not initialize or dispatch any MCP request", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(f.manager.call("pre-cancelled", f.options(), "write", {}, controller.signal)).rejects.toThrow();
  expect(f.methods).toEqual([]);
});

test("discovery also discards an expired session for the next explicit attempt", async () => {
  const f = fixture();
  await f.manager.discover("expired-discovery", f.options());
  f.expireSessions();
  await expect(f.manager.discover("expired-discovery", f.options())).rejects.toThrow();
  expect((await f.manager.discover("expired-discovery", f.options()))[0]?.name).toBe("echo");
  expect(f.initializations).toHaveLength(2);
});

test("aborting a blocked call sends cancellation and leaves the connection usable", async () => {
  const f = fixture();
  const controller = new AbortController();
  const call = f.manager.call("cancel", f.options(), "wait", {}, controller.signal).then(() => "completed", () => "cancelled");
  try {
    await f.called.promise;
    controller.abort();
    expect(await call).toBe("cancelled");
    await f.cancelled.promise;
    f.finishCall.release();
    expect(await f.manager.call("cancel", f.options(), "echo", {})).toMatchObject({ content: [{ text: "ok" }] });
    expect(f.initializations).toHaveLength(1);
  } finally { f.finishCall.release(); }
});

test("disconnect also aborts a legacy SSE connection stalled before response headers", async () => {
  const entered = gate(), release = gate();
  const manager = new McpHttpClientManager();
  managers.push(manager);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    entered.release(); await release.promise;
    return new Response(null, { status: 503 });
  } });
  servers.push(server);
  const pending = manager.discover("blackhole", { endpoint: server.url.href }).then(() => "ready", () => "closed");
  try {
    await entered.promise;
    await manager.closeAll();
    expect(await Promise.race([pending, Bun.sleep(1000).then(() => "still blocked")])).toBe("closed");
  } finally { release.release(); await pending; }
});

test("repeated close/reconnect bursts leave one reusable session per generation", async () => {
  const f = fixture();
  for (let generation = 0; generation < 25; generation++) {
    const options = { ...f.options(), runtimeGeneration: generation };
    const requests = Array.from({ length: 12 }, (_, index) => index % 2
      ? f.manager.discover("churn", options)
      : f.manager.call("churn", options, "echo", {}));
    if (generation % 2 === 0) await f.manager.close("churn");
    const results = await Promise.allSettled(requests);
    if (generation % 2 === 0) expect(results.every(result => result.status === "rejected")).toBe(true);
    else expect(results.every(result => result.status === "fulfilled")).toBe(true);
    await f.manager.discover("churn", options);
    const initialized = f.initializations.length;
    await f.manager.call("churn", options, "echo", {});
    expect(f.initializations).toHaveLength(initialized);
  }
});

test("shutdown fences initialization while access validation is blocked", async () => {
  const f = fixture();
  const entered = gate(), release = gate();
  const options = { ...f.options(), beforeRequest: async () => { entered.release(); await release.promise; } };
  const pending = f.manager.discover("validation", options).then(() => "ready", () => "closed");
  try {
    await entered.promise;
    await f.manager.closeAll();
    expect(await Promise.race([pending, Bun.sleep(500).then(() => "blocked")])).toBe("closed");
    expect(f.initializations).toHaveLength(0);
  } finally { release.release(); await pending; }
});

test("rejecting a stale configuration cannot evict the current cached session", async () => {
  const f = fixture();
  await f.manager.discover("policy", f.options());
  await expect(f.manager.discover("policy", {
    ...f.options("obsolete"), beforeRequest: async () => { throw new Error("Access changed"); },
  })).rejects.toThrow("Access changed");
  expect(await f.manager.call("policy", f.options(), "echo", {})).toMatchObject({ content: [{ text: "ok" }] });
  expect(f.initializations).toHaveLength(1);
});
