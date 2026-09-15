import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { PgBoss } from "pg-boss";
import type { PrismaClient } from "@openteam/db";

export const WORKER_QUEUES = [
  "bot-wake",
  "bot-provision",
  "transcript-project",
  "routine-dispatch",
] as const;
export class WorkerDependencyError extends Error {}

export const checkWorkerDependencies = async (worker: {
  boss: Pick<PgBoss, "getWipData">;
  prisma: Pick<PrismaClient, "$queryRaw">;
  computerUrl: string;
  controlToken: string;
  roots: readonly string[];
}): Promise<void> => {
  const consumers = worker.boss.getWipData();
  const missing = WORKER_QUEUES.filter(
    (name) => !consumers.some((c) => c.name === name && c.state === "active")
  );
  if (missing.length)
    throw new WorkerDependencyError(
      `Application queue consumers unavailable: ${missing.join(", ")}`
    );
  const checks = await Promise.allSettled([
    (async () => {
      await worker.prisma.$queryRaw`SELECT 1 FROM "Bot" LIMIT 0`;
      const rows = await worker.prisma.$queryRaw<
        Array<{ count: number }>
      >`SELECT count(*)::int AS count FROM pgboss.queue WHERE name IN ('bot-wake','bot-provision','transcript-project','routine-dispatch')`;
      if (rows[0]?.count !== WORKER_QUEUES.length) throw new Error("Missing application queues");
    })(),
    (async () => {
      const response = await fetch(new URL("/health/authenticated", worker.computerUrl), {
        headers: { authorization: `Bearer ${worker.controlToken}` },
        signal: AbortSignal.timeout(4_000),
      });
      if (!response.ok || (await response.json()).status !== "ready") throw new Error("not ready");
    })(),
    Promise.all(
      worker.roots.map((root) => access(root, constants.R_OK | constants.W_OK | constants.X_OK))
    ),
  ]);
  const failed = checks.flatMap((check, i) =>
    check.status === "rejected"
      ? [["database/schema", "authenticated computer API", "storage access"][i]]
      : []
  );
  if (failed.length)
    throw new WorkerDependencyError(`Worker dependencies unavailable: ${failed.join(", ")}`);
};
