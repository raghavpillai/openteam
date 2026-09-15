import { createHash, randomUUID } from "node:crypto";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { hostname } from "node:os";
import type { PgBoss } from "pg-boss";
import { WorkerDependencyError } from "./readiness";

export const DOCTOR_QUEUE = "openteam-doctor";
export const DOCTOR_SOCKET = "/tmp/openteam-worker-doctor.sock";
export const DOCTOR_HEARTBEAT = "/tmp/openteam-worker-heartbeat.json";

// Each replica must consume its own probe. Reuse its queue across process restarts,
// and share concurrent Docker/doctor probes so they cannot make each other fail.
export const startWorkerDiagnostics = async (
  boss: Pick<
    PgBoss,
    "createQueue" | "work" | "send" | "getJobById" | "deleteJob" | "offWork" | "deleteQueue"
  >,
  paths = { socket: DOCTOR_SOCKET, heartbeat: DOCTOR_HEARTBEAT },
  dependencies: () => Promise<void> = async () => {}
): Promise<() => Promise<void>> => {
  const instance = randomUUID();
  const queue = `${DOCTOR_QUEUE}-${createHash("sha256").update(`${hostname()}:${paths.socket}`).digest("hex").slice(0, 16)}`;
  const startedAt = Date.now();
  const heartbeat = async () => {
    await writeFile(
      `${paths.heartbeat}.tmp`,
      JSON.stringify({ instance, queue, pid: process.pid, startedAt, updatedAt: Date.now() }),
      { mode: 0o600 }
    );
    await rename(`${paths.heartbeat}.tmp`, paths.heartbeat);
  };
  await boss.createQueue(queue);
  await boss.work<{ nonce: string }>(
    queue,
    { batchSize: 1, pollingIntervalSeconds: 0.5 },
    async ([job]) => ({ nonce: job?.data.nonce, instance })
  );

  let dependencyInFlight: Promise<void> | null = null;
  const queueTest = async () => {
    let id: string | null = null;
    const started = Date.now();
    const bounded = async <T>(
      operation: Promise<T>,
      timeoutMs = 8_000 - (Date.now() - started)
    ): Promise<T> => {
      let timer: ReturnType<typeof setTimeout>;
      try {
        return await Promise.race([
          operation,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Queue test timed out")),
              Math.max(1, timeoutMs)
            );
          }),
        ]);
      } finally {
        clearTimeout(timer!);
      }
    };
    let stage = "Worker dependency checks failed";
    try {
      dependencyInFlight ??= Promise.resolve()
        .then(dependencies)
        .finally(() => {
          dependencyInFlight = null;
        });
      await bounded(dependencyInFlight);
      stage = "Queue round trip failed or timed out; inspect openteam logs worker";
      const nonce = randomUUID();
      id = await bounded(
        boss.send(queue, { nonce }, { retryLimit: 0, expireInSeconds: 10, retentionSeconds: 60 })
      );
      if (!id) throw new Error("Could not enqueue the diagnostic job");
      while (Date.now() - started < 8_000) {
        const job = await bounded(boss.getJobById(queue, id));
        const output = job?.output as { nonce?: string; instance?: string } | undefined;
        if (job?.state === "completed" && output?.nonce === nonce && output.instance === instance)
          return {
            ok: true,
            instance,
            consumer: output.instance,
            durationMs: Date.now() - started,
          };
        if (job?.state === "failed" || job?.state === "completed")
          throw new Error("Diagnostic job failed or was consumed by another instance");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("No worker consumed the diagnostic job within 8s");
    } catch (error) {
      // Dependency exception text can contain connection credentials. Keep it private.
      return { ok: false, error: error instanceof WorkerDependencyError ? error.message : stage };
    } finally {
      if (id) await bounded(boss.deleteJob(queue, id), 1_000).catch(() => undefined);
    }
  };
  let inFlight: ReturnType<typeof queueTest> | null = null;
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method !== "POST" || request.url !== "/queue") {
      response.writeHead(404).end();
      return;
    }
    inFlight ??= queueTest().finally(() => {
      inFlight = null;
    });
    const result = await inFlight;
    response.writeHead(result.ok ? 200 : 503).end(JSON.stringify(result));
  });
  await rm(paths.socket, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.socket, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(paths.socket, 0o600);
  await heartbeat();
  let writing: Promise<void> | null = null;
  const timer = setInterval(() => {
    writing ??= heartbeat()
      .catch(() => undefined)
      .finally(() => {
        writing = null;
      });
  }, 5_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await inFlight;
    await writing;
    // Use bounded cleanup too: shutdown must still finish if PostgreSQL is down.
    await Promise.race([
      boss
        .offWork(queue)
        .then(() => boss.deleteQueue(queue))
        .catch(() => undefined),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        timer.unref();
      }),
    ]);
    await rm(paths.heartbeat, { force: true });
    await rm(paths.socket, { force: true });
  };
};
