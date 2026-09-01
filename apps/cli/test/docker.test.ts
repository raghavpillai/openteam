import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installationPaths } from "../src/config";
import { ComposeProject, findCompose } from "../src/docker";
import type { CommandRunner, RunOptions, RunResult } from "../src/process";

class RecordingRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[]; options?: RunOptions }> = [];

  constructor(private readonly pluginAvailable: boolean) {}

  run(command: string, args: readonly string[], options?: RunOptions): RunResult {
    this.calls.push({ command, args, options });
    if (command === "docker" && args[0] === "compose" && args[1] === "version") {
      return this.pluginAvailable
        ? { status: 0, stdout: "Docker Compose version v2.30.0", stderr: "" }
        : { status: 1, stdout: "", stderr: "unknown command" };
    }
    if (command === "docker-compose" && args[0] === "version") {
      return { status: 0, stdout: "Docker Compose version 5.5.0", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  }
}

class LegacyComposeRunner implements CommandRunner {
  run(command: string, args: readonly string[]): RunResult {
    if (command === "docker" && args[0] === "compose") {
      return { status: 0, stdout: "Docker Compose version v1.29.2", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "not found" };
  }
}

describe("Docker Compose command selection", () => {
  test("prefers the Docker Compose plugin", () => {
    const runner = new RecordingRunner(true);
    expect(findCompose(runner)).toMatchObject({ executable: "docker", prefix: ["compose"] });
  });

  test("falls back to standalone Docker Compose", () => {
    const runner = new RecordingRunner(false);
    expect(findCompose(runner)).toMatchObject({ executable: "docker-compose", prefix: [] });
  });

  test("marks legacy Compose implementations as unsupported", () => {
    expect(findCompose(new LegacyComposeRunner())).toMatchObject({ supported: false });
  });

  test("always scopes lifecycle calls to the installation and project", () => {
    const directory = mkdtempSync(join(tmpdir(), "openbot-cli-docker-"));
    try {
      const paths = installationPaths(directory);
      writeFileSync(paths.compose, "name: openbot\n");
      const runner = new RecordingRunner(true);
      const command = findCompose(runner);
      expect(command).not.toBeNull();
      if (!command) throw new Error("expected Docker Compose to be available");
      new ComposeProject(paths, command, runner).run(["stop"]);
      const call = runner.calls.at(-1);
      expect(call?.command).toBe("docker");
      expect(call?.args).toEqual([
        "compose",
        "--project-name",
        "openbot",
        "--project-directory",
        directory,
        "--file",
        paths.compose,
        "stop",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
