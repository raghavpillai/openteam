/** Isolated settings/plugin QA. Never authenticates with a provider or uses real accounts. */
const upstream = "http://127.0.0.1:20013";
const port = 20014;
const catalog = [
  { key: "qa-gmail", name: "Gmail", description: "Search, read, draft, and manage email." },
  { key: "qa-calendar", name: "Google Calendar", description: "Search events and schedule meetings." },
  { key: "qa-drive", name: "Google Drive", description: "Search, read, create, and share files." },
  { key: "qa-granola", name: "Granola", description: "Your meetings in your workflow." },
  { key: "qa-asana", name: "asana", description: "Asana project management integration." },
].map(p => ({ ...p, publisher: "OpenTeam QA", version: "1.0.0", setupFields: [], hasSkills: false }));
let installed = new Set<string>();
let status = "needs_auth";
let strictAccess = true;
let holdCatalog = false;
let holdConnect = false;
let loseDeleteResponse = false;
let failures: Record<string, number> = {};
let requests: { method: string; path: string; query: string; input: unknown }[] = [];
const connection = (key: string) => ({
  id: key + "-connection", revision: "1", pluginKey: key, connectorKey: "qa-connector",
  name: key === "qa-calendar" ? "Google Calendar" : "Gmail", alias: "QA account",
  transport: "http", auth: "oauth", status,
  statusMessage: status === "error" ? "Didn't finish connecting. Try signing in again." : null,
  instructions: "", canAuthenticate: true, configured: true, tools: [],
});
function settings() {
  return {
    catalog: catalog.map(p => ({ ...p, installed: installed.has(p.key) })),
    installs: catalog.filter(p => installed.has(p.key)).map(p => ({
      ...p, id: p.key + "-installation", pluginKey: p.key, status: "installed",
      connections: [connection(p.key)],
    })), policies: [], activity: [], botCount: 12,
  };
}
const server = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 40, async fetch(request) {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  const bytes = ["GET", "HEAD"].includes(method) ? undefined : await request.arrayBuffer();
  let input: any = {};
  try { if (bytes?.byteLength) input = JSON.parse(new TextDecoder().decode(bytes)); } catch {}
  if (path === "/__settings/reset") {
    installed = new Set(["qa-gmail"]);
    status = ["failed", "catalog-failed"].includes(input.scene) ? "error" : "needs_auth";
    if (["failed", "access", "authorize", "connect"].includes(input.scene)) installed.add("qa-calendar");
    strictAccess = input.strictAccess ?? true;
    holdCatalog = input.scene === "loading"; holdConnect = false; loseDeleteResponse = false; failures = {}; requests = [];
    await fetch(upstream + "/__qa/scene", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scene: "dark-home" }) });
    return Response.json({ ok: true });
  }
  if (path === "/__settings/control") {
    if (input.status) status = input.status;
    if (input.strictAccess !== undefined) strictAccess = input.strictAccess;
    if (input.holdCatalog !== undefined) holdCatalog = input.holdCatalog;
    if (input.holdConnect !== undefined) holdConnect = input.holdConnect;
    if (input.loseDeleteResponse !== undefined) loseDeleteResponse = input.loseDeleteResponse;
    if (input.failures) failures = input.failures;
    return Response.json({ ok: true });
  }
  if (path === "/__settings/state") return Response.json({ requests, settings: settings() });
  if (path === "/__settings/oauth") return new Response("<!doctype html><title>Isolated QA authorization</title><p>Inert authorization handoff. No credentials are requested and no provider is contacted. Return to OpenTeam Swift.</p>", { headers: { "content-type": "text/html" } });
  if (path.startsWith("/api/v0/plugin")) {
    requests.push({ method, path, query: url.search, input });
    const failure = method + " " + path;
    if (failures[failure]) { failures[failure]--; return Response.json({ message: "Isolated QA service unavailable. Please try again shortly." }, { status: 503 }); }
    if (path === "/api/v0/plugins") {
      while (holdCatalog) await Bun.sleep(30);
      return Response.json(settings());
    }
    if (path.endsWith("/bot-access")) {
      if (strictAccess && Number(url.searchParams.get("limit")) > 60) {
        return Response.json({ error: { code: "invalid_query_parameter", message: "limit is outside the supported range" } }, { status: 400 });
      }
      return Response.json({ pluginKey: "qa-calendar", total: 1, bots: [{ id: "visual-bot-0", name: "Memory Box 914", skillsEnabled: false, grantedConnectionIds: [] }] });
    }
    if (path === "/api/v0/plugins/install") {
      installed.add(input.pluginKey); return Response.json({ ok: true });
    }
    if (method === "DELETE" && /^\/api\/v0\/plugins\/[^/]+$/.test(path)) {
      const key = path.split("/").at(-1)!;
      if (!installed.has(key)) return Response.json({ error: { code: "plugin_not_installed", message: "Plugin not installed" } }, { status: 404 });
      installed.delete(key);
      if (loseDeleteResponse) {
        loseDeleteResponse = false;
        return Response.json({ message: "The uninstall completed, but the response was lost." }, { status: 503 });
      }
      return Response.json({ uninstalled: true });
    }
    if (path.endsWith("/authenticate")) return Response.json({ authorizationUrl: `http://127.0.0.1:${port}/__settings/oauth`, status: "needs_auth" });
    if (path.endsWith("/connect")) {
      while (holdConnect) await Bun.sleep(30);
      status = "ready"; return Response.json({ ok: true });
    }
    if (path.endsWith("/disconnect")) { status = "disconnected"; return Response.json({ ok: true }); }
  }
  return fetch(upstream + path + url.search, { method, headers: request.headers, body: bytes });
}});
console.log(`Settings/plugin audit fixture: http://127.0.0.1:${server.port}`);
