import { randomUUID } from "node:crypto";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { PgBoss } from "pg-boss";

export const DOCTOR_QUEUE = "openteam-doctor";
export const DOCTOR_SOCKET = "/tmp/openteam-worker-doctor.sock";
export const DOCTOR_HEARTBEAT = "/tmp/openteam-worker-heartbeat.json";

// Shares the running worker's queue connection and event loop. The socket is
// private to its OS user and is never exposed as a public HTTP endpoint.
export const startWorkerDiagnostics = async (
  boss: Pick<PgBoss, "createQueue" | "work" | "send" | "getJobById" | "deleteJob">,
  paths = { socket: DOCTOR_SOCKET, heartbeat: DOCTOR_HEARTBEAT }
): Promise<() => Promise<void>> => {
  const instance = randomUUID();
  const startedAt = Date.now();
  const heartbeat = async () => {
    await writeFile(
      `${paths.heartbeat}.tmp`,
      JSON.stringify({ instance, pid: process.pid, startedAt, updatedAt: Date.now() }),
      { mode: 0o600 }
    );
    await rename(`${paths.heartbeat}.tmp`, paths.heartbeat);
  };
  await boss.createQueue(DOCTOR_QUEUE);
  await boss.work<{ nonce: string }>(
    DOCTOR_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: 0.5 },
    async ([job]) => ({ nonce: job?.data.nonce, instance })
  );
  let active = false;
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method !== "POST" || request.url !== "/queue") {
      response.writeHead(404).end();
      return;
    }
    if (active) {
      response
        .writeHead(409)
        .end(JSON.stringify({ ok: false, error: "Another queue test is running; retry doctor" }));
      return;
    }
    active = true;
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
    try {
      const nonce = randomUUID();
      id = await bounded(
        boss.send(
          DOCTOR_QUEUE,
          { nonce },
          { retryLimit: 0, expireInSeconds: 10, retentionSeconds: 60 }
        )
      );
      if (!id) throw new Error("Could not enqueue the diagnostic job");
      while (Date.now() - started < 8_000) {
        const job = await bounded(boss.getJobById(DOCTOR_QUEUE, id));
        const output = job?.output as { nonce?: string; instance?: string } | undefined;
        if (job?.state === "completed" && output?.nonce === nonce) {
          response.end(
            JSON.stringify({
              ok: true,
              instance,
              consumer: output.instance,
              durationMs: Date.now() - started,
            })
          );
          return;
        }
        if (job?.state === "failed") throw new Error("The diagnostic queue job failed");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("No worker consumed the diagnostic job within 8s");
    } catch {
      response.writeHead(503).end(
        JSON.stringify({
          ok: false,
          error: "Queue round trip failed or timed out; inspect openteam logs worker",
        })
      );
    } finally {
      // Retention also bounds leftovers if the process or database is unavailable.
      if (id) await bounded(boss.deleteJob(DOCTOR_QUEUE, id), 1_000).catch(() => undefined);
      active = false;
    }
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
  let writing = false;
  const timer = setInterval(() => {
    if (writing) return;
    writing = true;
    void heartbeat()
      .catch(() => undefined)
      .finally(() => {
        writing = false;
      });
  }, 5_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(paths.heartbeat, { force: true });
    await rm(paths.socket, { force: true });
  };
};
