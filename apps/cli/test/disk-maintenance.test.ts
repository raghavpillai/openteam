import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installationPaths } from "../src/config";
import { ComposeProject } from "../src/docker";
import {
  maintenanceWarning,
  registerDatabaseBackup,
  retainDatabaseBackups,
  retainStackImages,
} from "../src/disk-maintenance";
import type { CommandRunner, RunResult } from "../src/process";
import { createDatabaseBackup } from "../src/update-safety";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const id = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
class Docker implements CommandRunner {
  calls: string[][] = [];
  images = new Map<string, Set<string>>();
  digests = new Map<string, string[]>();
  containers: Array<{
    Image: string;
    Config: { Labels: Record<string, string> };
    State: { Running: boolean };
  }> = [];
  refs: Record<string, string> = {};
  failInventory = false;
  failRemove = false;
  run(_command: string, args: readonly string[]): RunResult {
    this.calls.push([...args]);
    let output: unknown = "";
    if (args[0] === "image" && args[1] === "tag") this.images.get(args[2]!)!.add(args[3]!);
    else if (args[0] === "image" && args[1] === "rm") {
      if (this.failRemove) return { status: 1, stdout: "", stderr: "fixture removal refused" };
      for (const [key, tags] of this.images) {
        const digests = this.digests.get(key) ?? [];
        const removed = tags.delete(args[2]!) || digests.includes(args[2]!);
        const remaining = digests.filter((ref) => ref !== args[2]);
        this.digests.set(key, remaining);
        if (removed && tags.size === 0 && remaining.length === 0) this.images.delete(key);
      }
    } else if (args[0] === "image" && args[1] === "inspect") {
      output = args.slice(2).map((ref) => {
        const entry = [...this.images].find(
          ([key, tags]) => key === ref || tags.has(ref) || key === this.refs[ref]
        );
        if (!entry) throw new Error(`unknown fixture image ${ref}`);
        return {
          Id: entry[0],
          RepoTags: [...entry[1]],
          RepoDigests: this.digests.get(entry[0]) ?? [],
        };
      });
    } else if (args[0] === "container" && args[1] === "ls") {
      if (this.failInventory) return { status: 1, stdout: "", stderr: "inventory unavailable" };
      return {
        status: 0,
        stdout: this.containers.map((_, i) => (i + 1).toString(16).padStart(64, "0")).join("\n"),
        stderr: "",
      };
    } else if (args[0] === "container" && args[1] === "inspect")
      output = this.containers.map((container, index) => ({
        ...container,
        Id: (index + 1).toString(16).padStart(64, "0"),
      }));
    else if (args.includes("config"))
      output = {
        services: Object.fromEntries(
          Object.keys(this.refs).map((ref, i) => [String(i), { image: ref }])
        ),
      };
    return {
      status: 0,
      stdout: typeof output === "string" ? output : JSON.stringify(output),
      stderr: "",
    };
  }
}
const fixture = () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "openteam-maintenance-")));
  directories.push(directory);
  const paths = installationPaths(directory);
  writeFileSync(paths.compose, "services: {}\n");
  writeFileSync(paths.environment, "");
  mkdirSync(paths.backups);
  const runner = new Docker();
  for (let i = 1; i <= 12; i++) runner.images.set(id(i), new Set());
  const project = new ComposeProject(
    paths,
    { executable: "docker", prefix: ["compose"], version: "2.30.0", supported: true },
    runner,
    "custom-install"
  );
  return { paths, runner, project };
};

test("retains current and prior full stacks across successive updates and new project objects", () => {
  const { paths, runner, project } = fixture();
  retainStackImages(paths, project, runner, [id(1), id(2)], [id(3), id(4)]);
  const first = JSON.parse(readFileSync(join(paths.directory, "image-retention.json"), "utf8"));
  const restarted = new ComposeProject(paths, project.command, runner, project.projectName);
  retainStackImages(paths, restarted, runner, [id(3), id(4)], [id(5), id(6)]);
  expect(runner.images.has(id(1))).toBe(false);
  expect(runner.images.has(id(2))).toBe(false);
  for (const n of [3, 4, 5, 6]) expect(runner.images.has(id(n))).toBe(true);
  retainStackImages(paths, restarted, runner, [id(5), id(6)], [id(7), id(8)]);
  expect(runner.images.has(id(3))).toBe(false);
  expect(
    JSON.parse(readFileSync(join(paths.directory, "image-retention.json"), "utf8")).owner
  ).toBe(first.owner);
  expect(runner.calls.some((args) => args.includes("prune") || args.includes("--force"))).toBe(
    false
  );
  expect(
    runner.calls.some((args) =>
      ["volume", "network", "system", "builder", "buildx"].includes(args[0]!)
    )
  ).toBe(false);
});

test("preserves running/stopped container images, other installations, manual tags, and untracked images", () => {
  for (const protection of ["running", "stopped", "other-install", "manual", "unknown"]) {
    const { paths, runner, project } = fixture();
    if (protection !== "unknown") retainStackImages(paths, project, runner, [id(1)], [id(2)]);
    const digest = `registry.example/team@${id(99)}`;
    runner.images.get(id(1))!.add(digest);
    runner.digests.set(id(1), [digest]);
    if (protection === "running" || protection === "stopped")
      runner.containers.push({
        Image: id(1),
        Config: { Labels: {} },
        State: { Running: protection === "running" },
      });
    if (protection === "other-install")
      runner.images.get(id(1))!.add(`openteam-retention-${randomUUID()}:${id(1).slice(7)}`);
    if (protection === "manual") runner.images.get(id(1))!.add("network-test:manual");
    retainStackImages(paths, project, runner, [id(2)], [id(3)]);
    expect(runner.images.has(id(1))).toBe(true);
    expect(runner.images.has(id(12))).toBe(true);
    expect(runner.calls.filter((args) => args[0] === "image" && args[1] === "rm")).toHaveLength(0);
  }
});

test("removes retired containerd digest references and image layers before forgetting ownership", () => {
  const { paths, runner, project } = fixture();
  const digests = [`ghcr.io/team/computer@${id(1)}`, `registry.example:5000/computer@${id(99)}`];
  runner.images.get(id(1))!.add(digests[0]!);
  runner.images.get(id(1))!.add(digests[1]!);
  runner.digests.set(id(1), digests);
  retainStackImages(paths, project, runner, [id(1)], [id(2)]);
  const ledgerPath = join(paths.directory, "image-retention.json");
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const marker = `openteam-retention-${ledger.owner}:${id(1).slice(7)}`;

  retainStackImages(paths, project, runner, [id(2)], [id(3)]);

  expect(runner.images.has(id(1))).toBe(false);
  expect(runner.images.has(id(2))).toBe(true);
  expect(runner.images.has(id(3))).toBe(true);
  expect(runner.calls.filter((args) => args[0] === "image" && args[1] === "rm")).toEqual(
    [...digests, marker].map((ref) => ["image", "rm", ref])
  );
  expect(JSON.parse(readFileSync(ledgerPath, "utf8")).owned).not.toContain(id(1));
});

test("forcing an unchanged release preserves the previous distinct rollback stack across restarts", () => {
  const { paths, runner, project } = fixture();
  retainStackImages(paths, project, runner, [id(1), id(2)], [id(3), id(4)]);
  const restarted = new ComposeProject(paths, project.command, runner, project.projectName);
  retainStackImages(paths, restarted, runner, [id(3), id(4)], [id(4), id(3)]);
  retainStackImages(paths, restarted, runner, [id(4), id(3)], [id(3), id(4)]);
  expect(runner.calls.filter((args) => args[0] === "image" && args[1] === "rm")).toEqual([]);
  const ledger = JSON.parse(readFileSync(join(paths.directory, "image-retention.json"), "utf8"));
  expect(ledger.rollback).toEqual([id(1), id(2)]);
  for (const n of [1, 2, 3, 4]) expect(runner.images.has(id(n))).toBe(true);
  retainStackImages(paths, restarted, runner, [id(3), id(4)], [id(5), id(6)]);
  expect(runner.images.has(id(1))).toBe(false);
  for (const n of [3, 4, 5, 6]) expect(runner.images.has(id(n))).toBe(true);
});

test("missing inventory or malformed history prevents removals; removal failure only warns", () => {
  for (const failure of ["inventory", "history", "remove"]) {
    const { paths, runner, project } = fixture();
    retainStackImages(paths, project, runner, [id(1)], [id(2)]);
    if (failure === "history")
      writeFileSync(
        join(paths.directory, "image-retention.json"),
        '{"schemaVersion":1,"owned":["../../bad"]}'
      );
    if (failure === "inventory") runner.failInventory = true;
    if (failure === "remove") runner.failRemove = true;
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() =>
        maintenanceWarning("test", () =>
          retainStackImages(paths, project, runner, [id(2)], [id(3)])
        )
      ).not.toThrow();
      expect(warning).toHaveBeenCalled();
      expect(runner.images.has(id(1))).toBe(true);
      if (failure !== "remove") expect(runner.calls.some((args) => args[1] === "rm")).toBe(false);
    } finally {
      warning.mockRestore();
    }
  }
});

const dump = (directory: string, i: number) =>
  join(directory, `postgres-1.0.0-before-1.1.0-2026-11-0${i}T00-00-00-000Z-${randomUUID()}.sql`);
const backups = () => {
  const f = fixture();
  const files = Array.from({ length: 6 }, (_, i) => dump(f.paths.backups, i + 1));
  for (const path of files) {
    writeFileSync(path, "private database bytes");
    registerDatabaseBackup(f.paths, path);
  }
  return { ...f, files };
};

test("backup retention refuses symlinked files, directories, and traversal in history", () => {
  for (const mode of ["file", "directory", "traversal"]) {
    const { paths, files } = backups();
    const outside = join(paths.directory, "manual.sql");
    writeFileSync(outside, "precious");
    if (mode === "file") {
      rmSync(files[0]!);
      symlinkSync(outside, files[0]!);
    }
    if (mode === "directory") {
      rmSync(paths.backups, { recursive: true });
      symlinkSync(paths.directory, paths.backups);
    }
    if (mode === "traversal")
      writeFileSync(
        join(paths.directory, "backup-retention.json"),
        JSON.stringify({ schemaVersion: 1, directory: paths.directory, files: ["../manual.sql"] })
      );
    expect(() => retainDatabaseBackups(paths, files[5]!)).toThrow();
    expect(readFileSync(outside, "utf8")).toBe("precious");
  }
});

test("backup creation refuses symlink directories and path traversal before invoking pg_dump", () => {
  const { paths, project, runner } = fixture();
  expect(() => createDatabaseBackup(paths, project, "../../oops", "1.2.3")).toThrow(
    "Invalid version"
  );
  rmSync(paths.backups, { recursive: true });
  symlinkSync(paths.directory, paths.backups);
  expect(() => createDatabaseBackup(paths, project, "1.0.0", "1.2.3")).toThrow("ambiguous path");
  expect(runner.calls).toHaveLength(0);
});

test("backup retention can be disabled or increased; invalid settings preserve all restore points", () => {
  for (const count of ["0", "invalid"]) {
    const { paths, files } = backups();
    writeFileSync(paths.environment, `OPENTEAM_BACKUP_RETENTION_COUNT=${count}\n`);
    if (count === "0") retainDatabaseBackups(paths, files[5]!);
    else expect(() => retainDatabaseBackups(paths, files[5]!)).toThrow("backups preserved");
    expect(files.every(existsSync)).toBe(true);
  }
});

