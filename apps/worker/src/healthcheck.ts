import { checkWorkerHealth } from "./worker-health";

try {
  await checkWorkerHealth();
  console.log("Worker heartbeat, dependencies, and queue round trip passed");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Worker health check failed");
  process.exitCode = 1;
}
