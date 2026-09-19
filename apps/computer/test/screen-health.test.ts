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

  test("transient endpoint failures recover; two separate failures mark the desktop failed", async () => {
    let status = 503;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("viewer", { status }),
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
      await Promise.all([refreshSessionHealth(session), refreshSessionHealth(session)]);
      expect(session.state).toBe("ready");
      status = 200;
      session.lastHealthCheckAt = 0;
      await refreshSessionHealth(session);
      expect(session.state).toBe("ready");
      status = 503;
      session.lastHealthCheckAt = 0;
      await refreshSessionHealth(session);
      expect(session.state).toBe("ready");
      session.lastHealthCheckAt = 0;
      await refreshSessionHealth(session);
      expect(session.state).toBe("failed");
      expect(session.error).toBe("The VNC or noVNC endpoint stopped responding");
    } finally {
      server.stop(true);
    }
  });
});
