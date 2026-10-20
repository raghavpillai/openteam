import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DOCKER_CLI_MISSING } from "../src/docker-diagnostics";
import { dockerMissing, renderDockerRequired, startDockerDesktop } from "../src/docker-preflight";
import type { CommandRunner, RunResult } from "../src/process";
import { terminalTextWidth } from "../src/terminal";

const stopped =
  "Cannot connect to the Docker daemon at unix:///Users/me/.docker/run/docker.sock. Is the docker daemon running?";

/** A Docker Desktop whose engine starts after `open` and a number of polls. */
class DesktopRunner implements CommandRunner {
  readonly calls: string[] = [];
  opened = false;
  polls = 0;
  context = "desktop-linux";
  installed = true;

  constructor(private readonly readyAfterPolls = 2) {}

  run(command: string, args: readonly string[]): RunResult {
    const call = `${command} ${args.join(" ")}`;
    this.calls.push(call);
    const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
    if (command === "open") {
      this.opened = true;
      this.installed = true;
      return ok();
    }
    if (args[0] === "--version")
      return this.installed
        ? ok("Docker version 29.0.0")
        : {
            status: 1,
            stdout: "",
            stderr: "",
            error: Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }),
          };
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
  return { writes, output: { isTTY: true, write: (chunk: string) => writes.push(chunk) > 0 } };
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
    const printed = writes.join("");
    expect(printed).toContain("Starting Docker Desktop…");
    expect(printed).toContain("Waiting for Docker to be ready…");
    expect(printed).toContain("Docker Desktop is running.");
  });

  test("opens Docker Desktop when its docker command is not installed yet", async () => {
    const runner = new DesktopRunner(0);
    runner.installed = false;
    const { output } = terminal();
    expect(await startDockerDesktop(runner, options(output))).toBe("ready");
    expect(runner.opened).toBe(true);
  });

  test("gives up after the timeout and lets preflight explain the failure", async () => {
    const runner = new DesktopRunner(Number.POSITIVE_INFINITY);
    const { writes, output } = terminal();
    let clock = 0;
    const result = await startDockerDesktop(runner, {
      ...options(output),
      timeoutMs: 120_000,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    });
    expect(result).toBe("timed-out");
    expect(runner.polls).toBe(60);
    expect(writes.join("")).toContain("Docker Desktop did not finish starting within 2 minutes.");
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

describe("Docker required", () => {
  test("is a short block with the install link and how to continue", () => {
    for (const width of [24, 40, 80]) {
      for (const [platform, link] of [
        ["darwin", "Install Docker Desktop: https://www.docker.com/products/docker-desktop/"],
        ["win32", "Install Docker Desktop: https://www.docker.com/products/docker-desktop/"],
        [
          "linux",
          "Install Docker Engine and the Compose plugin: https://docs.docker.com/engine/install/",
        ],
      ] as const) {
        const block = renderDockerRequired("openteam setup", { platform, width, color: false });
        expect(block.split("\n").every((line) => terminalTextWidth(line) <= width)).toBe(true);
        const text = block.replace(/\s+/g, " ").trim();
        if (width === 80) {
          expect(text).toBe(`✗ Docker is required. ${link} Then run: openteam setup`);
        }
      }
    }
    expect(
      renderDockerRequired("/Users/me/.local/bin/openteam setup", {
        platform: "darwin",
        desktopStarting: true,
        color: false,
        width: 80,
      })
        .replace(/\s+/g, " ")
        .trim()
    ).toBe(
      "✗ Docker Desktop is installed but not ready. Open Docker Desktop and finish its setup. Then run: /Users/me/.local/bin/openteam setup"
    );
  });

  test("applies only when the docker command itself is missing", () => {
    const result = (detail: string) => ({
      ok: false,
      installed: false,
      checks: [{ level: "fail" as const, label: "Docker CLI", detail }],
    });
    expect(dockerMissing(result(DOCKER_CLI_MISSING), "/nonexistent")).toBe(true);
    expect(dockerMissing(result("The docker command could not run."), "/nonexistent")).toBe(false);
    // A docker file that cannot run gets the full report about its permissions instead.
    const bin = mkdtempSync(join(tmpdir(), "openteam-docker-path-"));
    try {
      writeFileSync(join(bin, "docker"), "", { mode: 0o644 });
      expect(dockerMissing(result(DOCKER_CLI_MISSING), `/nonexistent${delimiter}${bin}`)).toBe(
        false
      );
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
