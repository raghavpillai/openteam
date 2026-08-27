import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { isAddressInUseError, listenForHostBridge } from "../src/main/host-bridge-listener";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) return resolve();
          server.close(() => resolve());
        })
    )
  );
});

describe("host bridge listener", () => {
  test("resolves after the server is listening", async () => {
    const server = createServer();
    servers.push(server);

    await expect(listenForHostBridge(server, 0)).resolves.toBe(server);
    expect(server.listening).toBe(true);
  });

  test("rejects a port collision instead of emitting an uncaught error", async () => {
    const first = createServer();
    const second = createServer();
    servers.push(first, second);
    await listenForHostBridge(first, 0);
    const address = first.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener");

    try {
      await listenForHostBridge(second, address.port);
      throw new Error("Expected the second listener to fail");
    } catch (error) {
      expect(isAddressInUseError(error)).toBe(true);
    }
  });
});
