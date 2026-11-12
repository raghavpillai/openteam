import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { refreshSessionHealth, tcpPortAccepts, viewerHttpResponds, waitForProcessExit } from "../src/screen/processes";
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

describe("screen process exit waits", () => {
  test("timed out shutdown waits release only their own listeners", async () => {
    const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    const unrelated = () => {};
    child.on("exit", unrelated);
    try {
      for (let i = 0; i < 12; i++) await waitForProcessExit([child], 1);
      expect(child.listeners("exit")).toEqual([unrelated]);
      const pending = waitForProcessExit([child, child], 2_000);
      child.kill("SIGKILL");
      await pending;
      expect(child.listeners("exit")).toEqual([unrelated]);
    } finally {
      child.kill("SIGKILL");
      child.removeListener("exit", unrelated);
    }
  });

  test("overlapping waits each finish and detach on process exit", async () => {
    const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    try {
      const waits = [waitForProcessExit([child], 2_000), waitForProcessExit([child], 2_000)];
      child.kill("SIGKILL");
      await Promise.all(waits);
      expect(child.listenerCount("exit")).toBe(0);
      await waitForProcessExit([child], 2_000);
      expect(child.listenerCount("exit")).toBe(0);
    } finally {
      child.kill("SIGKILL");
    }
  });
});
