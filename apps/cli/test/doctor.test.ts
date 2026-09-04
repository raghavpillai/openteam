import { describe, expect, test } from "bun:test";
import { firstUnavailablePort, portAvailable, suggestApiPort, viewerPorts } from "../src/doctor";

describe("installation ports", () => {
  test("reports an occupied port and suggests the next available default", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    const port = server.port;
    if (!port) throw new Error("Expected Bun to allocate a port");
    try {
      expect(await portAvailable("127.0.0.1", port)).toBe(false);
      expect(await firstUnavailablePort("127.0.0.1", [port])).toBe(port);
      const suggested = await suggestApiPort("127.0.0.1", port);
      expect(suggested).not.toBe(port);
      expect(await portAvailable("127.0.0.1", suggested)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("enumerates the complete fixed screen-viewer range", () => {
    const ports = viewerPorts();
    expect(ports).toHaveLength(100);
    expect(ports[0]).toBe(6200);
    expect(ports.at(-1)).toBe(6299);
  });
});
