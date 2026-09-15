import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SnapshotService } from "../src/services/snapshot-service";
import { RuntimeHealth } from "../src/services/snapshot/runtime-health";

describe("runtime health", () => {
  test("reuses stuck queries across timed-out responses instead of accumulating probes", async () => {
    let databaseCalls = 0;
    let queueCalls = 0;
    const health = new RuntimeHealth(
      {
        $queryRaw: () => {
          databaseCalls++;
          return new Promise(() => {});
        },
      } as never,
      "http://unused",
      () => {
        queueCalls++;
        return new Promise(() => {});
      },
      20
    );
    Object.assign(health, {
      probeRuntimeStatus: async () => ({ computer: "ready", inference: "ready" }),
    });
    for (let i = 0; i < 3; i++) expect((await health.runtimeStatus()).database).toBe("unavailable");
    expect(databaseCalls).toBe(1);
    expect(queueCalls).toBe(1);
  });
  test("returns a degraded result when a shared computer probe never settles", async () => {
    const service = new SnapshotService(
      { $queryRaw: async () => [] } as never,
      "/workspace",
      "http://computer",
      () => true,
      20
    );
    let probeCount = 0;
    Object.assign((service as unknown as { runtimeHealth: object }).runtimeHealth, {
      probeRuntimeStatus: () => {
        probeCount += 1;
        return new Promise<never>(() => undefined);
      },
    });

    const [first, second] = await Promise.all([
      Effect.runPromise(service.health()),
      Effect.runPromise(service.health()),
    ]);

    expect(first).toEqual({
      server: "degraded",
      database: "ready",
      queue: "ready",
      computer: "unavailable",
      inference: "unavailable",
      transcription: "missing",
    });
    expect(second).toEqual(first);
    expect(probeCount).toBe(1);
  });
  test.each([
    "database",
    "queue",
    "queue-timeout",
    "computer",
    "auth",
    "transcription-timeout",
    "healthy",
  ])("attributes %s failures and bounds the response", async (failure) => {
    let path = "";
    const computer = Bun.serve({
      port: 0,
      fetch(request) {
        path = new URL(request.url).pathname;
        return Response.json(
          {
            status: failure === "computer" ? "degraded" : "ready",
            inference: { ready: true, authenticated: true },
          },
          { status: failure === "auth" ? 401 : 200 }
        );
      },
    });
    try {
      const health = new RuntimeHealth(
        {
          $queryRaw: async () => {
            if (failure === "database") throw new Error("database unavailable");
            return [];
          },
          computer: { update: async () => ({}) },
        } as never,
        `http://127.0.0.1:${computer.port}`,
        () => (failure === "queue-timeout" ? new Promise(() => {}) : failure !== "queue"),
        50,
        undefined,
        () =>
          failure === "transcription-timeout" ? new Promise(() => {}) : Promise.resolve("missing")
      );
      const started = Date.now();
      const result = await health.runtimeStatus();
      expect(Date.now() - started).toBeLessThan(500);
      expect(result.server).toBe(
        ["healthy", "transcription-timeout"].includes(failure) ? "ready" : "degraded"
      );
      expect(result.database).toBe(failure === "database" ? "unavailable" : "ready");
      expect(result.queue).toBe(failure.startsWith("queue") ? "unavailable" : "ready");
      expect(result.computer).toBe(
        ["computer", "auth"].includes(failure) ? "unavailable" : "ready"
      );
      expect(path).toBe("/health/authenticated");
    } finally {
      computer.stop(true);
    }
  });
});
