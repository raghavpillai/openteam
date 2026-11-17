import { describe, expect, test } from "bun:test";
import {
  UpdateQueue,
  type UpdateQueueDependencies,
  type UpdateQueueState,
} from "../src/renderer/lib/update-queue";
import { serverUpdateTarget } from "../src/renderer/lib/update-plan";
import type { ServerUpdateView } from "@openteam/contracts";

function fixture() {
  const calls: string[] = [];
  let time = 0;
  let saved: UpdateQueueState | null = null;
  const server = {
    version: "0.0.18",
    update: {
      status: "ready",
      targetVersion: null,
      phase: null,
      updaterAvailable: true,
      message: "",
      jobId: null,
      safeToCloseDesktop: false,
    } as ServerUpdateView,
  };
  let desktop = {
    currentVersion: "0.0.18",
    latestVersion: "0.0.19",
    status: "available",
    progress: null,
    message: null,
  } as OpenTeamUpdateStatus;
  const deps: UpdateQueueDependencies = {
    async server() {
      calls.push("server-status");
      return structuredClone(server);
    },
    async busy() {
      calls.push("busy-check");
      return false;
    },
    async startServer(version) {
      calls.push(`server-start:${version}`);
      server.update = { ...server.update, status: "updating", targetVersion: version };
    },
    async desktop() {
      calls.push("desktop-status");
      return desktop;
    },
    async checkDesktop() {
      calls.push("desktop-check");
      desktop = { ...desktop, status: "available" };
      return desktop;
    },
    async downloadDesktop() {
      calls.push("desktop-download");
      desktop = { ...desktop, status: "downloaded" };
    },
    async wait() {
      time += 1_500;
      server.version = "0.0.19";
      server.update.status = "updated";
    },
    now: () => time,
    save: (value) => {
      saved = value && structuredClone(value);
    },
  };
  return {
    calls,
    deps,
    server,
    saved: () => saved,
    setDesktop: (next: Partial<OpenTeamUpdateStatus>) => {
      desktop = { ...desktop, ...next };
    },
  };
}

describe("independent update targets", () => {
  test("matching desktop and server still offer the published release", () => {
    expect(serverUpdateTarget("0.0.18", "0.0.19", "0.0.18")).toBe("0.0.19");
    expect(serverUpdateTarget("0.0.19", null, "0.0.18")).toBe("0.0.19");
  });
  test("unknown, older, invalid and prerelease targets never downgrade a server", () => {
    expect(serverUpdateTarget("0.0.18", "0.0.19", null)).toBeNull();
    expect(serverUpdateTarget("0.0.18", "0.0.19", "0.0.20")).toBeNull();
    expect(serverUpdateTarget("0.0.18", "0.1.0-beta.1", "0.0.18")).toBeNull();
    expect(serverUpdateTarget("0.0.18", "garbage", "0.0.18")).toBeNull();
    expect(serverUpdateTarget("0.0.18", "v0.0.19", "0.0.18")).toBe("0.0.19");
  });
});

describe("server-first update queue", () => {
  test("a desktop release change during download does not complete the reviewed queue", async () => {
    const f = fixture();
    f.deps.downloadDesktop = async () => {
      f.setDesktop({ status: "downloaded", latestVersion: "0.1.0" });
    };
    const queue = new UpdateQueue(f.deps);
    await queue.start("0.0.19");
    expect(queue.snapshot()?.status).toBe("error");
  });
  test("a native download that never resolves times out instead of locking the queue", async () => {
    const f = fixture();
    let time = 0;
    f.deps.now = () => time;
    f.deps.downloadDesktop = async () => {
      f.calls.push("desktop-download");
      f.setDesktop({ status: "downloading", progress: 10 });
      return new Promise<void>(() => {});
    };
    f.deps.wait = async () => {
      time += 31 * 60_000;
      f.server.version = "0.0.19";
      f.server.update.status = "updated";
    };
    const queue = new UpdateQueue(f.deps);
    const result = await Promise.race([
      queue.start("0.0.19").then(() => "settled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 30)),
    ]);
    expect(result).toBe("settled");
    expect(queue.snapshot()).toMatchObject({
      status: "error",
      serverComplete: true,
      step: "desktop",
    });
  });
  test("reopening a desktop step rechecks a previously verified server before downloading", async () => {
    const f = fixture();
    const queue = new UpdateQueue(f.deps, {
      targetVersion: "0.0.19",
      status: "running",
      step: "desktop",
      serverComplete: true,
      serverRequested: true,
      message: "Preparing desktop",
    });
    await queue.resume();
    expect(queue.snapshot()?.status).toBe("error");
    expect(f.calls).toContain("server-status");
    expect(f.calls).not.toContain("desktop-download");
    expect(f.calls.some((call) => call.startsWith("server-start"))).toBe(false);
  });
  test("retrying desktop preserves host acknowledgement while reconnecting", async () => {
    const f = fixture();
    const original = f.deps.server;
    let online = false;
    f.deps.server = async () => {
      if (!online) throw new Error("Offline");
      return original();
    };
    f.deps.wait = async () => {
      // A renderer closed here must still reopen as an observer of the old host request.
      expect(f.saved()).toMatchObject({ serverRequested: true, serverComplete: false });
      online = true;
      f.server.version = "0.0.19";
      f.server.update.status = "updated";
    };
    const queue = new UpdateQueue(f.deps, {
      targetVersion: "0.0.19",
      status: "error",
      step: "desktop",
      serverComplete: true,
      serverRequested: true,
      message: "Download interrupted",
    });
    await queue.retry();
    expect(queue.snapshot()?.status).toBe("complete");
    expect(f.calls.some((call) => call.startsWith("server-start"))).toBe(false);
  });
  test("adopting an existing host job saves that it must not be automatically submitted again", async () => {
    const f = fixture();
    f.server.update = { ...f.server.update, status: "updating", targetVersion: "0.0.19" };
    let checkpoint: UpdateQueueState | null = null;
    f.deps.wait = async () => {
      checkpoint = f.saved();
      f.server.version = "0.0.19";
      f.server.update.status = "updated";
    };
    await new UpdateQueue(f.deps).start("0.0.19");
    expect(checkpoint).toMatchObject({
      status: "running",
      serverRequested: true,
      serverComplete: false,
    });
    expect(f.calls.some((call) => call.startsWith("server-start"))).toBe(false);
    f.calls.length = 0;
    f.server.version = "0.0.18";
    f.server.update.status = "error";
    f.server.update.message = "The adopted update failed";
    const resumed = new UpdateQueue(f.deps, checkpoint);
    await resumed.resume();
    expect(resumed.snapshot()).toMatchObject({
      status: "error",
      message: "The adopted update failed",
    });
    expect(f.calls.some((call) => call.startsWith("server-start"))).toBe(false);
    expect(f.calls).not.toContain("desktop-download");
  });
  test("verifies server before downloading desktop; never installs or restarts automatically", async () => {
    const f = fixture();
    const queue = new UpdateQueue(f.deps);
    await queue.start("0.0.19");
    expect(queue.snapshot()).toMatchObject({
      status: "complete",
      serverComplete: true,
      step: "desktop",
    });
    expect(f.calls).toEqual([
      "server-status",
      "busy-check",
      "server-start:0.0.19",
      "server-status",
      "desktop-status",
      "desktop-download",
      "desktop-status",
    ]);
    expect(f.saved()).toEqual(queue.snapshot());
  });
  test("server failure blocks desktop; retry skips a server already on the new release", async () => {
    const f = fixture();
    f.deps.wait = async () => {
      f.server.update.status = "error";
      f.server.update.message = "Signature verification failed";
    };
    const queue = new UpdateQueue(f.deps);
    await queue.start("0.0.19");
    expect(queue.snapshot()).toMatchObject({
      status: "error",
      step: "server",
      message: "Signature verification failed",
    });
    expect(f.calls).not.toContain("desktop-download");
    f.server.version = "0.0.19";
    f.server.update.status = "updated";
    await queue.retry();
    expect(queue.snapshot()?.status).toBe("complete");
    expect(f.calls.filter((c) => c.startsWith("server-start"))).toHaveLength(1);
  });
  test("does not submit an update when a bot has just become busy", async () => {
    const f = fixture();
    f.deps.busy = async () => true;
    const queue = new UpdateQueue(f.deps);
    await queue.start("0.0.19");
    expect(queue.snapshot()?.status).toBe("error");
    expect(f.calls).not.toContain("desktop-download");
    expect(f.calls.some((c) => c.startsWith("server-start"))).toBe(false);
  });
  test("reopening resumes the host job through a restart without resubmitting it", async () => {
    const f = fixture();
    f.server.update = { ...f.server.update, status: "updating", targetVersion: "0.0.19" };
    const original = f.deps.server;
    let reads = 0;
    f.deps.server = async () => {
      if (++reads === 2) throw new Error("Restarting");
      return original();
    };
    const queue = new UpdateQueue(f.deps, {
      targetVersion: "0.0.19",
      status: "running",
      step: "server",
      serverComplete: false,
      serverRequested: true,
      message: "Updating",
    });
    await queue.resume();
    expect(queue.snapshot()?.status).toBe("complete");
    expect(f.calls.some((c) => c.startsWith("server-start"))).toBe(false);
  });
  test("host completion on the old version and rollback do not advance to desktop", async () => {
    for (const rollback of [false, true]) {
      const f = fixture();
      f.deps.wait = async () => {
        f.server.update.status = rollback ? "updating" : "updated";
        f.server.update.phase = rollback ? "rolling-back" : "complete";
      };
      const queue = new UpdateQueue(f.deps);
      await queue.start("0.0.19");
      expect(queue.snapshot()?.status).toBe("error");
      expect(f.calls).not.toContain("desktop-download");
    }
  });
  test("retrying a desktop download preserves completed server work", async () => {
    const f = fixture();
    f.deps.downloadDesktop = async () => {
      f.calls.push("desktop-download");
      throw new Error("Download interrupted");
    };
    const queue = new UpdateQueue(f.deps);
    await queue.start("0.0.19");
    expect(queue.snapshot()).toMatchObject({
      status: "error",
      serverComplete: true,
      step: "desktop",
    });
    f.setDesktop({ status: "error" });
    f.deps.downloadDesktop = async () => {
      f.calls.push("desktop-download");
      f.setDesktop({ status: "downloaded" });
    };
    await queue.retry();
    expect(queue.snapshot()?.status).toBe("complete");
    expect(f.calls.filter((c) => c.startsWith("server-start"))).toHaveLength(1);
    expect(f.calls).toContain("desktop-check");
  });
  test("duplicate starts share one runner and a different host job is left alone", async () => {
    const f = fixture();
    const queue = new UpdateQueue(f.deps);
    await Promise.all([queue.start("0.0.19"), queue.start("0.0.19"), queue.resume()]);
    expect(f.calls.filter((c) => c.startsWith("server-start"))).toHaveLength(1);
    const other = fixture();
    other.server.update.status = "updating";
    other.server.update.targetVersion = "0.0.20";
    const blocked = new UpdateQueue(other.deps);
    await blocked.start("0.0.19");
    expect(blocked.snapshot()?.status).toBe("error");
    expect(other.calls).not.toContain("desktop-download");
  });
  test("timeouts and changed desktop releases stop the queue", async () => {
    const f = fixture();
    let time = 0;
    f.deps.now = () => time;
    f.deps.wait = async () => {
      time += 16 * 60_000;
    };
    const queue = new UpdateQueue(f.deps);
    await queue.start("0.0.19");
    expect(queue.snapshot()?.status).toBe("error");
    expect(f.calls).not.toContain("desktop-download");
    const changed = fixture();
    changed.setDesktop({ latestVersion: "0.0.20" });
    const next = new UpdateQueue(changed.deps);
    await next.start("0.0.19");
    expect(next.snapshot()?.status).toBe("error");
    expect(changed.calls).not.toContain("desktop-download");
  });
  test("invalid saved data cannot resume work", async () => {
    const f = fixture();
    const queue = new UpdateQueue(f.deps, { targetVersion: "bogus", status: "running" });
    await queue.resume();
    expect(queue.snapshot()).toBeNull();
    expect(f.calls).toEqual([]);
  });
  test("a restarted server on the target version still finishes verification before desktop", async () => {
    const f = fixture();
    f.server.version = "0.0.19";
    f.server.update = {
      ...f.server.update,
      status: "updating",
      phase: "verifying",
      targetVersion: "0.0.19",
    };
    const queue = new UpdateQueue(f.deps);
    await queue.start("0.0.19");
    expect(queue.snapshot()?.status).toBe("complete");
    expect(f.calls.filter((call) => call === "server-status")).toHaveLength(2);
    expect(f.calls.some((call) => call.startsWith("server-start"))).toBe(false);
    expect(f.calls.indexOf("desktop-download")).toBeGreaterThan(
      f.calls.lastIndexOf("server-status")
    );
  });
  test("reopening offline waits, and a persisted host failure needs an explicit retry", async () => {
    const f = fixture();
    let online = false;
    const original = f.deps.server;
    f.deps.server = async () => {
      if (!online) throw new Error("Offline");
      return original();
    };
    f.deps.wait = async () => {
      online = true;
      f.server.update.status = "error";
      f.server.update.message = "Update rolled back";
    };
    const queue = new UpdateQueue(f.deps, {
      targetVersion: "0.0.19",
      status: "running",
      step: "server",
      serverComplete: false,
      serverRequested: true,
      message: "Updating",
    });
    await queue.resume();
    expect(queue.snapshot()).toMatchObject({ status: "error", message: "Update rolled back" });
    expect(f.calls.some((c) => c.startsWith("server-start"))).toBe(false);
    expect(f.calls).not.toContain("desktop-download");
  });
});
