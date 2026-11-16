import { expect, test } from "bun:test";
import { Effect } from "effect";
import { SnapshotService } from "../src/services/snapshot-service";
import { RuntimeHealth } from "../src/services/snapshot/runtime-health";

test("a new installation is healthy before selecting a model and sends no empty model reference", async () => {
  let model: string | null = "not requested";
  const computer = Bun.serve({ port: 0, fetch(request) {
    model = new URL(request.url).searchParams.get("model");
    return Response.json({ status: "ready", inference: { ready: true, authenticated: true } });
  } });
  try {
    const health = new RuntimeHealth({ $queryRaw: async () => [], computer: { update: async () => ({}) } } as never, `http://127.0.0.1:${computer.port}`, () => true, 500,
      async () => ({ providerId: "openai-codex", modelId: "", reasoning: "medium" }));
    expect(await health.runtimeStatus()).toMatchObject({ server: "ready", computer: "ready", inference: "missing" });
    expect(model).toBeNull();
  } finally { computer.stop(true); }
});

test("stuck database, queue and computer probes are shared across timed-out responses instead of accumulating", async () => {
  let databaseCalls = 0, queueCalls = 0, probeCount = 0;
  const health = new RuntimeHealth({ $queryRaw: () => { databaseCalls++; return new Promise(() => {}); } } as never, "http://unused",
    () => { queueCalls++; return new Promise(() => {}); }, 20);
  Object.assign(health, { probeRuntimeStatus: async () => ({ computer: "ready", inference: "ready" }) });
  for (let i = 0; i < 3; i++) expect((await health.runtimeStatus()).database).toBe("unavailable");
  expect([databaseCalls, queueCalls]).toEqual([1, 1]);

  const service = new SnapshotService({ $queryRaw: async () => [] } as never, "/workspace", "http://computer", () => true, 20);
  Object.assign((service as unknown as { runtimeHealth: object }).runtimeHealth, { probeRuntimeStatus: () => { probeCount += 1; return new Promise<never>(() => undefined); } });
  const [first, second] = await Promise.all([Effect.runPromise(service.health()), Effect.runPromise(service.health())]);
  expect(first).toEqual({ server: "degraded", database: "ready", queue: "ready", computer: "unavailable", inference: "unavailable", transcription: "missing" });
  expect(second).toEqual(first);
  expect(probeCount).toBe(1);
});
