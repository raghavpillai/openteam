import { afterEach, expect, test } from "bun:test";
import { RfbClientMessages } from "../src/rfb-client-messages";
import { ScreenVncProxy, type VncConnection, type VncIdentity } from "../src/screen-vnc";
const handshake = Buffer.concat([
  Buffer.from("RFB 003.008\n"),
  Buffer.from([2]),
  Buffer.alloc(16, 255),
  Buffer.from([1]),
]);
const frame = Buffer.from([3, 1, 0, 0, 0, 0, 5, 0, 3, 32]);
const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 97]);
const pointer = Buffer.from([5, 1, 0, 10, 0, 20]);
const seedBase = Number(process.env.CONTROL_CHAOS_SEED ?? 1);
if (!Number.isSafeInteger(seedBase) || seedBase < 1 || seedBase > 0xffffff00)
  throw new Error("CONTROL_CHAOS_SEED must be a positive 32-bit seed");
function rng(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 4294967296;
  };
}

test("chaos: seeded RFB fragmentation and coalescing preserve every input boundary", () => {
  let fragments = 0;
  for (let seed = seedBase; seed < seedBase + 128; seed++) {
    const random = rng(seed),
      parser = new RfbClientMessages();
    const packets = [
      ...Array.from({ length: 80 }, () => [frame, key, pointer][Math.floor(random() * 3)]!),
    ];
    const bytes = Buffer.concat([handshake, ...packets]);
    const decoded: ReturnType<RfbClientMessages["push"]> = [];
    for (let offset = 0; offset < bytes.length; ) {
      const length = 1 + Math.floor(random() * 80);
      decoded.push(...parser.push(bytes.subarray(offset, offset + length)));
      offset += length;
      fragments++;
    }
    expect(Buffer.concat(decoded.map((p) => p.data))).toEqual(bytes);
    expect(decoded.slice(4).map((p) => p.input)).toEqual(
      packets.map((p) => p[0] === 4 || p[0] === 5)
    );
  }
  console.log(
    JSON.stringify({ experiment: "rfb-framing-chaos", firstSeed: seedBase, seeds: 128, fragments })
  );
});
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});
function fixture(mayInput: (identity: VncIdentity) => Promise<boolean>) {
  const received: number[][] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (r, s) => (s.upgrade(r) ? undefined : new Response(null, { status: 400 })),
    websocket: {
      open: (ws) => {
        ws.send(Buffer.from("hello"));
      },
      message: (_ws, m) => {
        if (typeof m !== "string") received.push([...m]);
      },
    },
  });
  const proxy = new ScreenVncProxy({
    endpoint: async () => ({ url: `ws://127.0.0.1:${upstream.port}`, password: "fixture" }),
    authorized: async () => true,
    mayInput,
  });
  const server = Bun.serve<VncConnection>({
    hostname: "127.0.0.1",
    port: 0,
    websocket: proxy.websocket,
    fetch: (r, s) => proxy.upgrade(r, s, "bot"),
  });
  cleanup.push(() => {
    proxy.stop();
    server.stop(true);
    upstream.stop(true);
  });
  async function connect(id = "desktop", generation = 1) {
    const grant = await proxy.issue("bot", "fixture", null, { controlId: id, generation });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}`, grant.protocols);
    socket.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("message", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(Error("socket error")), { once: true });
    });
    cleanup.push(() => socket.close());
    return socket;
  }
  return { connect, received };
}
const waitUntil = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
};

test("chaos: disconnect while input authorization is delayed never replays the queued key", async () => {
  let resume!: () => void, started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  let paused = true;
  const f = fixture(async () => {
    if (paused) {
      started();
      await new Promise<void>((resolve) => {
        resume = resolve;
      });
    }
    return true;
  });
  const socket = await f.connect();
  socket.send(Buffer.concat([handshake, frame, key]));
  await waiting;
  const closed = new Promise<void>((resolve) =>
    socket.addEventListener("close", () => resolve(), { once: true })
  );
  socket.close();
  await closed;
  resume();
  paused = false;
  expect(f.received.filter((p) => p[0] === 4)).toHaveLength(0);
  const reconnected = await f.connect();
  reconnected.send(Buffer.concat([handshake, frame, key]));
  await waitUntil(() => f.received.filter((p) => p[0] === 4).length === 1);
});

test("chaos: a transfer during delayed authorization rejects the old viewer's input", async () => {
  let resume!: () => void,
    started!: () => void,
    generation = 1;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  let paused = true;
  const f = fixture(async (identity) => {
    if (paused) {
      started();
      await new Promise<void>((resolve) => {
        resume = resolve;
      });
    }
    return identity.generation === generation;
  });
  const old = await f.connect();
  old.send(Buffer.concat([handshake, frame, key]));
  await waiting;
  generation = 2;
  paused = false;
  resume();
  old.send(Buffer.concat([frame, key, frame]));
  // The trailing framebuffer request is an ordering barrier after both rejected keys.
  await waitUntil(() => f.received.filter((p) => p[0] === 3).length === 3);
  expect(f.received.filter((p) => p[0] === 4)).toHaveLength(0);
  const current = await f.connect("ios", 2);
  current.send(Buffer.concat([handshake, frame, key]));
  await waitUntil(() => f.received.filter((p) => p[0] === 4).length === 1);
});

test("chaos: an authorization-network failure closes input and a fresh connection can recover", async () => {
  let unavailable = true;
  const f = fixture(async () => {
    if (unavailable) throw Error("injected network partition");
    return true;
  });
  const disconnected = await f.connect();
  const closed = new Promise<void>((resolve) =>
    disconnected.addEventListener("close", () => resolve(), { once: true })
  );
  disconnected.send(Buffer.concat([handshake, frame, key]));
  await closed;
  expect(f.received.filter((p) => p[0] === 4)).toHaveLength(0);
  unavailable = false;
  const recovered = await f.connect();
  recovered.send(Buffer.concat([handshake, frame, key]));
  await waitUntil(() => f.received.filter((p) => p[0] === 4).length === 1);
});
