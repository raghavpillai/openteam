import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { installationPaths } from "../src/config";
import {
  ADDRESS_POOLS_EXHAUSTED_ADVICE,
  ComposeProject,
  composeProcessEnvironment,
  findCompose,
} from "../src/docker";
import { startDockerDesktop } from "../src/docker-preflight";
import type { CommandRunner, RunOptions, RunResult } from "../src/process";
import { scratch } from "./fixtures/harness";

const s = scratch();

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
  test("prefers the plugin, falls back to standalone Compose, and rejects legacy versions", () => {
    expect(findCompose(new RecordingRunner(true))).toMatchObject({
      executable: "docker",
      prefix: ["compose"],
    });
    expect(findCompose(new RecordingRunner(false))).toMatchObject({
      executable: "docker-compose",
      prefix: [],
    });
    expect(findCompose(new LegacyComposeRunner())).toMatchObject({ supported: false });
  });

  test("always scopes lifecycle calls to the installation and project", () => {
    const directory = s.dir("openteam-cli-docker-");
    const paths = installationPaths(directory);
    writeFileSync(paths.compose, "name: openteam\n");
    writeFileSync(paths.environment, "OPENTEAM_VERSION=1.3.0\nOPENTEAM_CONTROL_TOKEN=secret\n");
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
      "openteam",
      "--project-directory",
      directory,
      "--env-file",
      paths.environment,
      "--file",
      paths.compose,
      "stop",
    ]);
    expect(
      composeProcessEnvironment(paths, {
        PATH: "/usr/bin",
        OPENTEAM_VERSION: "1.2.3",
        OPENTEAM_CONTROL_TOKEN: "stale",
      })
    ).toEqual({ PATH: "/usr/bin" });
    expect(call?.options?.env?.OPENTEAM_VERSION).toBeUndefined();
  });
});

describe("Docker Compose failure diagnosis", () => {
  const exhausted =
    "Error response from daemon: all predefined address pools have been fully subnetted";

  test("explains exhausted Docker address pools after an inherited up fails", () => {
    const runner: CommandRunner = {
      run: (_command, args) =>
        args[1] === "version"
          ? { status: 0, stdout: "Docker Compose version v2.30.0", stderr: "" }
          : { status: 1, stdout: "", stderr: exhausted },
    };
    const paths = installationPaths(s.dir("openteam-cli-docker-"));
    writeFileSync(paths.compose, "name: openteam\n");
    writeFileSync(paths.environment, "OPENTEAM_VERSION=1.3.0\n");
    const project = new ComposeProject(paths, findCompose(runner)!, runner);
    expect(() => project.runOrThrow(["up", "--detach"], { inherit: true })).toThrow(
      ADDRESS_POOLS_EXHAUSTED_ADVICE
    );
  });
});

const stopped =
  "Cannot connect to the Docker daemon at unix:///Users/me/.docker/run/docker.sock. Is the docker daemon running?";

/** A Docker Desktop whose engine starts after `open` and a number of polls. */
class DesktopRunner implements CommandRunner {
  readonly calls: string[] = [];
  opened = false;
  polls = 0;
  context = "desktop-linux";

  constructor(private readonly readyAfterPolls = 2) {}

  run(command: string, args: readonly string[]): RunResult {
    const call = `${command} ${args.join(" ")}`;
    this.calls.push(call);
    const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
    if (command === "open") {
      this.opened = true;
      return ok();
    }
    if (args[0] === "--version") return ok("Docker version 29.0.0");
    if (args[0] === "context") return ok(`${this.context}\n`);
    if (args[0] === "info") {
      if (this.opened && ++this.polls > this.readyAfterPolls) return ok("29.0.0");
      return { status: 1, stdout: "", stderr: stopped };
    }
    return { status: 99, stdout: "", stderr: "unexpected" };
  }
}

const terminal = () => {
  const writes: string[] = [];
  return {
    writes,
    output: { isTTY: true, write: (chunk: string) => writes.push(chunk) > 0 },
  };
};

const options = (output: ReturnType<typeof terminal>["output"]) => ({
  platform: "darwin" as const,
  environment: { TERM: "xterm-256color" },
  application: "/Applications/Docker.app",
  output,
  sleep: async () => undefined,
  intervalMs: 2_000,
});

describe("Docker Desktop start", () => {
  test("opens a stopped Docker Desktop and waits for its engine", async () => {
    const runner = new DesktopRunner(2);
    const { writes, output } = terminal();
    expect(await startDockerDesktop(runner, options(output))).toBe("ready");
    expect(runner.calls).toContain("open -a /Applications/Docker.app");
    expect(writes.join("")).toContain("Docker Desktop is running.");
  });

  test("leaves running engines, other runtimes, and non-interactive runs alone", async () => {
    const running = new DesktopRunner(0);
    running.opened = true;
    const { output } = terminal();
    expect(await startDockerDesktop(running, options(output))).toBe("skipped");
    expect(running.calls).not.toContain("open -a /Applications/Docker.app");

    const colima = new DesktopRunner();
    colima.context = "colima";
    expect(await startDockerDesktop(colima, options(output))).toBe("skipped");
    expect(colima.opened).toBe(false);

    for (const override of [
      { output: { isTTY: false, write: () => true } },
      { environment: { DOCKER_HOST: "ssh://build-host" } },
      { platform: "linux" as const },
      { application: null },
    ]) {
      const runner = new DesktopRunner();
      expect(await startDockerDesktop(runner, { ...options(output), ...override })).toBe("skipped");
      expect(runner.opened).toBe(false);
    }
  });
});
