import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PgBoss } from "pg-boss";
import { DOCTOR_QUEUE, startWorkerDiagnostics } from "../src/diagnostics";

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

const fixture = async (mode: "ready" | "failed" | "hung" = "ready") => {
  const directory = await mkdtemp(join(tmpdir(), "ot-doc-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const paths = { socket: join(directory, "s"), heartbeat: join(directory, "h") };
  let consume: (jobs: any[]) => Promise<any>;
  let data: any;
  const deleted: string[] = [];
  const queues: string[] = [];
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
    getJobById: async () =>
      mode === "hung"
        ? new Promise(() => undefined)
        : { state: mode === "failed" ? "failed" : "completed", output: await consume([{ data }]) },
    deleteJob: async (_name: string, id: string) => {
      deleted.push(id);
    },
  } as unknown as PgBoss;
  const stop = await startWorkerDiagnostics(boss, paths);
  cleanups.push(stop);
  return { paths, deleted, queues };
};

describe("worker diagnostics", () => {
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
    expect(queues).toEqual([DOCTOR_QUEUE]);
    expect(deleted).toEqual(["test-job"]);
  });
  test("rejects unrelated requests without enqueuing work", async () => {
    const { paths, deleted } = await fixture();
    expect((await post(paths.socket, "/queue", "GET")).status).toBe(404);
    expect((await post(paths.socket, "/unknown")).status).toBe(404);
    expect(deleted).toEqual([]);
  });
  test("reports a failed queue job and removes only its own diagnostic job", async () => {
    const { paths, deleted } = await fixture("failed");
    expect(await post(paths.socket)).toMatchObject({ status: 503, body: { ok: false } });
    expect(deleted).toEqual(["test-job"]);
  });
  test("times out a stuck database query and refuses overlapping diagnostic jobs", async () => {
    const { paths, deleted } = await fixture("hung");
    const started = Date.now();
    const first = post(paths.socket);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await post(paths.socket)).status).toBe(409);
    expect(await first).toMatchObject({ status: 503, body: { ok: false } });
    expect(Date.now() - started).toBeLessThan(9500);
    expect(deleted).toEqual(["test-job"]);
  }, 12_000);
});
