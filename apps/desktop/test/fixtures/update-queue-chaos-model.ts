import assert from "node:assert/strict";
import type { ServerUpdateView } from "@openteam/contracts";
import {
  UpdateQueue,
  type UpdateQueueDependencies,
  type UpdateQueueState,
} from "../../src/renderer/lib/update-queue";

export const CHAOS_FAULTS = [
  "healthy",
  "flaky-server",
  "lost-post-response",
  "busy-race",
  "server-error",
  "rollback",
  "old-version",
  "offline",
  "native-read-error",
  "download-error",
  "download-hang",
  "acceptance-hang",
  "feed-change",
  "storage-unavailable",
] as const;
type Fault = (typeof CHAOS_FAULTS)[number];

export async function runChaosSeed(seed: number, burst = 64, selectedFault?: Fault) {
  let randomState = seed + 1;
  const random = () => {
    randomState = Math.imul(randomState ^ (randomState >>> 15), 0x2c1b3c6d);
    randomState = Math.imul(randomState ^ (randomState >>> 12), 0x297a2d39);
    return (randomState ^ (randomState >>> 15)) >>> 0;
  };
  const fault = selectedFault ?? CHAOS_FAULTS[seed % CHAOS_FAULTS.length]!;
  const trace: string[] = [];
  const record = (event: string) => {
    trace.push(event);
    if (trace.length > 100) trace.shift();
  };
  let clock = 0;
  let tick = 0;
  let serverTicks = 0;
  let nativeTicks = 0;
  let serverPosts = 0;
  let downloads = 0;
  let actions = 0;
  let publications = 0;
  let nativeReads = 0;
  let serverReads = 0;
  let busy = fault === "busy-race";
  const completionTick = 1 + (random() % 12);
  const downloadTick = 1 + (random() % 12);
  const checkpoints: UpdateQueueState[] = [];
  let resolveDownload: (() => void) | undefined;
  let desktop = {
    currentVersion: "0.0.18",
    latestVersion: "0.0.19",
    status: "available",
    progress: null,
    message: null,
  } as OpenTeamUpdateStatus;
  const host = {
    version: "0.0.18",
    update: {
      status: "ready",
      phase: null,
      targetVersion: null,
      updaterAvailable: true,
      message: "",
      jobId: null,
      safeToCloseDesktop: false,
    } as ServerUpdateView,
  };
  const deps: UpdateQueueDependencies = {
    async server() {
      await Promise.resolve();
      serverReads++;
      if (
        fault === "offline" ||
        (fault === "flaky-server" && serverReads < 24 && random() % 3 !== 0)
      ) {
        record("server-read-dropped");
        throw new Error("Connection reset");
      }
      record(`server:${host.version}:${host.update.status}`);
      return structuredClone(host);
    },
    async busy() {
      await Promise.resolve();
      return busy;
    },
    async startServer(version) {
      await Promise.resolve();
      assert.equal(
        host.update.status,
        "ready",
        "A second server job was submitted while the first was active"
      );
      serverPosts++;
      assert.equal(version, "0.0.19");
      host.update = {
        ...host.update,
        status: "updating",
        targetVersion: version,
        jobId: "only-host-job",
        phase: "checking",
      };
      record("server-post");
      if (fault === "lost-post-response" && serverPosts === 1)
        throw new Error("Response lost after the host accepted the job");
    },
    async desktop() {
      await Promise.resolve();
      if (fault === "native-read-error" && ++nativeReads === 1)
        throw new Error("Native IPC interrupted");
      return structuredClone(desktop);
    },
    async checkDesktop() {
      await Promise.resolve();
      desktop = { ...desktop, status: "available" };
      return structuredClone(desktop);
    },
    async downloadDesktop(version) {
      assert.equal(version, "0.0.19");
      assert.equal(
        host.version,
        "0.0.19",
        "Desktop download started before the host reached its target"
      );
      assert.equal(
        host.update.status,
        "updated",
        "Desktop download started without a healthy completed host"
      );
      downloads++;
      record("native-download");
      if (fault === "download-error") {
        desktop = { ...desktop, status: "error", message: "Signature verification failed" };
        throw new Error("Signature verification failed");
      }
      if (fault === "acceptance-hang") return new Promise<void>(() => {});
      desktop = { ...desktop, status: "downloading", progress: 0 };
      return new Promise<void>((resolve) => {
        resolveDownload = resolve;
      });
    },
    async wait() {
      await Promise.resolve();
      if (++tick > 2000) throw new Error("Simulation exceeded its operation budget");
      clock += ["offline", "download-hang", "acceptance-hang"].includes(fault)
        ? 61_000
        : 500 + (random() % 1500);
      if (host.update.status === "updating" && ++serverTicks >= completionTick) {
        if (fault === "server-error")
          host.update = { ...host.update, status: "error", message: "Host verification failed" };
        else if (fault === "rollback")
          host.update = { ...host.update, phase: "rolling-back", message: "Restoring backup" };
        else {
          host.update = { ...host.update, status: "updated", phase: "complete" };
          if (fault !== "old-version") host.version = "0.0.19";
        }
      }
      if (desktop.status === "downloading") {
        nativeTicks++;
        desktop.progress = random() % 101;
        if (fault === "feed-change") desktop.latestVersion = "0.1.0";
        else if (fault !== "download-hang" && nativeTicks >= downloadTick) {
          desktop.status = "downloaded";
          desktop.progress = 100;
          resolveDownload?.();
          record("native-ready");
        }
      }
    },
    now: () => clock,
    save(value) {
      publications++;
      if (value && fault !== "storage-unavailable") checkpoints.push(structuredClone(value));
    },
  };
  const queue = new UpdateQueue(deps);
  let detachedCalls = 0;
  const detach = queue.subscribe(() => {
    detachedCalls++;
  });
  detach();
  try {
    const tasks = [queue.start("0.0.19")];
    for (let index = 0; index < burst; index++)
      tasks.push(
        (async () => {
          await Promise.resolve();
          actions++;
          const which = random() % 3;
          if (which === 0) await queue.start("0.0.19");
          else if (which === 1) await queue.resume();
          else await queue.retry();
        })()
      );
    await Promise.all(tasks);
    if (["lost-post-response", "busy-race", "native-read-error"].includes(fault)) {
      assert.equal(queue.snapshot()?.status, "error");
      busy = false;
      await queue.retry();
    }
    const fails = [
      "server-error",
      "rollback",
      "old-version",
      "offline",
      "download-error",
      "download-hang",
      "acceptance-hang",
      "feed-change",
    ].includes(fault);
    assert.equal(
      queue.snapshot()?.status,
      fails ? "error" : "complete",
      "Queue reached the wrong terminal state"
    );
    assert.equal(serverPosts, fault === "offline" ? 0 : 1, "Duplicate accepted server update");
    assert.equal(
      downloads,
      ["server-error", "rollback", "old-version", "offline"].includes(fault) ? 0 : 1,
      "Duplicate or premature native download"
    );
    assert.equal(detachedCalls, 0, "Unsubscribed observer was retained");
    if (fault === "acceptance-hang") {
      // A request can stall before Electron has published "downloading". Retry must observe it.
      for (let retry = 0; retry < 3; retry++) await queue.retry();
      assert.equal(
        downloads,
        1,
        "Retry started another native request while the first request was still pending"
      );
    }
    const checkpoint = checkpoints.find(
      (value) => value.serverRequested && value.status === "running"
    );
    if (checkpoint && ["healthy", "server-error", "rollback", "old-version"].includes(fault)) {
      const before = [serverPosts, downloads];
      const restored = new UpdateQueue(deps, checkpoint);
      await restored.resume();
      assert.equal(restored.snapshot()?.status, fails ? "error" : "complete");
      assert.deepEqual([serverPosts, downloads], before, "Reopening resubmitted work");
    }
    return {
      seed,
      fault,
      actions,
      tick,
      serverReads,
      serverPosts,
      downloads,
      publications,
      checkpointReplays:
        checkpoint && ["healthy", "server-error", "rollback", "old-version"].includes(fault)
          ? 1
          : 0,
    };
  } catch (error) {
    throw new Error(
      `Seed ${seed}, fault ${fault}: ${error instanceof Error ? error.message : String(error)}\n${trace.join(" → ")}`,
      { cause: error }
    );
  }
}
