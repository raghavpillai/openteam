import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SnapshotService } from "../src/services/snapshot-service";

describe("runtime health", () => {
  test("returns a degraded result when a shared computer probe never settles", async () => {
    const service = new SnapshotService(
      {} as never,
      "/workspace",
      "http://computer",
      () => true,
      20
    );
    let probeCount = 0;
    Object.assign(service, {
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
    });
    expect(second).toEqual(first);
    expect(probeCount).toBe(1);
  });
});
