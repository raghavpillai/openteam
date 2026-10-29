import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installationPaths } from "../src/config";
import {
  activeUpdateProcess,
  acquireUpdateLock,
  pruneUpdateBackups,
  readUpdateEvents,
  readUpdateState,
  writeUpdateState,
} from "../src/update-safety";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("update transaction safety", () => {
  test("rejects concurrent updates and releases the installation lock", () => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-update-lock-"));
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
    const directory = mkdtempSync(join(tmpdir(), "openteam-update-state-"));
    temporaryDirectories.push(directory);
    const paths = installationPaths(directory);
    const initial = writeUpdateState(paths, {
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
      sequence: 0,
    });
    writeUpdateState(paths, {
      ...initial,
      phase: "complete",
      status: "complete",
      message: "Update complete",
    });
    expect(readUpdateEvents(paths, "job-1").map((event) => event.sequence)).toEqual([0, 1]);
  });

  test("treats the detached CLI bootstrap as active before it takes the server lock", () => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-update-bootstrap-"));
    temporaryDirectories.push(directory);
    const paths = installationPaths(directory);
    writeUpdateState(paths, {
      schemaVersion: 1,
      jobId: "job-1",
      workerPid: process.pid,
      status: "running",
      phase: "updating-cli",
      fromVersion: "1.2.3",
      targetVersion: "1.3.0",
      message: "Downloading command-line tools",
      startedAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(activeUpdateProcess(paths)).toBe(process.pid);
  });

  test("keeps the newest update backups and the current one, and nothing else is touched", () => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-update-backups-"));
    temporaryDirectories.push(directory);
    const paths = installationPaths(directory);
    expect(pruneUpdateBackups(paths, null)).toEqual([]);
    mkdirSync(paths.backups);
    const backup = (from: string, to: string, at: string) =>
      `postgres-${from}-before-${to}-${at}.sql`;
    const names = [
      backup("0.0.7", "0.0.8", "2026-10-24T10-00-00-000Z"),
      backup("0.0.8", "0.0.9", "2026-10-26T10-00-00-000Z"),
      backup("0.0.9", "0.0.10", "2026-10-26T18-00-00-000Z"),
      backup("0.0.10", "0.0.11", "2026-11-02T09-00-00-000Z"),
      backup("0.0.11", "0.0.12", "2026-11-09T09-00-00-000Z"),
      "my-own-dump.sql",
      "postgres-notes.txt",
    ];
    for (const name of names) writeFileSync(join(paths.backups, name), "SELECT 1;\n");
    // A clock set back makes this update's own backup sort as the oldest; rollback still needs it.
    const current = join(paths.backups, names[0]!);
    expect(pruneUpdateBackups(paths, current)).toEqual([names[1]!]);
    expect(readdirSync(paths.backups).sort()).toEqual([names[0]!, ...names.slice(2)].sort());
    expect(pruneUpdateBackups(paths, null, 1)).toEqual([names[3]!, names[2]!, names[0]!]);
    expect(readdirSync(paths.backups).sort()).toEqual(
      [names[4]!, "my-own-dump.sql", "postgres-notes.txt"].sort()
    );
  });
});
