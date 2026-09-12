import { Effect } from "effect";
import { WakeWorker } from "./worker";
import { startWorkerDiagnostics } from "./diagnostics";

const worker = new WakeWorker();
await Effect.runPromise(
  Effect.tryPromise({
    try: () => worker.start(),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
);
const stopDiagnostics = await startWorkerDiagnostics(worker.boss);

const shutdown = async () => {
  await stopDiagnostics();
  await worker.stop();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log("OpenTeam wake worker is ready");
