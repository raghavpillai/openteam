import type { Job, JobWithMetadata, PgBoss } from "pg-boss";

export const DISPATCH_POLL_SECONDS = 2;

/** One job per consumer, with immediate backlog draining and a polling backstop. */
export async function workContinuously<T>(
  boss: PgBoss,
  name: string,
  concurrency: number,
  handler: (job: JobWithMetadata<T>) => Promise<void>
): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("Queue concurrency must be a positive integer");
  }
  for (let index = 0; index < concurrency; index += 1) {
    let registered!: (id: string) => void;
    const registration = new Promise<string>((resolve) => { registered = resolve; });
    const id = await boss.work<T>(name, {
      batchSize: 1,
      includeMetadata: true,
      pollingIntervalSeconds: DISPATCH_POLL_SECONDS,
      notifyPollingIntervalSeconds: DISPATCH_POLL_SECONDS,
    }, async (jobs: Job<T>[]) => {
      try {
        for (const job of jobs) await handler(job as JobWithMetadata<T>);
      } finally {
        // pg-boss ignores burstWhenBatchFull at batchSize 1. Wake this consumer
        // after a handled job so pre-existing/retried work does not wait for a
        // fresh NOTIFY. An empty fetch never calls this handler, ending the burst.
        boss.notifyWorker(await registration);
      }
    });
    registered(id);
  }
}
