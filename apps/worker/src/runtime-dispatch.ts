import type { PrismaClient } from "@openteam/db";
import { TASK_RECOVERY_LOCK } from "@openteam/messaging";

/** Fence the gap between claiming a run and the computer accepting it. Startup
 * must either see and stop that turn, or invalidate it before it is dispatched.
 * The lock lasts only through response headers, never the model's long stream. */
export async function dispatchComputerTurn(
  prisma: PrismaClient,
  runId: string,
  send: (signal: AbortSignal) => Promise<Response>,
  timeoutMs = 60_000
): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(
    () => abort.abort(new Error("Computer turn dispatch timed out")),
    timeoutMs
  );
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${TASK_RECOVERY_LOCK}))`;
        const run = await tx.run.findUnique({ where: { id: runId }, select: { status: true } });
        if (run?.status !== "running")
          throw new Error("Run was invalidated before runtime dispatch");
        abort.signal.throwIfAborted();
        return send(abort.signal);
      },
      { maxWait: timeoutMs, timeout: timeoutMs + 5000 }
    );
  } finally {
    clearTimeout(timer);
  }
}
