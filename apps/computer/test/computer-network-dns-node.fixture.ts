import assert from "node:assert/strict";
import { createServer } from "node:https";
import { createConnection } from "node:net";
import { readFileSync } from "node:fs";
import { createDnsExchange } from "../src/computer-network-dns";

const query = Buffer.from("007b01000001000000000000076578616d706c6503636f6d0000010001", "hex");
let behavior = "ok",
  requests = 0,
  calls = 0,
  pending = 0,
  peak = 0,
  key: string | null = "first";
const held: Array<() => void> = [];
const server = createServer(
  { cert: readFileSync(process.argv[2]!), key: readFileSync(process.argv[3]!) },
  (req, res) => {
    requests++;
    assert.equal(req.url, "/dns-query");
    assert.equal(req.headers.host, "cloudflare-dns.com");
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const answer = Buffer.concat(chunks);
      answer[2] = 0x81;
      answer[3] = 0x80;
      const send = () => {
        if (behavior === "reset") {
          res.destroy();
          return;
        }
        if (behavior === "redirect") {
          res.writeHead(302, { location: "https://invalid.test" });
          res.end();
          return;
        }
        if (behavior === "close") res.setHeader("connection", "close");
        res.writeHead(200, {
          "content-type": behavior === "html" ? "text/html" : "application/dns-message",
        });
        if (behavior === "wrong-id") answer[0] = 1;
        res.end(behavior === "huge" ? Buffer.alloc(65536) : answer);
      };
      if (behavior === "hold") held.push(send);
      else send();
    });
  }
);
server.on("secureConnection", (socket) =>
  assert.equal((socket as any).servername, "cloudflare-dns.com")
);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as import("node:net").AddressInfo).port;
const client = {
  open: async (host: string, destinationPort: number, signal?: AbortSignal) => {
    assert.equal(host, "1.1.1.1");
    assert.equal(destinationPort, 443);
    calls++;
    pending++;
    peak = Math.max(peak, pending);
    await new Promise((resolve) => setTimeout(resolve, 5));
    pending--;
    signal?.throwIfAborted();
    return createConnection({ host: "127.0.0.1", port });
  },
};
const exchange = createDnsExchange(client, { routeKey: () => key, timeoutMs: 300 });
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(check());
};
try {
  for (let i = 0; i < 8; i++) assert.equal((await exchange(query)).readUInt16BE(0), 123);
  assert.equal(calls, 1);
  const batch = await Promise.all(Array.from({ length: 30 }, () => exchange(query)));
  assert.equal(batch.length, 30);
  assert.ok(calls <= 2);
  assert.ok(peak <= 2);
  behavior = "hold";
  const stale = exchange(query);
  const rejection = assert.rejects(stale, /route changed/);
  await until(() => held.length > 0);
  key = "second";
  exchange.syncRoute();
  await rejection;
  behavior = "ok";
  held.splice(0).forEach((send) => send());
  assert.equal((await exchange(query)).readUInt16BE(0), 123);
  assert.ok(calls >= 3);
  const before = calls;
  key = null;
  exchange.syncRoute();
  await assert.rejects(exchange(query), /route unavailable/);
  assert.equal(calls, before);
  key = "third";
  for (const mode of ["redirect", "html", "wrong-id", "huge", "reset"]) {
    behavior = mode;
    const count = requests;
    await assert.rejects(exchange(query));
    assert.equal(requests, count + 1, "sent DNS must not be replayed");
  }
  behavior = "close";
  await exchange(query);
  await exchange(query);
  behavior = "hold";
  const timeouts = await Promise.allSettled(Array.from({ length: 4 }, () => exchange(query)));
  assert.ok(timeouts.every((value) => value.status === "rejected"));
  behavior = "ok";
  held.splice(0).forEach((send) => send());
  assert.equal((await exchange(query)).readUInt16BE(0), 123);
  const signals: AbortSignal[] = [];
  const releases: Array<(socket: any) => void> = [];
  const delayed = createDnsExchange(
    {
      open: (_h, _p, signal) => {
        signals.push(signal!);
        return new Promise((resolve) => releases.push(resolve));
      },
    },
    { timeoutMs: 40 }
  );
  const timed = await Promise.allSettled(Array.from({ length: 4 }, () => delayed(query)));
  assert.ok(timed.every((value) => value.status === "rejected"));
  assert.ok(signals.every((signal) => signal.aborted));
  let destroyed = 0;
  releases.forEach((release) =>
    release({
      destroy() {
        destroyed++;
      },
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(destroyed, releases.length);
  delayed.close();
  const never = createDnsExchange({ open: () => new Promise(() => {}) }, { timeoutMs: 50 });
  const saturated = Array.from({ length: 64 }, () => never(query));
  await assert.rejects(never(query), /capacity/);
  never.close();
  assert.ok((await Promise.allSettled(saturated)).every((value) => value.status === "rejected"));
  exchange.close();
  await assert.rejects(exchange(query), /unavailable/);
  console.log(JSON.stringify({ passed: true, calls, requests, peakDials: peak }));
} finally {
  exchange.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
