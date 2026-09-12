import { describe, expect, test } from "bun:test";
import { refreshSessionHealth, tcpPortAccepts, viewerHttpResponds } from "../src/screen/processes";
import type { ScreenSession } from "../src/screen/types";

describe("screen endpoint health", () => {
  test("requires both a listening port and a healthy viewer response", async () => {
    let status = 200;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("viewer", { status }),
    });
    try {
      expect(await tcpPortAccepts(server.port!)).toBe(true);
      expect(await viewerHttpResponds(server.port!)).toBe(true);
      status = 503;
      expect(await viewerHttpResponds(server.port!)).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("a failed endpoint transitions a ready screen to failed", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("unavailable", { status: 503 }),
    });
    try {
      const session = {
        state: "ready",
        lastHealthCheckAt: 0,
        rfbPort: server.port,
        viewerPort: server.port,
        destroyed: false,
        stopping: false,
        error: null,
      } as ScreenSession;
      await refreshSessionHealth(session);
      expect(session.state).toBe("failed");
      expect(session.error).toBe("The VNC or noVNC endpoint stopped responding");
    } finally {
      server.stop(true);
    }
  });
});
