import { expect, test } from "bun:test";
import { BrowserNetworkClient } from "../../src/browser-network/client";
import {
  decodeFrame,
  encodeFrame,
  FrameType,
  jsonBytes,
  parseJson,
  type NetworkRoute,
} from "../../src/browser-network/protocol";

test("invalidate discards pending old lease challenges before accepting the new epoch", async () => {
  let oldNonce: string | undefined,
    sequence = 0;
  const seen: string[] = [];
  const route = (epoch: string): NetworkRoute => ({
    deploymentId: "fixture",
    revision: 1,
    mode: "server",
    machineId: null,
    sourceOrder: ["server"],
    available: true,
    epoch,
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message(socket, bytes) {
        if (typeof bytes === "string") return;
        const frame = decodeFrame(new Uint8Array(bytes));
        if (frame.type !== FrameType.Control) return;
        const value = parseJson(frame.payload);
        if (value.op !== "lease") return;
        const send = (body: Record<string, unknown>) =>
          socket.send(
            encodeFrame(FrameType.Control, 0, jsonBytes({ ...body, sequence: ++sequence }))
          );
        if (!oldNonce) {
          oldNonce = value.nonce as string;
          send({ op: "invalidate" });
          return;
        }
        send({ op: "lease", nonce: oldNonce, route: route("stale") });
        send({ op: "lease", nonce: value.nonce, route: route("current") });
      },
    },
  });
  const client = new BrowserNetworkClient({
    role: "computer",
    url: `ws://127.0.0.1:${server.port}`,
    headers: {},
    changed: () => {
      if (client.route) seen.push(client.route.epoch);
    },
  });
  try {
    client.start();
    const deadline = Date.now() + 3000;
    while (!client.available() && Date.now() < deadline) await Bun.sleep(5);
    expect(client.available()).toBe(true);
    expect(client.route?.epoch).toBe("current");
    expect(seen).not.toContain("stale");
  } finally {
    client.stop();
    server.stop(true);
  }
});

for (const granted of [false, true])
  test(`short-lived transports retain reconnect backoff (lease=${granted})`, async () => {
    const opened: number[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        if (!server.upgrade(request)) return new Response(null, { status: 400 });
      },
      websocket: {
        open(socket) {
          opened.push(performance.now());
          if (!granted) socket.close();
        },
        message(socket, bytes) {
          if (!granted || typeof bytes === "string") return;
          const frame = decodeFrame(new Uint8Array(bytes));
          if (frame.type !== FrameType.Control) return;
          const message = parseJson(frame.payload);
          if (message.op !== "lease") return;
          socket.send(
            encodeFrame(
              FrameType.Control,
              0,
              jsonBytes({
                sequence: 1,
                op: "lease",
                nonce: message.nonce,
                route: {
                  deploymentId: "fixture",
                  revision: 1,
                  mode: "server",
                  machineId: null,
                  sourceOrder: ["server"],
                  available: true,
                  epoch: "current",
                },
              })
            )
          );
          socket.close();
        },
      },
    });
    const client = new BrowserNetworkClient({
      role: "computer",
      url: `ws://127.0.0.1:${server.port}`,
      headers: {},
    });
    try {
      client.start();
      const deadline = performance.now() + 7000;
      while (opened.length < 3 && performance.now() < deadline) await Bun.sleep(20);
      expect(opened).toHaveLength(3);
      expect(opened[2]! - opened[1]!).toBeGreaterThanOrEqual(1550);
    } finally {
      client.stop();
      server.stop(true);
    }
  }, 10000);
