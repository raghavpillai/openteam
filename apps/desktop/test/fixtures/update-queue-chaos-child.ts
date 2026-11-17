// A disposable queue process. The parent owns the fake host/native service independently.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createJsonTransport } from "@openteam/client-core";
import type { BusyBotsView, ServerUpdateView, SystemVersionView } from "@openteam/contracts";
import { UpdateQueue, type UpdateQueueState } from "../../src/renderer/lib/update-queue";
import { withDeadline } from "../../src/renderer/lib/request-errors";

const [baseUrl, file, action = "resume"] = process.argv.slice(2) as [string, string, string];
const transport = createJsonTransport({ baseUrl, getAuthToken: () => "isolated-chaos-owner" });
const request = <T>(path: string, init?: RequestInit) =>
  withDeadline((signal) => transport.request<T>(path, { ...init, signal }), 100);
let restored: unknown = null;
try {
  restored = JSON.parse(readFileSync(file, "utf8"));
} catch {
  /* Corrupt or unavailable storage is optional. */
}
let storageFailures = 0;
let publications = 0;
const queue = new UpdateQueue(
  {
    async server() {
      const [version, update] = await Promise.all([
        request<SystemVersionView>("/api/v0/system/version"),
        request<ServerUpdateView>("/api/v0/system/update"),
      ]);
      if (!version.releaseVersion) throw new Error("Unknown server version");
      return { version: version.releaseVersion, update };
    },
    busy: async () => (await request<BusyBotsView>("/api/v0/system/busy-bots")).bots.length > 0,
    startServer: (targetVersion) =>
      request("/api/v0/system/update", { method: "POST", body: JSON.stringify({ targetVersion }) }),
    desktop: () => request<OpenTeamUpdateStatus>("/native/status"),
    checkDesktop: () => request<OpenTeamUpdateStatus>("/native/check", { method: "POST" }),
    // Unlike a status round trip, this request intentionally stays pending for the download.
    downloadDesktop: (targetVersion) =>
      transport.request<void>("/native/download", {
        method: "POST",
        body: JSON.stringify({ targetVersion }),
      }),
    now: performance.now.bind(performance),
    wait: () => new Promise((resolve) => setTimeout(resolve, 20)),
    save(value: UpdateQueueState | null) {
      publications++;
      try {
        writeFileSync(`${file}.tmp`, JSON.stringify(value));
        renameSync(`${file}.tmp`, file);
      } catch {
        storageFailures++;
      }
    },
  },
  restored
);
if (action === "start") await queue.start("0.0.19");
else if (action === "retry") await queue.retry();
else await queue.resume();
console.log(JSON.stringify({ state: queue.snapshot(), storageFailures, publications }));
process.exit(0);
