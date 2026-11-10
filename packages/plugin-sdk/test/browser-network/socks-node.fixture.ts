// Real TCP on loopback, run in Node as well as Bun's surrounding test suite.
import assert from "node:assert/strict";
import { createConnection, createServer, type Socket } from "node:net";
import { PassThrough, type Duplex } from "node:stream";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createBrowserProxy } from "../../src/browser-network/socks";

const greeting = Buffer.from([5, 1, 0]);
const ipv4 = Buffer.from([5, 1, 0, 1, 1, 1, 1, 1, 0, 80]);
const request = Buffer.concat([greeting, ipv4]);
let offered = 0;
const results: Array<{ name: string; durationMs: number }> = [];
async function waitFor(test: () => boolean, message: string, timeout = 5000) {
  const until = performance.now() + timeout;
  while (!test()) {
    assert(performance.now() < until, message);
    await delay(5);
  }
}
async function check(name: string, fn: () => Promise<void>) {
  if (process.argv.includes("--half-close") && !name.startsWith("pipelined payload")) return;
  const start = performance.now();
  await fn();
  results.push({ name, durationMs: Math.round(performance.now() - start) });
  console.error(`PASS ${name}`);
}
type Client = { socket: Socket; bytes: Buffer; closed: boolean };
async function client(port: number, bytes?: Buffer, fin = false): Promise<Client> {
  offered++;
  const socket = createConnection({ host: "127.0.0.1", port });
  const value: Client = { socket, bytes: Buffer.alloc(0), closed: false };
  socket.on("data", (chunk) => {
    value.bytes = Buffer.concat([value.bytes, chunk]);
  });
  socket.on("close", () => {
    value.closed = true;
  });
  socket.on("error", () => {});
  await new Promise<void>((resolve) => {
    socket.once("connect", () => {
      if (fin) socket.end(bytes ?? Buffer.alloc(0));
      else if (bytes) socket.write(bytes);
      resolve();
    });
    socket.once("error", () => resolve());
  });
  return value;
}
async function take(value: Client, length: number) {
  await waitFor(() => value.bytes.length >= length || value.closed, "missing SOCKS/data reply");
  assert(
    value.bytes.length >= length,
    `connection closed with ${value.bytes.length}/${length} bytes`
  );
  const bytes = value.bytes.subarray(0, length);
  value.bytes = value.bytes.subarray(length);
  return bytes;
}
async function ready(value: Client) {
  const reply = await take(value, 12);
  assert.deepEqual([...reply.subarray(0, 4)], [5, 0, 5, 0]);
}
async function fixture(limit = 80, open?: (standard: () => Promise<Duplex>) => Promise<Duplex>) {
  const peers = new Set<Socket>(),
    downstream = new Set<Socket>(),
    upstream = new Set<Duplex>();
  const calls: Array<[string, number]> = [];
  const target = createServer({ allowHalfOpen: true }, (socket) => {
    peers.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => peers.delete(socket));
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetPort = (target.address() as { port: number }).port;
  const standard = async () => {
    const socket = createConnection({ host: "127.0.0.1", port: targetPort, allowHalfOpen: true });
    socket.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return socket;
  };
  const proxy = createBrowserProxy(async (host, port) => {
    calls.push([host, port]);
    const socket = await (open ? open(standard) : standard());
    socket.on("error", () => {});
    upstream.add(socket);
    socket.once("close", () => upstream.delete(socket));
    return socket;
  }, limit);
  proxy.server.on("connection", (socket) => {
    downstream.add(socket);
    socket.once("close", () => downstream.delete(socket));
  });
  const port = await proxy.listen(0);
  const drain = async () => {
    for (const socket of upstream) socket.destroy();
    for (const socket of downstream) socket.destroy();
    await waitFor(
      () => !downstream.size && !peers.size && !upstream.size,
      "TCP sockets did not drain"
    );
  };
  return {
    port,
    calls,
    downstream,
    upstream,
    peers,
    drain,
    async close() {
      await proxy.close();
      for (const socket of peers) socket.destroy();
      await new Promise<void>((resolve) => target.close(() => resolve()));
      await waitFor(
        () => !downstream.size && !upstream.size && !peers.size,
        "shutdown leaked sockets"
      );
    },
  };
}
async function burst(f: Awaited<ReturnType<typeof fixture>>, count: number) {
  const start = f.calls.length;
  const clients = await Promise.all(Array.from({ length: count }, () => client(f.port, request)));
  await waitFor(
    () => clients.every((c) => c.closed || c.bytes.length >= 12),
    "burst did not settle"
  );
  const accepted = clients.filter((c) => c.bytes.length >= 12 && c.bytes[3] === 0).length;
  assert.equal(f.calls.length - start, accepted, "rejected clients must never open an upstream");
  await f.drain();
  for (const c of clients) c.socket.destroy();
  return accepted;
}

if (process.argv.includes("--baseline")) {
  const f = await fixture();
  try {
    const admitted = [];
    for (let i = 0; i < 3; i++) admitted.push(await burst(f, 100));
    assert.deepEqual(admitted, [80, 60, 20]);
    console.log(JSON.stringify({ runtime: process.version, baselineReproduced: true, admitted }));
  } finally {
    await f.close();
  }
} else {
  await check("24 overflow bursts retain all 80 slots and leave zero TCP sockets", async () => {
    const f = await fixture();
    try {
      for (let round = 0; round < 24; round++) {
        const count = [81, 100, 128, 160, 96, 256][round % 6]!;
        assert.equal(await burst(f, count), 80, `capacity lost in round ${round}`);
      }
    } finally {
      await f.close();
    }
  });
  await check("limits 1, 2 and 8 recover after repeated rejection", async () => {
    for (const limit of [1, 2, 8]) {
      const f = await fixture(limit);
      try {
        for (let round = 0; round < 4; round++) assert.equal(await burst(f, limit + 10), limit);
      } finally {
        await f.close();
      }
    }
  });
  await check("abandoned greetings and partial requests immediately return all slots", async () => {
    const f = await fixture(8);
    try {
      for (const prefix of [
        Buffer.alloc(0),
        Buffer.from([5]),
        greeting,
        Buffer.concat([greeting, ipv4.subarray(0, 6)]),
      ]) {
        const clients = await Promise.all(Array.from({ length: 8 }, () => client(f.port, prefix)));
        await waitFor(() => f.downstream.size === 8, "clients were not admitted");
        const start = performance.now();
        for (const c of clients) c.socket.end();
        await waitFor(() => !f.downstream.size, "abandoned client retained a slot", 1000);
        assert(performance.now() - start < 1000);
        assert.equal(f.calls.length, 0);
        assert.equal(await burst(f, 12), 8);
        f.calls.length = 0;
      }
    } finally {
      await f.close();
    }
  });
  await check(
    "fragmented IPv4, IPv6 and domain CONNECT requests preserve destination",
    async () => {
      const f = await fixture(1);
      const domain = Buffer.from("example.com");
      const variants: Array<[Buffer, string]> = [
        [ipv4, "1.1.1.1"],
        [Buffer.from("0501000420010db80000000000000000000000010050", "hex"), "2001:db8::1"],
        [
          Buffer.concat([Buffer.from([5, 1, 0, 3, domain.length]), domain, Buffer.from([0, 80])]),
          "example.com",
        ],
      ];
      try {
        for (const [frame, host] of variants) {
          const c = await client(f.port);
          for (const byte of Buffer.concat([greeting, frame])) {
            c.socket.write(Buffer.from([byte]));
            await delay(1);
          }
          await ready(c);
          assert.deepEqual(f.calls.at(-1), [host, 80]);
          c.socket.write("fragmented-ok");
          assert.equal((await take(c, 13)).toString(), "fragmented-ok");
          await f.drain();
          c.socket.destroy();
        }
      } finally {
        await f.close();
      }
    }
  );
  await check(
    "pipelined payload plus client FIN survives a delayed upstream without replay",
    async () => {
      const f = await fixture(1, async (standard) => {
        await delay(30);
        return standard();
      });
      try {
        for (const length of [0, 32768]) {
          const payload = randomBytes(length);
          const c = await client(f.port, Buffer.concat([request, payload]), true);
          await waitFor(() => c.closed, "half-closed request did not complete");
          assert.deepEqual(c.bytes.subarray(0, 4), Buffer.from([5, 0, 5, 0]));
          assert.deepEqual(c.bytes.subarray(12), payload);
          await f.drain();
        }
        assert.equal(f.calls.length, 2, "requests must not be replayed");
      } finally {
        await f.close();
      }
    }
  );
  await check("512 KiB stream survives client half-close with exact bytes", async () => {
    const f = await fixture(1);
    try {
      const c = await client(f.port, request);
      await ready(c);
      const payload = randomBytes(512 * 1024);
      c.socket.end(payload);
      await waitFor(() => c.closed, "stream did not finish");
      assert.deepEqual(c.bytes, payload);
      assert.equal(f.calls.length, 1);
    } finally {
      await f.close();
    }
  });
  await check(
    "malformed and unsupported SOCKS frames release capacity without a dial",
    async () => {
      const f = await fixture(1);
      const malformed = [
        Buffer.from([4, 1, 0]),
        Buffer.from([5, 1, 2]),
        Buffer.concat([greeting, Buffer.from([5, 2, 0, 1, 1, 1, 1, 1, 0, 80])]),
        Buffer.concat([greeting, Buffer.from([5, 1, 0, 9])]),
        Buffer.concat([greeting, Buffer.from([5, 1, 0, 3, 0])]),
        Buffer.concat([greeting, Buffer.from([5, 1, 0, 3, 1, 255, 0, 80])]),
        Buffer.concat([greeting, Buffer.from([5, 1, 0, 1, 1, 1, 1, 1, 0, 0])]),
        Buffer.alloc(65537, 5),
      ];
      try {
        for (const bytes of malformed) {
          const c = await client(f.port, bytes);
          await waitFor(() => c.closed, "invalid request stayed open");
          await waitFor(() => !f.downstream.size, "invalid request retained capacity");
          assert.equal(f.calls.length, 0);
        }
        assert.equal(await burst(f, 3), 1);
      } finally {
        await f.close();
      }
    }
  );
  await check("upstream dial failures recover without poisoning admission", async () => {
    let fail = true;
    const f = await fixture(8, async (standard) => {
      if (fail) throw new Error("synthetic dial failure");
      return standard();
    });
    try {
      for (let round = 0; round < 5; round++) {
        const clients = await Promise.all(Array.from({ length: 8 }, () => client(f.port, request)));
        await waitFor(() => clients.every((c) => c.closed), "failure reply did not close");
        assert(clients.every((c) => c.bytes[3] === 1));
        await waitFor(() => !f.downstream.size, "dial failure retained a slot");
      }
      fail = false;
      assert.equal(await burst(f, 16), 8);
    } finally {
      await f.close();
    }
  });
  await check("rejection bursts and client resets preserve an established stream", async () => {
    const f = await fixture(2);
    try {
      const healthy = await client(f.port, request),
        other = await client(f.port, request);
      await ready(healthy);
      await ready(other);
      const rejected = await Promise.all(
        Array.from({ length: 100 }, () => client(f.port, request))
      );
      await waitFor(() => rejected.every((c) => c.closed), "overflow clients were not rejected");
      assert.equal(f.calls.length, 2);
      healthy.socket.write("still-healthy");
      assert.equal((await take(healthy, 13)).toString(), "still-healthy");
      other.socket.resetAndDestroy();
      await waitFor(() => f.downstream.size === 1, "reset did not release a slot");
      const next = await client(f.port, request);
      await ready(next);
      healthy.socket.write("still-healthy");
      assert.equal((await take(healthy, 13)).toString(), "still-healthy");
      await f.drain();
      healthy.socket.destroy();
      next.socket.destroy();
    } finally {
      await f.close();
    }
  });
  await check(
    "real 30s pending-dial timeout releases slots and destroys late upstreams",
    async () => {
      let pending = true;
      const completions: Array<(stream: Duplex) => void> = [];
      const f = await fixture(2, (standard) =>
        pending ? new Promise((resolve) => completions.push(resolve)) : standard()
      );
      try {
        const start = performance.now();
        const clients = await Promise.all([client(f.port, request), client(f.port, request)]);
        await waitFor(() => completions.length === 2, "pending opens were not created");
        const overflow = await client(f.port, request);
        await waitFor(() => overflow.closed, "pending opens did not enforce capacity");
        await waitFor(
          () => clients.every((c) => c.closed) && !f.downstream.size,
          "real handshake deadline did not release slots",
          33000
        );
        assert(performance.now() - start >= 29000, "real timeout must not be replaced with a mock");
        const late = completions.map((resolve) => {
          const stream = new PassThrough();
          resolve(stream);
          return stream;
        });
        await waitFor(() => late.every((s) => s.destroyed), "late upstream leaked after timeout");
        pending = false;
        assert.equal(await burst(f, 4), 2);
      } finally {
        await f.close();
      }
    }
  );
  await check("shutdown closes admitted clients and disposes of late pending dials", async () => {
    const completions: Array<(stream: Duplex) => void> = [];
    const f = await fixture(2, () => new Promise((resolve) => completions.push(resolve)));
    const clients = await Promise.all([client(f.port, request), client(f.port, request)]);
    await waitFor(() => completions.length === 2, "pending opens missing");
    await f.close();
    await waitFor(() => clients.every((c) => c.closed), "shutdown left clients open");
    const late = completions.map((resolve) => {
      const stream = new PassThrough();
      resolve(stream);
      return stream;
    });
    await waitFor(() => late.every((s) => s.destroyed), "shutdown leaked a late upstream");
  });
  console.log(
    JSON.stringify({
      runtime: process.version,
      passed: results.length,
      offeredConnections: offered,
      results,
    })
  );
}
