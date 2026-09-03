import { Effect } from "effect";
import { WakeWorker } from "./worker";

const worker = new WakeWorker();
await Effect.runPromise(
  Effect.tryPromise({
    try: () => worker.start(),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
);

const shutdown = async () => {
  await worker.stop();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log("OpenTeam wake worker is ready");
