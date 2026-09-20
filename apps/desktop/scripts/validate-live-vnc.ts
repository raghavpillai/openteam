// Opt-in: uses only the existing test bot's computer, with an isolated local QA login.
// The main server's owner credentials and authentication settings are untouched.
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { corsHeaders } from "../../server/src/http";
import { build } from "vite";
import { ScreenVncProxy, type VncConnection } from "../../server/src/screen-vnc";
if (process.env.OPENTEAM_VNC_QA !== "1") throw new Error("Set OPENTEAM_VNC_QA=1 for the dedicated parity test bot");
const botId = "37e59edd-b2a3-4ba8-a17e-414fcac5728e";
const root = resolve(import.meta.dir, "..");
const output = resolve(root, "../../output/research/desktop-vnc-2026-09-19/live");
await mkdir(output, { recursive: true });
// Private transport credentials remain in process memory and are never logged.
const lookup = Bun.spawn(["docker", "exec", "openteam-worker-1", "node", "-e",
  `fetch(process.env.OPENTEAM_COMPUTER_URL+'/v1/screens/${botId}?cwd=%2Fworkspace',{headers:{authorization:'Bearer '+process.env.OPENTEAM_CONTROL_TOKEN}}).then(async r=>{if(!r.ok)throw Error('Status failed');process.stdout.write(JSON.stringify(await r.json()))})`], { stdout: "pipe", stderr: "pipe" });
const status = JSON.parse(await new Response(lookup.stdout).text());
if (await lookup.exited || status.state !== "ready") throw new Error("Test computer unavailable");
const token = crypto.randomUUID();
const json = (value: unknown, init?: ResponseInit) => Response.json(value, { ...init, headers: { ...corsHeaders, ...init?.headers } });
const proxy = new ScreenVncProxy({
  endpoint: async () => ({ url: `ws://127.0.0.1:${status.viewerPort}/websockify`, password: status.viewerPassword }),
  authorized: async (identity) => identity.botId === botId && identity.sessionId === "qa-session",
});
let grants = 0;
let frameRequests = 0;
const latency: { kind: string; milliseconds: number }[] = [];
const view = { ...status, viewerUrl: "" };
delete view.viewerPassword;
delete view.viewerPort;
const user = { id: "qa", name: "QA", username: "qa", email: "qa@example.test" };
const server = Bun.serve<VncConnection>({ hostname: "127.0.0.1", port: 0, websocket: proxy.websocket,
  async fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/screen/vnc")) console.log("VNC_ORIGIN", JSON.stringify({ method: request.method, origin: request.headers.get("origin") }));
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    if (path === "/__qa/config") return json({ botId });
    if (path === "/__qa/disconnect" && request.method === "POST") { proxy.stop(); return json({ ok: true }); }
    if (path === "/__qa/latency" && request.method === "POST") { latency.push(await request.json()); return new Response(null, { status: 204, headers: corsHeaders }); }
    if (path === "/__qa/results") return json({ grants, frameRequests, latency });
    if (path === "/api/auth/login") return json({ user }, { headers: { "set-auth-token": token } });
    if (path.endsWith("/screen/vnc") && request.method === "GET") return proxy.upgrade(request, server, botId);
    if (path.startsWith("/api/")) {
      if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 401, headers: corsHeaders });
      if (path === "/api/auth/get-session") return json({ session: { id: "qa-session" }, user });
      if (path.endsWith("/screen/vnc")) { grants++; return json(await proxy.issue(botId, "qa-session", request.headers.get("origin"))); }
      if (path.endsWith("/screen") || path.endsWith("/screen/takeover")) return json(view);
      if (path.endsWith("/screen/frame")) { frameRequests++; return new Response(null, { status: 503 }); }
      if (path.includes("computer-handoff")) return json({ accepted: true });
      return new Response(null, { status: 404 });
    }
    const filename = resolve(output, "dist", "." + path);
    if (!filename.startsWith(resolve(output, "dist") + "/")) return new Response(null, { status: 403 });
    const file = Bun.file(filename);
    return await file.exists() ? new Response(file) : new Response(null, { status: 404 });
  },
});
await build({ root, configFile: resolve(root, "vite.config.ts"), logLevel: "error", define: { "import.meta.env.VITE_OPENTEAM_API_URL": JSON.stringify(server.url.origin) }, build: {
  outDir: resolve(output, "dist"), emptyOutDir: true,
  rolldownOptions: { input: resolve(root, "test/browser/vnc-reference.html") },
} });
const electron = Bun.spawn([createRequire(import.meta.url)("electron"), resolve(root, "test/browser/vnc-reference-runner.cjs")], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VNC_QA_PROFILE: resolve(output, "profile"),
    VNC_QA_URL: pathToFileURL(resolve(output, "dist/test/browser/vnc-reference.html")).href }, stdout: "inherit", stderr: "inherit",
});
console.log("Live VNC QA:", server.url.toString());
const stop = () => { proxy.stop(); server.stop(true); electron.kill(); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try { await electron.exited; }
finally { proxy.stop(); server.stop(true); console.log(JSON.stringify({ grants, frameRequests, latency })); }
