import { expect, test } from "bun:test";
import { createConnection, createServer, type AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import {
  createNetworkDiagnostics,
  networkErrorCode,
  sanitizeNetworkDiagnostic,
  type NetworkDiagnostic,
} from "../../src/browser-network/diagnostics";
import { createBrowserProxy } from "../../src/browser-network/socks";
import { dialTarget, NetworkError } from "../../src/browser-network/policy";

test("failed destination dialing preserves the original socket code", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  let failure: unknown;
  try {
    await dialTarget(
      { host: "127.0.0.1", port, epoch: crypto.randomUUID() },
      new AbortController().signal
    );
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(NetworkError);
  expect((failure as NetworkError).code).toBe("connect_failed");
  expect(networkErrorCode(failure)).toBe("ECONNREFUSED");
});

test("diagnostics retain reset provenance and reject credential-bearing fields", () => {
  const lines: string[] = [];
  const report = createNetworkDiagnostics("computer", (line) => lines.push(line));
  const error = new NetworkError("connect_failed", {
    cause: Object.assign(new Error("Bearer fixture-secret"), { code: "ECONNRESET" }),
  });
  report({
    event: "proxy_socket_error",
    side: "upstream",
    code: networkErrorCode(error),
    address: "44.209.157.185",
    port: 443,
    ...{
      message: "fixture-secret",
      headers: { authorization: "fixture-secret" },
      url: "https://fixture-secret.example",
    },
  });
  expect(JSON.parse(lines[0]!)).toMatchObject({
    event: "computer_network.proxy_socket_error",
    component: "computer",
    side: "upstream",
    code: "ECONNRESET",
    address: "44.209.157.185",
    port: 443,
  });
  expect(lines.join("")).not.toContain("fixture-secret");
  expect(
    sanitizeNetworkDiagnostic({
      event: "proxy_socket_error",
      code: "fixture-secret",
      address: "fixture-secret.example",
      epoch: "fixture-secret",
    })
  ).toEqual({ event: "proxy_socket_error", code: "unknown" });
  expect(sanitizeNetworkDiagnostic({ event: "fixture-secret" })).toBeNull();
  expect(
    sanitizeNetworkDiagnostic({ event: "proxy_socket_error", address: "fe80::1%fixture-secret" })
  ).toEqual({ event: "proxy_socket_error" });
  expect(networkErrorCode(new Error("fixture-secret"))).toBe("unknown");
});

test("connection storms are bounded and logging failures cannot interrupt networking", () => {
  let now = 0;
  const lines: string[] = [];
  const report = createNetworkDiagnostics(
    "computer",
    (line) => lines.push(line),
    () => now
  );
  for (let i = 0; i < 100; i++) report({ event: "proxy_capacity", limit: 80 });
  expect(lines).toHaveLength(20);
  report({ event: "route_fenced", reason: "lease_expired" });
  expect(JSON.parse(lines[20]!)).toMatchObject({
    event: "computer_network.route_fenced",
    reason: "lease_expired",
  });
  now = 1000;
  report({ event: "proxy_dial_failed", code: "ECONNREFUSED" });
  expect(JSON.parse(lines[21]!)).toMatchObject({ code: "ECONNREFUSED", suppressed: 80 });
  const broken = createNetworkDiagnostics("computer", () => {
    throw new Error("disk full");
  });
  expect(() => broken({ event: "proxy_capacity" })).not.toThrow();
});

test("SOCKS reports capacity rejection and an upstream reset without replaying a connection", async () => {
  const events: NetworkDiagnostic[] = [];
  let dials = 0;
  const upstream = new PassThrough();
  const proxy = createBrowserProxy(
    async () => {
      dials++;
      return upstream;
    },
    1,
    (event) => events.push(event)
  );
  const port = await proxy.listen(0);
  const first = createConnection({ host: "127.0.0.1", port });
  const sockets = [first];
  first.on("error", () => {});
  try {
    await new Promise<void>((resolve) => first.once("connect", resolve));
    const second = createConnection({ host: "127.0.0.1", port });
    sockets.push(second);
    second.on("error", () => {});
    await new Promise<void>((resolve) => second.once("close", resolve));
    expect(events).toContainEqual({
      event: "proxy_capacity",
      connectionId: 2,
      activeConnections: 1,
      limit: 1,
    });
    // Greeting and CONNECT for a pinned public IP, in a single TCP write.
    const accepted = new Promise<void>((resolve) => {
      let size = 0;
      first.on("data", (bytes) => {
        size += bytes.length;
        if (size >= 12) resolve();
      });
    });
    first.write(Buffer.from([5, 1, 0, 5, 1, 0, 1, 44, 209, 157, 185, 1, 187]));
    await accepted;
    const closed = new Promise<void>((resolve) => first.once("close", resolve));
    upstream.destroy(Object.assign(new Error("fixture-secret"), { code: "ECONNRESET" }));
    await closed;
    expect(dials).toBe(1);
    expect(events).toContainEqual({
      event: "proxy_socket_error",
      connectionId: 1,
      address: "44.209.157.185",
      port: 443,
      side: "upstream",
      code: "ECONNRESET",
    });
    expect(JSON.stringify(events)).not.toContain("fixture-secret");
  } finally {
    for (const socket of sockets) socket.destroy();
    upstream.destroy();
    await proxy.close();
  }
}, 5000);
