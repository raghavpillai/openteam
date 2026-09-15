import { readFile } from "node:fs/promises";
import { request } from "node:http";

export const checkWorkerHealth = async (
  paths = {
    heartbeat: "/tmp/openteam-worker-heartbeat.json",
    socket: "/tmp/openteam-worker-doctor.sock",
  },
  timeoutMs = 10_000
): Promise<void> => {
  let heartbeat: { instance?: unknown; updatedAt?: unknown };
  try {
    heartbeat = JSON.parse(await readFile(paths.heartbeat, "utf8"));
  } catch {
    throw new Error("Worker heartbeat is missing or unreadable");
  }
  const age = Date.now() - Number(heartbeat?.updatedAt);
  if (
    typeof heartbeat?.instance !== "string" ||
    !heartbeat.instance ||
    typeof heartbeat.updatedAt !== "number" ||
    !Number.isFinite(age) ||
    age < -5_000 ||
    age > 20_000
  )
    throw new Error("Worker heartbeat is stale or invalid");
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const done = (error?: Error) => {
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    const req = request(
      { socketPath: paths.socket, method: "POST", path: "/queue" },
      (response) => {
        let text = "";
        response.on("error", () => done(new Error("Worker health response was interrupted")));
        response.on("data", (chunk) => {
          text += chunk;
          if (text.length > 8192) req.destroy(new Error("Invalid worker health response"));
        });
        response.on("end", () => {
          try {
            const body = JSON.parse(text);
            if (
              response.statusCode !== 200 ||
              body.ok !== true ||
              body.instance !== heartbeat.instance ||
              body.consumer !== heartbeat.instance ||
              !Number.isFinite(body.durationMs) ||
              body.durationMs < 0
            )
              throw new Error(
                "Worker dependencies or queue round trip failed; run openteam doctor"
              );
            done();
          } catch {
            done(new Error("Worker dependencies or queue round trip failed; run openteam doctor"));
          }
        });
      }
    );
    timer = setTimeout(() => {
      done(new Error("Worker health check timed out"));
      req.destroy();
    }, timeoutMs);
    req.on("error", () => done(new Error("Worker diagnostic socket is unavailable or timed out")));
    req.end();
  });
};
