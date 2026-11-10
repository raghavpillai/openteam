import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerUpdates, serverUpdateRoute } from "../src/server-updates";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "openteam-server-updates-"));
  directories.push(directory);
  let now = 1_000;
  const updates = new ServerUpdates(directory, "1.2.3", () => now);
  return {
    updates,
    directory,
    advance: () => {
      now += 31_000;
    },
  };
};

test("requires a live host updater and accepts only a newer stable version, never a destination", () => {
  const { updates, advance } = fixture();
  expect(() => updates.start({ targetVersion: "1.3.0" })).toThrow("openteam start");
  updates.heartbeat({});
  for (const targetVersion of [null, "", "1.2.3", "1.0.0", "1.3.0-beta.1", "1.3.0; reboot"])
    expect(() => updates.start({ targetVersion })).toThrow("newer stable");
  for (const extra of [
    { serverUrl: "https://other.example" },
    { sshTarget: "root@other" },
    { repository: "other/repo" },
  ])
    expect(() => updates.start({ targetVersion: "1.5.0", ...extra })).toThrow("Only targetVersion");
  advance();
  expect(updates.view().updaterAvailable).toBe(false);
  expect(() => updates.start({ targetVersion: "1.5.0" })).toThrow("openteam start");
});

test("deduplicates submissions, persists through server restart, and reports completion", () => {
  const { updates, directory } = fixture();
  updates.heartbeat({});
  const first = updates.start({ targetVersion: "1.5.0" });
  expect(first.status).toBe("updating");
  expect(first.safeToCloseDesktop).toBe(true);
  expect(updates.start({ targetVersion: "1.5.0" }).jobId).toBe(first.jobId);
  expect(() => updates.start({ targetVersion: "1.6.0" })).toThrow("already in progress");
  const request = updates.heartbeat({}).request!;
  updates.heartbeat({ requestId: "different-request", status: "complete" });
  expect(updates.view().status).toBe("updating");
  updates.heartbeat({
    requestId: request.id,
    status: "running",
    phase: "backing-up",
    jobId: "host-job",
    message: "Backing up",
  });
  const restarted = new ServerUpdates(directory, "1.5.0");
  expect(restarted.view()).toMatchObject({
    status: "updating",
    phase: "backing-up",
    jobId: "host-job",
  });
  restarted.heartbeat({
    requestId: request.id,
    status: "complete",
    phase: "complete",
    message: "Updated",
  });
  expect(restarted.view()).toMatchObject({ status: "updated", message: "Updated" });
  restarted.heartbeat({ requestId: request.id, status: "running", message: "Stale progress" });
  expect(restarted.view().status).toBe("updated");
});

test("keeps an updater failure visible and allows a deliberate retry", () => {
  const { updates } = fixture();
  updates.heartbeat({});
  const first = updates.start({ targetVersion: "1.3.0" });
  updates.heartbeat({
    requestId: first.jobId!,
    status: "error",
    phase: "error",
    message: "Rollback completed",
  });
  expect(updates.view()).toMatchObject({ status: "error", message: "Rollback completed" });
  expect(updates.start({ targetVersion: "1.3.0" }).jobId).not.toBe(first.jobId);
});

test("requires an owner session and explicit bearer credential to start maintenance", async () => {
  const { updates } = fixture();
  updates.heartbeat({});
  const request = (authorization?: string) =>
    new Request("https://server.example/api/v0/system/update", {
      method: "POST",
      headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
      body: JSON.stringify({ targetVersion: "1.3.0" }),
    });
  await expect(serverUpdateRoute(request("Bearer token"), updates, null)).rejects.toThrow(
    "Sign in"
  );
  await expect(serverUpdateRoute(request(), updates, "owner-session")).rejects.toThrow("Sign in");
  const response = await serverUpdateRoute(request("Bearer token"), updates, "owner-session");
  expect(response.status).toBe(202);
  expect((await response.json()).status).toBe("updating");
});
