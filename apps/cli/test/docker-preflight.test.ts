import { describe, expect, test } from "bun:test";
import { startDockerDesktop } from "../src/docker-preflight";
import type { CommandRunner, RunResult } from "../src/process";

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
            error: Object.assign(new Error("spawn docker ENOENT"), {
              code: "ENOENT",
            }),
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
    const printed = writes.join("");
    expect(printed).toContain("Starting Docker Desktop…");
    expect(printed).toContain("Waiting for Docker to be ready…");
    expect(printed).toContain("Docker Desktop is running.");
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
