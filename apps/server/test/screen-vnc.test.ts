import { afterEach, expect, test } from "bun:test";
import { ScreenVncProxy, type VncConnection } from "../src/screen-vnc";
import { ScreenService } from "../src/services/screen-service";
import type { PrismaClient } from "@openteam/db";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture() {
  let authorized = true;
  let now = Date.now();
  let upstreamCloses = 0;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: (request, server) => server.upgrade(request) ? undefined : new Response(null, { status: 400 }),
    websocket: {
      open: (ws) => { ws.send(new Uint8Array([82, 70, 66])); },
      message: (ws, message) => { ws.send(message); },
      close: () => { upstreamCloses++; },
    },
  });
  const proxy = new ScreenVncProxy({
    endpoint: async () => ({ url: `ws://127.0.0.1:${upstream.port}/websockify`, password: "vnc-test-only" }),
    authorized: async ({ botId, sessionId }) => authorized && botId === "bot-a" && sessionId === "session-a",
    now: () => now, recheckMs: 20,
  });
  const server = Bun.serve<VncConnection>({ hostname: "127.0.0.1", port: 0, websocket: proxy.websocket,
    fetch: (request, server) => proxy.upgrade(request, server, new URL(request.url).pathname.slice(1)),
  });
  cleanups.push(() => { proxy.stop(); server.stop(true); upstream.stop(true); });
  return { proxy, server, revoke: () => { authorized = false; }, expire: () => { now += 30_001; },
    closes: () => upstreamCloses };
}
async function connect(f: ReturnType<typeof fixture>, protocols: string[], bot = "bot-a", origin?: string) {
  // Bun's client supports handshake headers; the DOM constructor type does not.
  const Client = WebSocket as unknown as new (url: string, options: { protocols: string[]; headers: Record<string, string> }) => WebSocket;
  const ws = new Client(`ws://127.0.0.1:${f.server.port}/${bot}`, { protocols, headers: origin ? { Origin: origin } : {} });
  ws.binaryType = "arraybuffer";
  cleanups.push(() => ws.close());
  return ws;
}
const event = <T extends Event>(socket: WebSocket, name: string) => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out: ${name}`)), 2000);
  socket.addEventListener(name, (e) => { clearTimeout(timer); resolve(e as T); }, { once: true });
});
async function denied(socket: WebSocket) {
  let opened = false;
  socket.addEventListener("open", () => { opened = true; });
  socket.addEventListener("error", () => {});
  await event(socket, "close");
  expect(opened).toBe(false);
}

test("VNC grants relay binary bytes bidirectionally and close the upstream", async () => {
  const f = fixture();
  const grant = await f.proxy.issue("bot-a", "session-a", null);
  expect(grant.path).not.toContain(grant.password);
  const socket = await connect(f, grant.protocols);
  const hello = await event<MessageEvent<ArrayBuffer>>(socket, "message");
  expect([...new Uint8Array(hello.data)]).toEqual([82, 70, 66]);
  const reply = event<MessageEvent<ArrayBuffer>>(socket, "message");
  socket.send(new Uint8Array([0, 255, 0, 128]));
  expect([...new Uint8Array((await reply).data)]).toEqual([0, 255, 0, 128]);
  socket.close();
  for (let n = 0; !f.closes() && n < 40; n++) await Bun.sleep(5);
  expect(f.closes()).toBe(1);
  await denied(await connect(f, grant.protocols));
});

test("missing, expired, wrong-bot, wrong-origin and revoked grants cannot connect", async () => {
  const f = fixture();
  await denied(await connect(f, ["openteam-vnc"]));
  let grant = await f.proxy.issue("bot-a", "session-a", null);
  await denied(await connect(f, grant.protocols, "bot-b"));
  grant = await f.proxy.issue("bot-a", "session-a", "https://desktop.test");
  await denied(await connect(f, grant.protocols, "bot-a", "https://untrusted.test"));
  grant = await f.proxy.issue("bot-a", "session-a", null);
  f.expire();
  await denied(await connect(f, grant.protocols));
  grant = await f.proxy.issue("bot-a", "session-a", null);
  f.revoke();
  await denied(await connect(f, grant.protocols));
  await expect(f.proxy.issue("bot-a", "session-a", null)).rejects.toThrow("Computer access denied");
});

test("sign-out closes an active viewer and retires pending grants", async () => {
  const f = fixture();
  const grant = await f.proxy.issue("bot-a", "session-a", null);
  const pending = await f.proxy.issue("bot-a", "session-a", null);
  const socket = await connect(f, grant.protocols);
  await event(socket, "message");
  const closed = event<CloseEvent>(socket, "close");
  f.proxy.revokeSession("session-a");
  expect((await closed).code).toBe(1008);
  await denied(await connect(f, pending.protocols));
});

test("packaged Electron fetch and WebSocket share an opaque origin", async () => {
  const f = fixture();
  const grant = await f.proxy.issue("bot-a", "session-a", "null");
  const socket = await connect(f, grant.protocols, "bot-a", "file://");
  await event(socket, "message");
  expect(socket.readyState).toBe(WebSocket.OPEN);
  const nativeGrant = await f.proxy.issue("bot-a", "session-a", null);
  const nativeSocket = await connect(f, nativeGrant.protocols, "bot-a", "file://");
  await event(nativeSocket, "message");
  expect(nativeSocket.readyState).toBe(WebSocket.OPEN);
  const browserGrant = await f.proxy.issue("bot-a", "session-a", "https://desktop.test");
  await denied(await connect(f, browserGrant.protocols, "bot-a", "file://"));
});

test("session expiry or bot archival closes an already-open viewer", async () => {
  const f = fixture();
  const socket = await connect(f, (await f.proxy.issue("bot-a", "session-a", null)).protocols);
  await event(socket, "message");
  const closed = event<CloseEvent>(socket, "close");
  f.revoke();
  expect((await closed).code).toBe(1008);
});

test("viewer limit rejects excess sockets and malformed input releases its slot", async () => {
  const f = fixture();
  const sockets: WebSocket[] = [];
  for (let n = 0; n < 3; n++) {
    const socket = await connect(f, (await f.proxy.issue("bot-a", "session-a", null)).protocols);
    await event(socket, "message");
    sockets.push(socket);
  }
  await denied(await connect(f, (await f.proxy.issue("bot-a", "session-a", null)).protocols));
  const closed = event<CloseEvent>(sockets[0]!, "close");
  sockets[0]!.send("not a binary RFB message");
  expect((await closed).code).toBe(1003);
  const replacement = await connect(f, (await f.proxy.issue("bot-a", "session-a", null)).protocols);
  await event(replacement, "message");
  expect(replacement.readyState).toBe(WebSocket.OPEN);
});

test("computer status cannot select an arbitrary upstream port", async () => {
  const service = new ScreenService({ bot: { findUnique: async () => ({ id: "bot", status: "active", defaultDirectory: "/workspace" }) } } as unknown as PrismaClient,
    "/data", "advertised-host", async () => Response.json({ state: "ready", viewerPort: 5432, viewerPassword: "fixture-only" }), "http://computer:8790");
  await expect(service.vncEndpoint("bot")).rejects.toThrow("Computer is not ready");
});

test("VNC upstream uses the configured computer, not the advertised browser host", async () => {
  const service = new ScreenService({ bot: { findUnique: async () => ({ id: "bot", status: "active", defaultDirectory: "/workspace" }) } } as unknown as PrismaClient,
    "/data", "untrusted-advertised-host", async () => Response.json({ state: "ready", viewerPort: 6213, viewerPassword: "fixture-only" }), "http://computer:8790");
  expect(await service.vncEndpoint("bot")).toEqual({ url: "ws://computer:6213/websockify", password: "fixture-only" });
});
