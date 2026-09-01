import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installationPaths } from "../src/config";
import { acquireUpdateLock, readUpdateState, writeUpdateState } from "../src/update-safety";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("update transaction safety", () => {
  test("rejects concurrent updates and releases the installation lock", () => {
    const directory = mkdtempSync(join(tmpdir(), "openbot-update-lock-"));
    temporaryDirectories.push(directory);
    const paths = installationPaths(directory);
    const release = acquireUpdateLock(paths);
    expect(() => acquireUpdateLock(paths)).toThrow("already running");
    release();
    expect(existsSync(paths.updateLock)).toBe(false);
    const releaseAgain = acquireUpdateLock(paths);
    releaseAgain();
  });

  test("persists update jobs atomically for reconnecting clients", () => {
    const directory = mkdtempSync(join(tmpdir(), "openbot-update-state-"));
    temporaryDirectories.push(directory);
    const paths = installationPaths(directory);
    writeUpdateState(paths, {
      schemaVersion: 1,
      jobId: "job-1",
      status: "running",
      phase: "pulling",
      fromVersion: "1.2.3",
      targetVersion: "1.3.0",
      message: "Pulling images",
      startedAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(readUpdateState(paths)).toMatchObject({
      jobId: "job-1",
      status: "running",
      phase: "pulling",
    });
  });
});
