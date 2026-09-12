import { mock } from "bun:test";
import { Effect } from "/Users/raghav/OpenBot/apps/server/node_modules/effect";
import ts from "/Users/raghav/OpenBot/node_modules/typescript/lib/typescript.js";
import { createHash } from "node:crypto";
import { join } from "node:path";

// Runs the actual HTTP handler, with only service effects and external boundaries stubbed.
const [root, output, mode = "disabled", operation = "parity"] = process.argv.slice(2);
const source = join(root!, "apps/server/src");
const id = "11111111-1111-4111-8111-111111111111";
let record = true;
let calls: unknown[] = [];
const result = {
  id, ok: true, server: "ready", bytes: Buffer.from("sample"), contentType: "image/png",
  channels: [{ id, directKey: `bot:${id}` }], bots: [{ id, conversationId: id }],
  channelMessages: [], channelRounds: [], runs: [], runItems: [], subagents: [], approvals: [],
};
const app = new Proxy({}, {
  get(_target, key) {
    if (key === "then") return undefined;
    return (...args: unknown[]) => {
      if (record) calls.push([String(key), args]);
      return Effect.succeed(result);
    };
  },
});
mock.module(join(source, "app-service.ts"), () => ({ AppService: class { constructor() { return app; } } }));
mock.module(join(source, "auth.ts"), () => ({
  authPrisma: { $disconnect: async () => {} },
  auth: {
    api: { getSession: async ({ headers }: { headers: Headers }) =>
      headers.get("cookie") === "session=yes" ? { session: { id: "qa-session" } } : null },
    handler: async (request: Request) => Response.json({ auth: new URL(request.url).pathname }),
  },
}));
mock.module(join(source, "owner-credentials.ts"), () => ({ runOwnerCredentialCommand: async () => {} }));
mock.module(join(source, "event-stream.ts"), () => ({
  EVENT_POLL_MAX_WAIT_MS: 25000,
  eventStream: (_app: unknown, cursor: unknown) => {
    calls.push(["eventStream", cursor]);
    return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("data: fixture\n\n")); controller.close(); } });
  },
  eventPoll: async (_app: unknown, cursor: unknown, _signal: unknown, waitMs: unknown) => {
    calls.push(["eventPoll", cursor, waitMs]); return { events: [], cursor };
  },
}));
mock.module(join(source, "asset-http.ts"), () => ({
  assetResponse: async (_assets: unknown, _data: unknown, request: Request, _url: URL, assetId: string) => {
    calls.push(["assetResponse", request.method, assetId]); return new Response("asset");
  },
}));
let fetchHandler: (request: Request, server: unknown) => Promise<Response>;
const originalServe = Bun.serve;
Bun.serve = ((options: any) => {
  fetchHandler = options.fetch;
  return { stop() {}, url: "http://localhost:0" };
}) as typeof Bun.serve;
const oldLog = console.log;
console.log = () => {};
process.env.OPENTEAM_AUTH_MODE = mode;
process.env.OPENTEAM_CONTROL_TOKEN = "qa-control";
crypto.randomUUID = () => id;
await import(join(source, "main.ts"));
console.log = oldLog;
Bun.serve = originalServe;
const baselineText = await Bun.file(join(root!, "../baseline/apps/server/src/main.ts")).text();
const sf = ts.createSourceFile("main.ts", baselineText, ts.ScriptTarget.Latest, true);
const matches = new Map<string, string>();
function collectMatches(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)
      && node.initializer.expression.getText(sf) === "path.match") {
    const regex = node.initializer.arguments[0]!.getText(sf);
    const path = regex.replace(/^\//, "").replace(/\/[a-z]*$/, "").replace(/^\^/, "").replace(/\$$/, "")
      .replaceAll("\\/", "/").replaceAll("([^/]+)", id).replaceAll("([a-f0-9]{64})", "a".repeat(64));
    matches.set(node.name.getText(sf), path);
  }
  ts.forEachChild(node, collectMatches);
}
collectMatches(sf);
const routes = new Map<string, { method: string; path: string }>();
function collectRoutes(node: ts.Node) {
  if (ts.isIfStatement(node)) {
    const condition = node.expression.getText(sf);
    const method = condition.match(/request\.method === "(\w+)"/)?.[1];
    const fixed = condition.match(/(?:path|url\.pathname) === "([^"]+)"/)?.[1];
    const variable = condition.match(/&& (\w+)\?\.\[1\]/)?.[1];
    const path = fixed ?? (variable ? matches.get(variable) : undefined);
    if (method && path) routes.set(`${method} ${path}`, { method, path });
  }
  ts.forEachChild(node, collectRoutes);
}
collectRoutes(sf);
for (const path of ["/api/snapshot", "/api/bootstrap", "/api/not-a-route", "/health", `/api/assets/${"a".repeat(64)}`])
  routes.set(`GET ${path}`, { method: "GET", path });
const rich = JSON.stringify({
  clientId: id, clientRequestId: id, name: "Example", content: "Hello", botIds: [id], members: [id],
  hidden: true, enabled: true, alias: "Test Alias", pluginKey: "openteam-utility-lab", values: {},
  emoji: "👍", decision: "accept", active: true, paused: false, instructions: "test", action: "complete",
  widgetId: id, value: "yes", promptId: id, authType: "api_key", activeAgentId: id, description: "description",
  shape: "circle", color: "#123456", field: "token", secret: "fixture", expectedRevision: 1, throughSequence: "1",
});
const inputs = [undefined, "{", "null", "{}", rich, '{"name":"Example","clientId":"fixture","prompt":"hello","schedule":"every day","enabled":false}'];
const queries = ["", "?limit=invalid&before=bad&offset=-1&id=x&q=hello", "?limit=1&before=1&offset=0&id=x", "?limit=0&after=-1&waitMs=no&category=invalid", "?limit=1e2&direction=before&before=1"];
const fakeServer = { requestIP: () => ({ address: "127.0.0.1" }) };
async function execute(method: string, path: string, body?: string, session = true, internal = true) {
  calls = [];
  const request = new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", ...(session ? { cookie: "session=yes" } : {}), ...(internal ? { authorization: "Bearer qa-control" } : {}) },
    ...(body === undefined ? {} : { body }),
  });
  const response = await fetchHandler(request, fakeServer);
  return { calls, status: response.status, body: await response.text(),
    headers: [...response.headers].filter(([key]) => key !== "server-timing"), bodyUsed: request.bodyUsed };
}
if (operation === "parity") {
  const rows = [];
  for (const route of routes.values()) {
    for (const path of [...new Set([route.path, route.path.replaceAll(id, "a%2Fb"), route.path.replaceAll(id, "bad%escape")])]) {
      for (const query of queries) for (const body of ["GET", "HEAD"].includes(route.method) ? [undefined] : inputs) {
        const key = { ...route, path, query, body };
        rows.push({ key, result: await execute(route.method, path + query, body) });
      }
    }
    for (const session of [false, true]) for (const internal of [false, true]) {
      rows.push({ key: { ...route, session, internal }, result: await execute(route.method, route.path, ["GET", "HEAD"].includes(route.method) ? undefined : rich, session, internal) });
    }
  }
  // API alias and method fall-through, including unknown paths.
  for (const route of routes.values()) for (const method of ["OPTIONS", "HEAD", "PUT"]) {
    rows.push({ key: { method, path: route.path }, result: await execute(method, route.path) });
  }
  for (const route of routes.values()) if (route.path.startsWith("/api/")) {
    const path = route.path.replace(/^\/api\//, "/api/v0/");
    rows.push({ key: { method: route.method, path }, result: await execute(route.method, path, route.method === "GET" ? undefined : rich) });
  }
  await Bun.write(output!, JSON.stringify({ routes: routes.size, cases: rows.length, rows }, (_key, value) => typeof value === "bigint" ? { bigint: value.toString() } : value));
  console.log(JSON.stringify({ mode, routes: routes.size, cases: rows.length }));
} else {
  record = false;
  const targets = [
    { name: "bootstrap", method: "GET", path: "/api/client-bootstrap" },
    { name: "history", method: "GET", path: `/api/channels/${id}/history?limit=100` },
    { name: "send-message", method: "POST", path: `/api/channels/${id}/messages`, body: rich },
    { name: "unknown-route", method: "GET", path: "/api/not-a-route" },
  ];
  const results = [];
  for (const target of targets) {
    for (let i = 0; i < 1000; i++) await execute(target.method, target.path, target.body);
    const samples = [];
    for (let sample = 0; sample < 30; sample++) {
      const start = performance.now();
      for (let i = 0; i < 500; i++) await execute(target.method, target.path, target.body);
      samples.push((performance.now() - start) * 1000 / 500);
    }
    results.push({ name: target.name, unit: "microseconds/request", samples });
  }
  await Bun.write(output!, JSON.stringify({ results }));
  console.log(JSON.stringify({ operation, results: results.map(({name,samples}) => ({name,medianUs:[...samples].sort((a,b)=>a-b)[15]})) }));
}
