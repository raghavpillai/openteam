import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boundedDoctorRunner,
  checkContainers,
  runServiceProbe,
  STORAGE_PROBE,
  WORKER_PROBE,
} from "../src/doctor-probes";
import type { ComposeProject } from "../src/docker";
import type { RunOptions, RunResult } from "../src/process";
import { SystemCommandRunner } from "../src/process";

const result = (stdout: string): RunResult => ({ status: 0, stdout, stderr: "" });
const projectWith = (output: RunResult) => ({ run: () => output }) as unknown as ComposeProject;

describe("doctor service probes", () => {
  test("a process that ignores SIGTERM still exits at the timeout", () => {
    const started = Date.now();
    const response = boundedDoctorRunner(new SystemCommandRunner()).run(
      "node",
      ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
      { timeoutMs: 200 }
    );
    expect(response.status).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(response.error).toMatchObject({ code: "ETIMEDOUT" });
  });
  test("bounds every Docker command, including callers with a longer timeout", () => {
    const timeouts: number[] = [];
    const runner = boundedDoctorRunner({
      run: (_command, _args, options) => {
        timeouts.push(options!.timeoutMs!);
        return result("");
      },
    });
    runner.run("docker", ["info"]);
    runner.run("docker-compose", ["ps"], { timeoutMs: 90_000 });
    runner.run("docker", ["exec"], { timeoutMs: 40_000 });
    expect(timeouts).toEqual([10_000, 40_000, 40_000]);
  });

  const inspect = (overrides: object = {}) =>
    JSON.stringify({
      service: "worker",
      state: "running",
      health: "none",
      restarts: 0,
      exitCode: 0,
      startedAt: new Date().toISOString(),
      ...overrides,
    });
  const containers = (stdout: string) =>
    checkContainers(projectWith(result("a".repeat(64))), { run: () => result(stdout) }, ["worker"]);

  test.each(["unhealthy", "starting"])("fails %s health even when running", (health) => {
    expect(containers(inspect({ health }))[0]?.level).toBe("fail");
  });
  test("detects a recent restart loop and reports historical restarts as a warning", () => {
    expect(containers(inspect({ restarts: 4 }))[0]?.level).toBe("fail");
    expect(containers(inspect({ restarts: 4, startedAt: "2020-01-01T00:00:00Z" }))[0]?.level).toBe(
      "warn"
    );
  });
  test.each([1, 137])("fails schema deployment with exit code %d", (exitCode) => {
    const checks = containers(
      `${inspect()}\n${inspect({ service: "migrate", state: "exited", exitCode })}`
    );
    expect(checks.find((c) => c.label === "Schema setup")?.level).toBe("fail");
  });
  test("does not infer a successful schema deployment from a missing container", () => {
    expect(containers(inspect()).find((c) => c.label === "Schema setup")?.level).toBe("warn");
  });
  test.each(["null", "{}", "[]", "invalid"])("rejects malformed inspection %s", (data) => {
    expect(containers(data)[0]?.level).toBe("fail");
  });
  test("exec failures and timeouts fail every dependent check", () => {
    const error = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    const checks = runServiceProbe(projectWith({ ...result(""), status: 1, error }), "server", "", [
      "Database",
      "Computer API",
    ]);
    expect(checks.every((c) => c.level === "fail" && c.detail.includes("timed out"))).toBe(true);
  });
  test("rejects reordered or incomplete probe output and redacts errors", () => {
    expect(
      runServiceProbe(
        projectWith(result('[{"label":"wrong","level":"pass","detail":"ok"}]')),
        "server",
        "",
        ["Database"]
      )[0]?.level
    ).toBe("fail");
    const secret = "sk-proj-doctorInvalid0123456789012345";
    const checks = runServiceProbe(
      projectWith(
        result(JSON.stringify([{ label: "Database", level: "fail", detail: `API key ${secret}` }]))
      ),
      "server",
      "",
      ["Database"]
    );
    expect(checks[0]?.detail).not.toContain(secret);
  });
  test("storage probes use Node in the worker and Bun in the computer, with bounded exec", () => {
    const calls: Array<{ args: readonly string[]; options?: RunOptions }> = [];
    const project = {
      run: (args: readonly string[], options?: RunOptions) => {
        calls.push({ args, options });
        return result("[]");
      },
    } as unknown as ComposeProject;
    runServiceProbe(project, "worker", STORAGE_PROBE, ["storage"], true);
    runServiceProbe(project, "computer", STORAGE_PROBE, ["storage"], true);
    expect(calls[0]?.args).toContain("node");
    expect(calls[1]?.args).toContain("bun");
    expect(calls[1]?.args).toContain("OPENTEAM_DOCTOR_STORAGE=computer");
    expect(calls.every((c) => c.options?.timeoutMs === 15_000)).toBe(true);
  });
  test.each([
    "missing",
    "stale",
    "future",
    "malformed",
  ])("%s worker heartbeat is a failure rather than a false pass", async (state) => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-heartbeat-"));
    const path = join(directory, "heartbeat");
    if (state !== "missing")
      writeFileSync(
        path,
        state === "malformed"
          ? "{broken"
          : JSON.stringify({
              instance: "test",
              updatedAt: Date.now() + (state === "stale" ? -30_000 : 30_000),
            })
      );
    try {
      const script = WORKER_PROBE.replace(
        '"/tmp/openteam-worker-heartbeat.json"',
        JSON.stringify(path)
      );
      const process = Bun.spawn(["node", "-e", `(async () => {${script}})()`], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const checks = JSON.parse(await new Response(process.stdout).text());
      expect(await process.exited).toBe(0);
      expect(checks[0]).toMatchObject({ level: "fail", label: "Worker heartbeat" });
      expect(checks[1]).toMatchObject({ level: "warn", label: "Queue round trip" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === "win32")("actual worker diagnostic socket probe", () => {
  test.each([
    "healthy",
    "foreign",
    "false-200",
    "false-503",
    "invalid",
    "hung",
  ])("handles %s responses", async (mode) => {
    const directory = mkdtempSync(join(tmpdir(), "ot-socket-"));
    const heartbeat = join(directory, "h");
    const socket = join(directory, "s");
    writeFileSync(heartbeat, JSON.stringify({ instance: "self", updatedAt: Date.now() }));
    const server = createServer((_request, response) => {
      if (mode === "hung") return;
      response
        .writeHead(mode === "false-503" ? 503 : 200)
        .end(
          mode === "invalid"
            ? "null"
            : JSON.stringify({
                ok: mode !== "false-200",
                instance: "self",
                consumer: mode === "foreign" ? "other" : "self",
                durationMs: 1,
              })
        );
    });
    try {
      await new Promise<void>((resolve) => server.listen(socket, resolve));
      const script = WORKER_PROBE.replaceAll(
        '"/tmp/openteam-worker-heartbeat.json"',
        JSON.stringify(heartbeat)
      )
        .replaceAll('"/tmp/openteam-worker-doctor.sock"', JSON.stringify(socket))
        .replace("}, 10000)", "}, 150)");
      const child = Bun.spawn(["node", "-e", `(async () => {${script}})()`], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const watchdog = setTimeout(() => child.kill("SIGKILL"), 2_000);
      try {
        const checks = JSON.parse(await new Response(child.stdout).text());
        expect(await child.exited).toBe(0);
        expect(checks[0].level).toBe("pass");
        expect(checks[1].level).toBe(mode === "healthy" ? "pass" : "fail");
        if (mode === "hung") expect(checks[1].detail).toContain("timed out");
      } finally {
        clearTimeout(watchdog);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
