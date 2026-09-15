import { WakeWorker } from "../../src/worker";
const worker = new WakeWorker();
await worker.start();
await Bun.write(process.env.MEMORY_WORKER_READY!, String(process.pid));
process.on("SIGTERM", async () => {
  await worker.stop();
  process.exit(0);
});
setInterval(() => {}, 1000);
