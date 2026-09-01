import type { HostJobResponse, HostUtilityRequest } from "./host-job-protocol";
import { executeHostJob, terminateHostChildren } from "./host-jobs";

const controllers = new Map<string, AbortController>();
let shuttingDown = false;

const respond = (response: HostJobResponse) => {
  if (shuttingDown) return;
  try {
    process.parentPort.postMessage(response);
  } catch {
    // The Electron parent can disappear while shutdown is draining descendants.
  }
};

const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const termination = terminateHostChildren();
  for (const controller of controllers.values()) controller.abort();
  void termination.finally(() => process.exit(0));
};

process.parentPort.on("message", (event) => {
  const request = event.data as HostUtilityRequest;
  if (!request || typeof request !== "object") return;
  if (request.type === "shutdown") {
    shutdown();
    return;
  }
  if (typeof request.id !== "string") return;
  if (shuttingDown) return;
  if (request.type === "cancel") {
    controllers.get(request.id)?.abort();
    return;
  }
  if (request.type !== "run" || controllers.has(request.id)) return;
  const controller = new AbortController();
  controllers.set(request.id, controller);
  void executeHostJob(request.payload, controller.signal)
    .then((value) => respond({ type: "result", id: request.id, ok: true, value }))
    .catch((error) =>
      respond({
        type: "result",
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    )
    .finally(() => controllers.delete(request.id));
});

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
