import { WakeWorker } from "../../src/worker";
const worker = new WakeWorker();
const pauseAt = process.env.MEMORY_WORKER_PAUSE_AT;
const pause = async () => {
  await Bun.write(process.env.MEMORY_WORKER_PAUSED!, String(process.pid));
  await new Promise<void>(() => {});
};
if (pauseAt === "before-memory") {
  const review = worker as unknown as { recordMemoryFromRun(runId: string): Promise<void> };
  const record = review.recordMemoryFromRun.bind(worker);
  review.recordMemoryFromRun = async (runId) => {
    if ((await worker.prisma.run.findUnique({ where: { id: runId } }))?.memoryReviewPending) await pause();
    await record(runId);
  };
}
if (pauseAt === "before-publication") {
  worker.messaging.completeDelivery = pause;
}
if (pauseAt === "before-ack") {
  const store = worker.agentData as unknown as { releaseMemoryExchanges(): Promise<void> };
  store.releaseMemoryExchanges = pause;
}
await worker.start();
await Bun.write(process.env.MEMORY_WORKER_READY!, String(process.pid));
process.on("SIGTERM", async () => {
  await worker.stop();
  process.exit(0);
});
setInterval(() => {}, 1000);
