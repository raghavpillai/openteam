import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installationPaths } from "../src/config";
import {
  boundedDoctorRunner,
  checkContainers,
  runServiceProbe,
  STORAGE_PROBE,
  WORKER_PROBE,
} from "../src/doctor-probes";
import type { ComposeProject } from "../src/docker";
import { renderDoctor } from "../src/doctor-ui";
import { checkInferenceConnection } from "../src/inference-connection";
import type { RunOptions, RunResult } from "../src/process";
import { SystemCommandRunner } from "../src/process";
import { checkTranscription } from "../src/transcription-check";
import { scratch } from "./fixtures/harness";

const s = scratch();

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

  test.each(["unhealthy"])("fails %s health even when running", (health) => {
    expect(containers(inspect({ health }))[0]?.level).toBe("fail");
  });
  test.each([137])("fails schema deployment with exit code %d", (exitCode) => {
    const checks = containers(
      `${inspect()}\n${inspect({ service: "migrate", state: "exited", exitCode })}`
    );
    expect(checks.find((c) => c.label === "Schema setup")?.level).toBe("fail");
  });
  test("exec failures and timeouts fail every dependent check", () => {
    const error = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    const checks = runServiceProbe(projectWith({ ...result(""), status: 1, error }), "server", "", [
      "Database",
      "Computer API",
    ]);
    expect(checks.every((c) => c.level === "fail" && c.detail.includes("timed out"))).toBe(true);
  });
  test.each([
    { name: "default bot identity", initialUid: 0, env: {}, expectedUid: 1000, expectedGid: 1000 },
    {
      name: "non-root computer",
      initialUid: 2003,
      env: {},
      expectedUid: 2003,
      expectedGid: undefined,
    },
  ])("workspace probe uses $name", async ({ initialUid, env, expectedUid, expectedGid }) => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-storage-"));
    let uid: number = initialUid;
    const identities: unknown[] = [];
    let output = "";
    // Exercise the embedded probe without requiring root on the test host.
    const probeProcess = {
      env: { ...env, OPENTEAM_DOCTOR_STORAGE: "computer", OPENTEAM_WORKSPACE_ROOT: directory },
      getuid: () => uid,
      setgroups: (groups: number[]) => identities.push(groups),
      setgid: (gid: number) => identities.push(gid),
      setuid: (value: number) => {
        identities.push(value);
        uid = value;
      },
      stdout: {
        write: (text: string, done: () => void) => {
          output += text;
          done();
        },
      },
    };
    try {
      await new Function("process", `return (async () => {${STORAGE_PROBE}})()`)(probeProcess);
      expect(identities).toEqual(initialUid === 0 ? [[], expectedGid, expectedUid] : []);
      expect(JSON.parse(output)).toEqual([
        {
          level: "pass",
          label: directory,
          detail: `Read, write, and delete verified as UID ${expectedUid}`,
        },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test("a stale worker heartbeat is a failure rather than a false pass", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-heartbeat-"));
    const path = join(directory, "heartbeat");
    writeFileSync(path, JSON.stringify({ instance: "test", updatedAt: Date.now() - 30_000 }));
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
  test.each(["healthy", "hung"])("handles %s responses", async (mode) => {
    const directory = mkdtempSync(join(tmpdir(), "ot-socket-"));
    const heartbeat = join(directory, "h");
    const socket = join(directory, "s");
    writeFileSync(heartbeat, JSON.stringify({ instance: "self", updatedAt: Date.now() }));
    const server = createServer((_request, response) => {
      if (mode === "hung") return;
      response.writeHead(200).end(
        JSON.stringify({
          ok: true,
          instance: "self",
          consumer: "self",
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

test("doctor checks transcription through the authenticated server and reports optional setup", async () => {
  const token = "private-installation-token";
  let response = Response.json({
    level: "warn",
    status: "missing",
    detail: "Not configured; voice notes are disabled.",
  });
  let calls = 0;
  const server = s.serve((request) => {
    calls++;
    expect(new URL(request.url).pathname).toBe(
      "/api/v0/internal/server-settings/transcription/check"
    );
    expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
    return response.clone();
  });
  const paths = installationPaths(s.dir("openteam-transcription-doctor-"));
  writeFileSync(
    paths.environment,
    `OPENTEAM_CONTROL_TOKEN=${token}\nOPENTEAM_API_PORT=${server.port}\n`
  );
  const missing = await checkTranscription(paths);
  expect(missing).toMatchObject({ label: "Transcription", level: "warn" });
  const rendered = renderDoctor({ installed: true, ok: true, checks: [missing] }, { color: false });
  expect(rendered).toContain("VOICE NOTES");
  expect(rendered).not.toContain(token);
  response = Response.json({
    level: "fail",
    detail: "The transcription provider rejected the API key.",
  });
  expect((await checkTranscription(paths)).level).toBe("fail");
  response = Response.json({ level: "invalid", detail: "bad" });
  expect((await checkTranscription(paths)).level).toBe("fail");
  expect(calls).toBe(3);
  response = new Response(null, { status: 401 });
  expect((await checkTranscription(paths)).level).toBe("fail");
  response = new Response(null, { status: 404 });
  expect((await checkTranscription(paths)).level).toBe("fail");
  expect(calls).toBe(5);
});

const settings = {
  providerId: "openai-codex",
  modelId: "gpt-5.6-sol",
  reasoning: "medium",
} as const;

const probeFixture = (result: RunResult = { status: 0, stdout: '{"ok":true}\n', stderr: "" }) => {
  const calls: Array<{ args: readonly string[]; options: RunOptions }> = [];
  const project = {
    run(args: readonly string[], options: RunOptions) {
      calls.push({ args, options });
      return result;
    },
  } as unknown as ComposeProject;
  return { project, calls };
};

describe("model connection probe", () => {
  test.each([
    "anthropic",
  ])("uses the saved %s model and thinking setting without exporting credentials", (providerId) => {
    const { project, calls } = probeFixture();
    const selected = {
      ...settings,
      providerId,
      modelId: providerId === "anthropic" ? "claude-sonnet-5" : settings.modelId,
    };
    expect(checkInferenceConnection(project, selected).ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.slice(0, 5)).toEqual(["exec", "--no-TTY", "server", "bun", "-e"]);
    expect(JSON.parse(calls[0]!.options.input!)).toEqual({
      kind: "verification",
      instructions: "This is a connection test. Reply with only OK.",
      prompt: "Reply OK.",
      timeoutMs: 30_000,
      model: `${selected.providerId}/${selected.modelId}`,
      reasoning: "medium",
    });
    expect(calls[0]?.options.timeoutMs).toBe(40_000);
  });

  test("redacts Docker errors and never treats them as model success", () => {
    const { project } = probeFixture({
      status: 1,
      stdout: '{"ok":true}',
      stderr: "request failed: Bearer secretControlToken0123456789",
    });
    expect(checkInferenceConnection(project, settings)).toEqual({
      ok: false,
      detail: `${settings.providerId}/${settings.modelId}: request failed: Bearer [REDACTED]`,
    });
  });
});

describe("connection probe executed in Bun", () => {
  test.each([
    { status: 200, body: { text: "OK" }, ok: true },
    {
      status: 401,
      body: { error: "Invalid provider credential" },
      ok: false,
      error: "HTTP 401: Invalid provider credential",
    },
  ])("validates an actual HTTP response: %j", async ({ status, body, ok, error }) => {
    const received: Array<{ path: string; method: string; authorized: boolean; body: unknown }> =
      [];
    const token = "test-control-token";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        received.push({
          path: new URL(request.url).pathname,
          method: request.method,
          authorized: request.headers.get("authorization") === `Bearer ${token}`,
          body: await request.json(),
        });
        return Response.json(body, { status });
      },
    });
    const { project, calls } = probeFixture();
    checkInferenceConnection(project, settings);
    const input = calls[0]!.options.input!;
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", calls[0]!.args.at(-1)!],
      env: {
        PATH: process.env.PATH,
        OPENTEAM_COMPUTER_URL: server.url.href,
        OPENTEAM_CONTROL_TOKEN: token,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(input);
    child.stdin.end();
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      const result = JSON.parse(stdout);
      expect(result.ok).toBe(ok);
      if (error) expect(result.error).toContain(error);
      expect(received).toEqual([
        { path: "/v1/infer", method: "POST", authorized: true, body: JSON.parse(input) },
      ]);
      expect(stdout).not.toContain(token);
      if (ok) expect(result).toEqual({ ok: true });
    } finally {
      child.kill();
      server.stop(true);
    }
  });
});
