// Real loopback TCP resets, TLS auth requests, and the production Node SOCKS/client path.
// This uses disposable fixture credentials and never contacts 1Password or any external host.
import assert from "node:assert/strict";
import { createConnection, createServer, type Socket, type AddressInfo } from "node:net";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { BrowserNetworkClient } from "../../src/browser-network/client";
import { createBrowserProxy } from "../../src/browser-network/socks";
import { createNetworkDiagnostics } from "../../src/browser-network/diagnostics";
import { NetworkMux } from "../../src/browser-network/mux";
import { NETWORK_PROTOCOL, type NetworkRoute } from "../../src/browser-network/protocol";

const [cert, key, skill] = process.argv.slice(2) as [string, string, string];
const logs: string[] = [],
  sockets = new Set<Socket>();
const report = createNetworkDiagnostics("computer", (line) => logs.push(line));
const route: NetworkRoute = {
  deploymentId: crypto.randomUUID(),
  revision: 1,
  mode: "server",
  machineId: null,
  sourceOrder: ["server"],
  epoch: crypto.randomUUID(),
  available: true,
};
const control = new WebSocketServer({
  host: "127.0.0.1",
  port: 0,
  handleProtocols: () => NETWORK_PROTOCOL,
});
await new Promise<void>((resolve) => control.once("listening", resolve));
let mux: NetworkMux | undefined,
  resets = 0,
  offers = 0,
  authRequests = 0;
const track = (socket: Socket) => {
  sockets.add(socket);
  socket.on("error", () => {});
  socket.once("close", () => sockets.delete(socket));
};
const auth = createHttpsServer(
  { cert: readFileSync(cert), key: readFileSync(key) },
  (request, response) => {
    assert.equal(request.url, "/api/v3/auth/start");
    authRequests++;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify([
        {
          id: "fixture-item",
          vault: { id: "fixture-vault" },
          title: "Fixture login",
          urls: [{ href: "https://example.com" }],
        },
      ])
    );
  }
);
auth.on("connection", track);
const endpoint = createServer((socket) => {
  track(socket);
  offers++;
  if (resets > 0) {
    resets--;
    // Send a kernel RST after the TLS client has sent bytes, rather than injecting an Error.
    socket.once("data", () => socket.resetAndDestroy());
    return;
  }
  const upstream = createConnection({
    host: "127.0.0.1",
    port: (auth.address() as AddressInfo).port,
  });
  track(upstream);
  socket.once("close", () => upstream.destroy());
  upstream.once("close", () => socket.destroy());
  socket.pipe(upstream).pipe(socket);
});
const echo = createServer({ allowHalfOpen: true }, (socket) => {
  track(socket);
  socket.pipe(socket);
});
control.on("connection", (socket) => {
  mux = new NetworkMux(
    {
      send: (bytes) => {
        socket.send(bytes);
      },
      close: () => socket.terminate(),
      get bufferedAmount() {
        return socket.bufferedAmount;
      },
    },
    {
      control: (message) => {
        if (message.op === "lease") mux!.control({ op: "lease", nonce: message.nonce, route });
      },
    }
  );
  socket.on("message", (bytes) => mux!.receive(Buffer.from(bytes as Buffer)));
  socket.on("close", () => mux?.close());
});
const client = new BrowserNetworkClient({
  role: "computer",
  headers: { authorization: "Bearer fixture-control-secret" },
  url: `ws://127.0.0.1:${(control.address() as AddressInfo).port}`,
  diagnostic: report,
});
let proxy: ReturnType<typeof createBrowserProxy> | undefined;
async function until(check: () => boolean) {
  const deadline = performance.now() + 5000;
  while (!check()) {
    assert(performance.now() < deadline, "local fixture did not settle");
    await delay(5);
  }
}
async function listen(
  server: ReturnType<typeof createServer> | ReturnType<typeof createHttpsServer>
) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}
function read(socket: Socket, size: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("fixture read timeout")), 5000);
    const ready = () => {
      const bytes = socket.read(size);
      if (bytes) finish(undefined, bytes);
    };
    const closed = () => finish(new Error("fixture connection closed"));
    const finish = (error?: Error, bytes?: Buffer) => {
      clearTimeout(timer);
      socket.off("readable", ready);
      socket.off("close", closed);
      error ? reject(error) : resolve(bytes!);
    };
    socket.on("readable", ready);
    socket.once("close", closed);
    ready();
  });
}
async function open(proxyPort: number, targetPort: number) {
  const socket = createConnection({ host: "127.0.0.1", port: proxyPort });
  track(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const request = Buffer.from([5, 1, 0, 5, 1, 0, 1, 127, 0, 0, 1, 0, 0]);
  request.writeUInt16BE(targetPort, 11);
  socket.write(request);
  assert.deepEqual([...(await read(socket, 12)).subarray(0, 4)], [5, 0, 5, 0]);
  return socket;
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function lookup(command: string, proxyPort: number) {
  const child = spawn(
    "bash",
    [
      "-c",
      `
    lookup() { curl --fail --silent --show-error --max-time 5 --noproxy '' \
      --proxy ${quote(`socks5h://127.0.0.1:${proxyPort}`)} --cacert ${quote(cert)} \
      -H 'authorization: Bearer fixture-vault-secret' -X POST \
      ${quote(`https://127.0.0.1:${(endpoint.address() as AddressInfo).port}/api/v3/auth/start`)}; }
    ${command.replace("<op>", "lookup")}
  `,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (bytes) => {
    stdout += bytes;
  });
  child.stderr.on("data", (bytes) => {
    stderr += bytes;
  });
  const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
  return { code, stdout, stderr };
}
try {
  await listen(auth);
  await listen(endpoint);
  await listen(echo);
  proxy = createBrowserProxy((host, port, signal) => client.open(host, port, signal), 2, report);
  const proxyPort = await proxy.listen(0);
  client.start();
  await until(() => client.available());
  const command = readFileSync(skill, "utf8").match(/Logins for a site: `([^`]+)`/)![1]!;
  resets = 1;
  const baseline = await lookup(command.replace("set -o pipefail; ", ""), proxyPort);
  assert.equal(baseline.code, 0, "the original pipeline should reproduce the masked failure");
  assert.notEqual(baseline.stderr, "");
  assert.equal(baseline.stdout, "");
  resets = 1;
  const failed = await lookup(command, proxyPort);
  assert.notEqual(failed.code, 0, "the documented lookup must preserve a real transport failure");
  await delay(2000);
  const recovered = await lookup(command, proxyPort);
  assert.equal(recovered.code, 0);
  assert.match(recovered.stdout, /fixture-item\tfixture-vault\tFixture login/);
  assert.equal(offers, 3, "failed requests must not be automatically replayed");
  assert.equal(authRequests, 1);
  assert(
    logs.some((line) => {
      const event = JSON.parse(line);
      return (
        event.event === "computer_network.proxy_socket_error" &&
        event.side === "upstream" &&
        event.code === "ECONNRESET"
      );
    })
  );
  await until(() => client.status().activeConnections === 0);

  const echoPort = (echo.address() as AddressInfo).port;
  const first = await open(proxyPort, echoPort),
    second = await open(proxyPort, echoPort);
  const rejected = createConnection({ host: "127.0.0.1", port: proxyPort });
  track(rejected);
  await new Promise<void>((resolve) => rejected.once("close", resolve));
  assert(logs.some((line) => JSON.parse(line).event === "computer_network.proxy_capacity"));
  first.destroy();
  second.destroy();
  await until(() => client.status().activeConnections === 0);
  const pending = await open(proxyPort, echoPort);
  pending.write("before");
  assert.equal((await read(pending, 6)).toString(), "before");
  const previous = route.epoch;
  const closed = new Promise<void>((resolve) => pending.once("close", resolve));
  route.epoch = crypto.randomUUID();
  mux!.control({ op: "invalidate" });
  await closed;
  await until(() => client.available() && client.route?.epoch === route.epoch);
  assert(
    logs.some((line) => {
      const event = JSON.parse(line);
      return (
        event.event === "computer_network.route_fenced" &&
        event.reason === "route_invalidated" &&
        event.epoch === previous &&
        event.activeConnections === 1
      );
    })
  );
  const fresh = await open(proxyPort, echoPort);
  fresh.write("after");
  assert.equal((await read(fresh, 5)).toString(), "after");
  fresh.destroy();
  assert(!logs.join("").includes("fixture-vault-secret"));
  assert(!logs.join("").includes("fixture-control-secret"));
  assert(!logs.join("").includes("/api/v3/auth/start"));
  console.log(
    JSON.stringify({
      runtime: process.version,
      kernelResetReproduced: true,
      baselineMaskedExit: baseline.code,
      propagatedFailureExit: failed.code,
      readRetryRecovered: true,
      authRequests,
      connectionOffers: offers,
      capacityRecovered: true,
      routeFenceRecovered: true,
      credentialFreeLogs: true,
    })
  );
} finally {
  client.stop();
  await proxy?.close();
  for (const socket of sockets) socket.destroy();
  for (const socket of control.clients) socket.terminate();
  await Promise.all(
    [auth, endpoint, echo].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve()))
    )
  );
  await new Promise<void>((resolve) => control.close(() => resolve()));
}
