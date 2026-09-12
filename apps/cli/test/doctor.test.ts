import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArguments } from "../src/arguments";
import {
  createEnvironment,
  installationPaths,
  parseEnvironment,
  replaceEnvironmentValue,
  writeFileAtomic,
  writeManifest,
} from "../src/config";
import {
  firstUnavailablePort,
  portAvailable,
  runDoctor,
  suggestApiPort,
  viewerPorts,
} from "../src/doctor";
import { SERVER_PROBE, WORKER_PROBE, STORAGE_PROBE } from "../src/doctor-probes";
import { doctorCommand } from "../src/lifecycle";
import type { CommandRunner, RunOptions, RunResult } from "../src/process";

describe("installation ports", () => {
  test("reports an occupied port and suggests the next available default", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    const port = server.port;
    if (!port) throw new Error("Expected Bun to allocate a port");
    try {
      expect(await portAvailable("127.0.0.1", port)).toBe(false);
      expect(await firstUnavailablePort("127.0.0.1", [port])).toBe(port);
      const suggested = await suggestApiPort("127.0.0.1", port);
      expect(suggested).not.toBe(port);
      expect(await portAvailable("127.0.0.1", suggested)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("enumerates the complete fixed screen-viewer range", () => {
    const ports = viewerPorts();
    expect(ports).toHaveLength(100);
    expect(ports[0]).toBe(6200);
    expect(ports.at(-1)).toBe(6299);
  });
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const installedFixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "openteam-doctor-connection-"));
  const paths = installationPaths(directory);
  const environment = createEnvironment({ version: "1.2.3" });
  const token = parseEnvironment(environment).get("OPENTEAM_CONTROL_TOKEN");
  const state = {
    inference: "ready",
    health: "ready",
    version: "1.2.3",
    settingsStatus: 200,
    invalidSettings: false,
    transcriptionLevel: "warn" as "pass" | "warn" | "fail",
    selected: { providerId: "openai-codex", modelId: "gpt-5.6-sol", reasoning: "medium" },
    requests: [] as Array<{ method: string; path: string }>,
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      state.requests.push({ method: request.method, path });
      if (path === "/api/v0/health")
        return Response.json({
          status: state.health,
          runtime: { inference: state.inference },
          release: { releaseVersion: state.version },
        });
      if (path === "/api/v0/internal/server-settings") {
        if (request.headers.get("authorization") !== `Bearer ${token}`)
          return new Response(null, { status: 401 });
        if (state.settingsStatus !== 200)
          return Response.json(
            { error: { message: "Settings unavailable" } },
            { status: state.settingsStatus }
          );
        return Response.json(state.invalidSettings ? {} : { inference: state.selected });
      }
      if (path === "/api/v0/internal/server-settings/transcription/check") {
        if (request.headers.get("authorization") !== `Bearer ${token}`)
          return new Response(null, { status: 401 });
        return Response.json({
          level: state.transcriptionLevel,
          detail: "Transcription diagnostic",
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  cleanups.push(() => {
    server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  });
  writeFileAtomic(
    paths.environment,
    replaceEnvironmentValue(environment, "OPENTEAM_API_PORT", String(server.port))
  );
  writeFileAtomic(
    paths.compose,
    "name: openteam\nservices:\n  server:\n    image: example/server\n"
  );
  const now = new Date().toISOString();
  writeManifest(paths, {
    schemaVersion: 1,
    repository: "owner/repo",
    version: "1.2.3",
    composeUrl: "https://example.test/compose.yaml",
    installedAt: now,
    updatedAt: now,
    ownerUsername: "openteam",
  });
  class DoctorRunner implements CommandRunner {
    running = ["postgres", "server", "worker", "computer"];
    probes: Array<{ args: readonly string[]; options?: RunOptions }> = [];
    result: RunResult = { status: 0, stdout: '{"ok":true}\n', stderr: "" };
    run(command: string, args: readonly string[], options?: RunOptions): RunResult {
      if (command === "docker" && args[0] === "--version")
        return { status: 0, stdout: "Docker version 29.0.0", stderr: "" };
      if (command === "docker" && args[0] === "info")
        return { status: 0, stdout: "29.0.0", stderr: "" };
      if (args[0] === "compose" && args[1] === "version")
        return { status: 0, stdout: "Docker Compose version v2.30.0", stderr: "" };
      if (args.includes("ps") && args.includes("--services"))
        return { status: 0, stdout: this.running.join("\n"), stderr: "" };
      if (args.includes("ps") && args.includes("--quiet"))
        return { status: 0, stdout: "a".repeat(64), stderr: "" };
      if (args[0] === "inspect")
        return {
          status: 0,
          stdout: [...this.running, "migrate"]
            .map((service) =>
              JSON.stringify({
                service,
                state: service === "migrate" ? "exited" : "running",
                health: "healthy",
                exitCode: 0,
                restarts: 0,
                startedAt: new Date().toISOString(),
              })
            )
            .join("\n"),
          stderr: "",
        };
      if (args.includes("exec") && !options?.input) {
        const script = args.at(-1)!;
        const labels = script.includes(SERVER_PROBE)
          ? ["Database", "Pending jobs", "Run leases", "Computer API"]
          : script.includes(WORKER_PROBE)
            ? ["Worker heartbeat", "Queue round trip"]
            : script.includes(STORAGE_PROBE)
              ? args.includes("computer")
                ? ["workspace"]
                : ["agents", "assets"]
              : [];
        return {
          status: 0,
          stdout: JSON.stringify(
            labels.map((label) => ({ label, level: "pass", detail: "Verified" }))
          ),
          stderr: "",
        };
      }
      if (args.includes("exec")) {
        this.probes.push({ args, options });
        return this.result;
      }
      return { status: 0, stdout: "", stderr: "" };
    }
  }
  return { paths, state, runner: new DoctorRunner() };
};

describe("doctor model API connection", () => {
  test("optional transcription setup warns while provider failure makes doctor fail", async () => {
    const { paths, state, runner } = installedFixture();
    const missing = await runDoctor(paths, runner, "openteam", { deepChecks: true });
    expect(missing.ok).toBe(true);
    expect(missing.checks).toContainEqual({
      label: "Transcription",
      level: "warn",
      detail: "Transcription diagnostic",
    });
    state.transcriptionLevel = "fail";
    const unavailable = await runDoctor(paths, runner, "openteam", { deepChecks: true });
    expect(unavailable.ok).toBe(false);
    expect(unavailable.checks.find((check) => check.label === "Transcription")?.level).toBe("fail");
    expect(state.requests.some((request) => request.path.endsWith("/audio/transcriptions"))).toBe(
      false
    );
  });
  test("the doctor command tests the saved model once without modifying settings", async () => {
    const { paths, state, runner } = installedFixture();
    const output: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...args) => {
      output.push(args.join(" "));
    });
    try {
      await doctorCommand(paths, parseArguments(["doctor"]), runner);
    } finally {
      log.mockRestore();
    }
    expect(runner.probes).toHaveLength(1);
    expect(JSON.parse(runner.probes[0]!.options!.input!)).toMatchObject({
      model: "openai-codex/gpt-5.6-sol",
      reasoning: "medium",
    });
    expect(
      state.requests.every(
        (request) =>
          request.method === "GET" ||
          (request.method === "POST" &&
            request.path === "/api/v0/internal/server-settings/transcription/check")
      )
    ).toBe(true);
    expect(output.join("\n")).toContain("✓ AI connection");
    expect(output.join("\n")).toContain("openai-codex/gpt-5.6-sol responded");
  });

  test("returns exit code 2 for failed inference even when health and credentials pass", async () => {
    const { paths, runner } = installedFixture();
    const secret = "sk-proj-doctorInvalid0123456789012345";
    runner.result.stdout = JSON.stringify({
      ok: false,
      error: `HTTP 401: Invalid API key ${secret}`,
    });
    const output: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...args) => {
      output.push(args.join(" "));
    });
    try {
      await expect(doctorCommand(paths, parseArguments(["doctor"]), runner)).rejects.toMatchObject({
        exitCode: 2,
      });
    } finally {
      log.mockRestore();
    }
    expect(output.join("\n")).toContain("✗ AI connection");
    expect(output.join("\n")).toContain("HTTP 401");
    expect(output.join("\n")).not.toContain(secret);
  });

  test.each([
    "HTTP 429: quota exceeded",
    "model is unavailable",
    "network connection refused",
  ])("reports %s as a blocking problem", async (error) => {
    const { paths, runner } = installedFixture();
    runner.result.stdout = JSON.stringify({ ok: false, error });
    const result = await runDoctor(paths, runner, "openteam", { testInference: true });
    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual({
      level: "fail",
      label: "AI connection",
      detail: `openai-codex/gpt-5.6-sol: ${error}`,
    });
  });

  test("marks unconfigured inference as not tested instead of passing it", async () => {
    const { paths, state, runner } = installedFixture();
    state.inference = "missing";
    const result = await runDoctor(paths, runner, "openteam", { testInference: true });
    expect(result.ok).toBe(true);
    expect(result.checks).toContainEqual({
      level: "warn",
      label: "AI connection",
      detail: "not tested; no provider is connected. Run openteam setup",
    });
    expect(runner.probes).toHaveLength(0);
    expect(
      state.requests.filter((request) => !request.path.endsWith("/transcription/check"))
    ).toHaveLength(1);
  });

  test.each([
    "unhealthy",
    "foreign server",
    "stopped computer",
    "wrong release",
  ])("does not send a model request for an %s installation", async (condition) => {
    const { paths, state, runner } = installedFixture();
    if (condition === "unhealthy") state.health = "starting";
    if (condition === "foreign server") runner.running = ["postgres", "computer"];
    if (condition === "stopped computer") runner.running = ["postgres", "server", "worker"];
    if (condition === "wrong release") state.version = "9.9.9";
    const result = await runDoctor(paths, runner, "openteam", { testInference: true });
    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.label === "AI connection")?.detail).toContain(
      "not tested"
    );
    expect(runner.probes).toHaveLength(0);
    expect(
      state.requests.filter((request) => !request.path.endsWith("/transcription/check"))
    ).toHaveLength(1);
  });

  test("does not send inference when the settings API rejects this installation's control token", async () => {
    const { paths, state, runner } = installedFixture();
    state.settingsStatus = 401;
    const result = await runDoctor(paths, runner, "openteam", { testInference: true });
    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.label === "AI connection")?.detail).toContain(
      "rejected this installation's control token"
    );
    expect(runner.probes).toHaveLength(0);
  });

  test("does not invent a model when runtime settings are missing", async () => {
    const { paths, state, runner } = installedFixture();
    state.invalidSettings = true;
    const result = await runDoctor(paths, runner, "openteam", { testInference: true });
    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.label === "AI connection")?.detail).toContain(
      "invalid runtime settings"
    );
    expect(runner.probes).toHaveLength(0);
  });

  test("routine setup health checks do not generate model requests", async () => {
    const { paths, runner } = installedFixture();
    const result = await runDoctor(paths, runner);
    expect(result.ok).toBe(true);
    expect(runner.probes).toHaveLength(0);
    expect(result.checks.some((check) => check.label === "AI connection")).toBe(false);
  });

  test("stopped services skip dependent probes and never start containers", async () => {
    const { paths, runner } = installedFixture();
    runner.running = [];
    const calls: readonly string[][] = [];
    const original = runner.run.bind(runner);
    const recording: CommandRunner = {
      run: (command, args, options) => {
        (calls as string[][]).push([...args]);
        return original(command, args, options);
      },
    };
    const result = await runDoctor(paths, recording, "openteam", {
      deepChecks: true,
      testInference: true,
    });
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.label === "Worker heartbeat")).toMatchObject({
      level: "warn",
    });
    expect(
      calls.some((args) => args.includes("up") || args.includes("start") || args.includes("exec"))
    ).toBe(false);
  });

  test("an invalid manifest is included in the report instead of throwing before rendering", async () => {
    const { paths, runner } = installedFixture();
    writeFileSync(paths.manifest, "{broken");
    const result = await runDoctor(paths, runner, "openteam", { deepChecks: true });
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.label === "Installation")?.detail).toContain(
      "Invalid installation manifest"
    );
  });

  test("distinguishes an incomplete installation from a fresh machine", async () => {
    const { paths, runner } = installedFixture();
    rmSync(paths.compose);
    expect(await runDoctor(paths, runner, "openteam", { checkInstallPorts: false })).toMatchObject({
      ok: false,
      installed: false,
    });
    rmSync(paths.environment);
    rmSync(paths.manifest);
    expect(await runDoctor(paths, runner, "openteam", { checkInstallPorts: false })).toMatchObject({
      ok: true,
      installed: false,
    });
  });
});
