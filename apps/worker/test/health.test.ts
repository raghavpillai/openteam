import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PgBoss } from "pg-boss";
import { DOCTOR_QUEUE, startWorkerDiagnostics } from "../src/diagnostics";
import { checkWorkerDependencies, WORKER_QUEUES } from "../src/readiness";
import { checkWorkerHealth } from "../src/worker-health";

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

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const post = (socketPath: string, path = "/queue", method = "POST") =>
  new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ socketPath, method, path }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () =>
        resolve({ status: res.statusCode!, body: body ? JSON.parse(body) : null })
      );
    });
    req.on("error", reject);
    req.end();
  });

const fixture = async (
  mode: "ready" | "failed" | "hung" | "foreign" | "dependencies" | "dependencies-hung" = "ready",
  queueLatencyMs = 0,
  notifications?: () => Promise<unknown>
) => {
  const directory = await mkdtemp(join(tmpdir(), "ot-doc-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const paths = { socket: join(directory, "s"), heartbeat: join(directory, "h") };
  let consume: (jobs: any[]) => Promise<any>;
  let data: any;
  const deleted: string[] = [];
  const queues: string[] = [];
  let dependencyCalls = 0;
  const boss = {
    createQueue: async (name: string) => {
      queues.push(name);
    },
    work: async (_name: string, _options: unknown, handler: typeof consume) => {
      consume = handler;
    },
    send: async (_name: string, input: unknown) => {
      data = input;
      return "test-job";
    },
    getJobById: async () => {
      if (queueLatencyMs) await Bun.sleep(queueLatencyMs);
      return mode === "hung"
        ? new Promise(() => undefined)
        : {
            state: mode === "failed" ? "failed" : "completed",
            output: {
              ...(await consume([{ data }])),
              ...(mode === "foreign" ? { instance: "another-worker" } : {}),
            },
          };
    },
    deleteJob: async (_name: string, id: string) => {
      deleted.push(id);
    },
    offWork: async () => {},
    deleteQueue: async () => {},
  } as unknown as PgBoss;
  const stop = await startWorkerDiagnostics(
    boss,
    paths,
    async () => {
      dependencyCalls++;
      if (mode === "dependencies-hung") return new Promise(() => {});
      if (mode === "dependencies") throw new Error("secret database connection string");
    },
    notifications
  );
  cleanups.push(stop);
  return { paths, deleted, queues, dependencyCalls: () => dependencyCalls };
};

describe("worker diagnostics", () => {
  test("reads current APNs status without sending a notification or consuming a queue job", async () => {
    let source = "environment";
    const { paths, deleted } = await fixture("ready", 0, async () => ({
      source,
      topic: "dev.openbot.mobile",
      missing: [],
      issue: null,
    }));
    expect((await post(paths.socket, "/notifications", "GET")).body.source).toBe("environment");
    source = "database";
    expect((await post(paths.socket, "/notifications", "GET")).body.source).toBe("database");
    expect(deleted).toEqual([]);
  });
  test("runtime APNs diagnostic failures never expose exception text", async () => {
    const { paths } = await fixture("ready", 0, async () => {
      throw new Error("secret-signing-key");
    });
    const response = await post(paths.socket, "/notifications", "GET");
    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain("secret-signing-key");
  });
  test("publishes a private heartbeat and confirms processing through the registered consumer", async () => {
    const { paths, deleted, queues } = await fixture();
    const heartbeat = JSON.parse(await readFile(paths.heartbeat, "utf8"));
    expect(heartbeat.pid).toBe(process.pid);
    expect(Date.now() - heartbeat.updatedAt).toBeLessThan(1000);
    expect((await stat(paths.socket)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.heartbeat)).mode & 0o777).toBe(0o600);
    const response = await post(paths.socket);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      instance: heartbeat.instance,
      consumer: heartbeat.instance,
    });
    expect(queues).toHaveLength(1);
    expect(queues[0]).toStartWith(`${DOCTOR_QUEUE}-`);
    expect(deleted).toEqual(["test-job"]);
  });
  test("reports a failed queue job and removes only its own diagnostic job", async () => {
    const { paths, deleted } = await fixture("failed");
    expect(await post(paths.socket)).toMatchObject({ status: 503, body: { ok: false } });
    expect(deleted).toEqual(["test-job"]);
  });
  test.each([
    "foreign",
    "dependencies",
  ] as const)("rejects %s failures without a false healthy result", async (mode) => {
    const { paths } = await fixture(mode);
    const result = await post(paths.socket);
    expect(result.status).toBe(503);
    expect(result.body.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret database connection string");
  });
  test("times out a stuck database query and shares concurrent diagnostic requests", async () => {
    const { paths, deleted } = await fixture("hung");
    const started = Date.now();
    const first = post(paths.socket);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = post(paths.socket);
    const responses = await Promise.all([first, second]);
    expect(responses[0]).toMatchObject({ status: 503, body: { ok: false } });
    expect(responses[1]).toEqual(responses[0]);
    expect(Date.now() - started).toBeLessThan(9500);
    expect(deleted).toEqual(["test-job"]);
  }, 12_000);
});

test("replicas use separate diagnostic queues and simultaneous healthy checks share one job", async () => {
  const first = await fixture("ready", 50);
  const second = await fixture();
  expect(first.queues[0]).not.toBe(second.queues[0]);
  const responses = await Promise.all(Array.from({ length: 10 }, () => post(first.paths.socket)));
  expect(responses.every((result) => result.status === 200 && result.body.ok)).toBe(true);
  expect(first.deleted).toEqual(["test-job"]);
  expect(second.deleted).toEqual([]);
});

test("successive timeout responses do not accumulate stuck dependency queries", async () => {
  const f = await fixture("dependencies-hung");
  for (let i = 0; i < 2; i++) expect((await post(f.paths.socket)).status).toBe(503);
  expect(f.dependencyCalls()).toBe(1);
  expect(f.deleted).toEqual([]);
}, 20_000);
