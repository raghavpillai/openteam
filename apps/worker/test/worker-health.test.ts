import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWorkerHealth } from "../src/worker-health";
import { checkWorkerDependencies, WORKER_QUEUES } from "../src/readiness";

describe("Docker worker health probe", () => {
  test.each([
    "healthy",
    "missing",
    "stale",
    "future",
    "invalid",
    "null",
    "socket-missing",
    "hung",
    "foreign",
    "failure",
    "bad-json",
    "false-200",
  ])("detects %s", async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), "ot-health-"));
    const paths = { heartbeat: join(dir, "h"), socket: join(dir, "s") };
    const server = createServer((_req, res) => {
      if (mode === "hung") return;
      if (mode === "bad-json") {
        res.end("bad");
        return;
      }
      res
        .writeHead(mode === "failure" ? 503 : 200)
        .end(
          JSON.stringify({
            ok: mode !== "false-200",
            instance: "self",
            consumer: mode === "foreign" ? "other" : "self",
            durationMs: 3,
          })
        );
    });
    try {
      if (mode !== "missing")
        await writeFile(
          paths.heartbeat,
          mode === "invalid"
            ? "broken"
            : mode === "null"
              ? "null"
              : JSON.stringify({
                  instance: "self",
                  updatedAt:
                    Date.now() + (mode === "stale" ? -30_000 : mode === "future" ? 30_000 : 0),
                })
        );
      if (mode !== "socket-missing")
        await new Promise<void>((resolve) => server.listen(paths.socket, resolve));
      if (mode === "healthy") await expect(checkWorkerHealth(paths, 100)).resolves.toBeUndefined();
      else await expect(checkWorkerHealth(paths, 100)).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });
  test.each([
    "healthy",
    "consumer",
    "database",
    "queue",
    "computer",
    "storage",
  ])("checks %s dependencies", async (mode) => {
    const computer = Bun.serve({
      port: 0,
      fetch(request) {
        expect(new URL(request.url).pathname).toBe("/health/authenticated");
        expect(request.headers.get("authorization")).toBe("Bearer fixture");
        return Response.json({ status: "ready" }, { status: mode === "computer" ? 401 : 200 });
      },
    });
    try {
      const input = {
        boss: {
          getWipData: () =>
            WORKER_QUEUES.filter((name) => mode !== "consumer" || name !== "bot-wake").map(
              (name) => ({ name, state: "active" })
            ),
        } as never,
        prisma: {
          $queryRaw: async () => {
            if (mode === "database") throw new Error("private connection error");
            return [{ count: mode === "queue" ? 3 : 4 }];
          },
        } as never,
        computerUrl: `http://127.0.0.1:${computer.port}`,
        controlToken: "fixture",
        roots: mode === "storage" ? ["/missing/health/storage"] : [],
      };
      if (mode === "healthy") await expect(checkWorkerDependencies(input)).resolves.toBeUndefined();
      else
        await expect(checkWorkerDependencies(input)).rejects.toThrow(
          mode === "consumer" ? "consumers unavailable" : "dependencies unavailable"
        );
    } finally {
      computer.stop(true);
    }
  });
});
