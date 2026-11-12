import { afterEach, expect, test } from "bun:test";
import { ScreenVncProxy, type VncConnection } from "../src/screen-vnc";
import { ScreenService } from "../src/services/screen-service";
import type { PrismaClient } from "@openteam/db";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture(mayInput?: (identity: import("../src/screen-vnc").VncIdentity) => Promise<boolean>) {
  let authorized = true;
  let now = Date.now();
  let upstreamCloses = 0;
  const activity: string[] = [];
  const upstreamMessages: number[][] = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: (request, server) => server.upgrade(request) ? undefined : new Response(null, { status: 400 }),
    websocket: {
      open: (ws) => { ws.send(new Uint8Array([82, 70, 66])); },
      message: (ws, message) => { if (typeof message !== "string") upstreamMessages.push([...new Uint8Array(message)]); ws.send(message); },
      close: () => { upstreamCloses++; },
    },
  });
  const proxy = new ScreenVncProxy({
    endpoint: async () => ({ url: `ws://127.0.0.1:${upstream.port}/websockify`, password: "vnc-test-only" }),
    authorized: async ({ botId, sessionId }) => authorized && botId === "bot-a" && sessionId === "session-a",
    now: () => now, recheckMs: 20, mayInput,
    onActivity: (botId) => { activity.push(botId); },
  });
  const server = Bun.serve<VncConnection>({ hostname: "127.0.0.1", port: 0, websocket: proxy.websocket,
    fetch: (request, server) => proxy.upgrade(request, server, new URL(request.url).pathname.slice(1)),
  });
  cleanups.push(() => { proxy.stop(); server.stop(true); upstream.stop(true); });
  return { proxy, server, activity, upstreamMessages, advance: (ms: number) => { now += ms; },
    revoke: () => { authorized = false; }, expire: () => { now += 30_001; },
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

test("computer status cannot select an arbitrary upstream port", async () => {
  const service = new ScreenService({ bot: { findUnique: async () => ({ id: "bot", status: "active", defaultDirectory: "/workspace" }) } } as unknown as PrismaClient,
    "/data", "advertised-host", async () => Response.json({ state: "ready", viewerPort: 5432, viewerPassword: "fixture-only" }), "http://computer:8790");
  await expect(service.vncEndpoint("bot")).rejects.toThrow("Computer is not ready");
});


test("VNC enforces the owning viewer generation across reconnects and transfers", async () => {
  let generation = 1;
  const f = fixture(async identity => identity.controlId === "desktop" && identity.generation === generation);
  const grant = await f.proxy.issue("bot-a", "session-a", null, {controlId:"desktop",generation:1});
  const socket = await connect(f, grant.protocols);
  await event(socket,"message");
  const handshake = Buffer.concat([Buffer.from("RFB 003.008\n"),Buffer.from([2]),Buffer.alloc(16),Buffer.from([1])]);
  const frame = Buffer.from([3,1,0,0,0,0,5,0,3,32]);
  const key = Buffer.from([4,1,0,0,0,0,0,97]);
  socket.send(Buffer.concat([handshake,frame,key]));
  for(let n=0;f.upstreamMessages.length<6 && n<50;n++)await Bun.sleep(5);
  expect(f.upstreamMessages.filter(bytes=>bytes[0]===4)).toHaveLength(1);
  generation=2;
  // Input coalesced behind viewing messages is rejected; viewing continues.
  socket.send(Buffer.concat([frame,key]));
  await Bun.sleep(20);
  expect(f.upstreamMessages.filter(bytes=>bytes[0]===4)).toHaveLength(1);
  expect(f.upstreamMessages.filter(bytes=>bytes[0]===3)).toHaveLength(2);
  const resumedGrant=await f.proxy.issue("bot-a","session-a",null,{controlId:"desktop",generation:2});
  const resumed=await connect(f,resumedGrant.protocols);await event(resumed,"message");
  resumed.send(Buffer.concat([handshake,frame,key]));await Bun.sleep(20);
  expect(f.upstreamMessages.filter(bytes=>bytes[0]===4)).toHaveLength(2);
  expect(f.activity).toEqual([]);
});
