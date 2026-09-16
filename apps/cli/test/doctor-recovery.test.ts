import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installationPaths } from "../src/config";
import { runDoctor, type DoctorResult } from "../src/doctor";
import { doctorNextSteps, renderCompactDoctor, renderDoctor } from "../src/doctor-ui";
import { dockerFailureCheck } from "../src/docker-diagnostics";
import type { CommandRunner, RunResult } from "../src/process";

const unavailable =
  "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";
const failure = (stderr: string): RunResult => ({ status: 1, stdout: "", stderr });
const failedDoctor = (checks: DoctorResult["checks"]): DoctorResult => ({
  ok: false,
  installed: false,
  checks,
});

describe("doctor recovery advice", () => {
  test.skipIf(process.platform === "win32")(
    "reproduces a stopped engine through the actual install and doctor CLI without starting services",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "openteam-docker-recovery-"));
      try {
        const bin = join(directory, "bin");
        const installDirectory = join(directory, "installation");
        const callsFile = join(directory, "docker-calls");
        mkdirSync(bin);
        writeFileSync(
          join(bin, "docker"),
          `#!/bin/sh
printf '%s\\n' "$*" >> "$OPENTEAM_TEST_DOCKER_CALLS"
case "$*" in
  --version) printf '%s\\n' 'Docker version 28.2.2, build e6534b4' ;;
  'compose version') printf '%s\\n' 'Docker Compose version v5.1.3' ;;
  'info --format {{.ServerVersion}}') printf '%s\\n' '${unavailable}' >&2; exit 1 ;;
  *) printf '%s\\n' 'Unexpected Docker command' >&2; exit 99 ;;
esac
`,
          { mode: 0o755 }
        );
        for (const command of ["install", "doctor"]) {
          const child = Bun.spawn(
            [
              process.execPath,
              resolve(import.meta.dir, "../src/main.ts"),
              command,
              "--dir",
              installDirectory,
            ],
            {
              env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH}`,
                NO_COLOR: "1",
                OPENTEAM_TEST_DOCKER_CALLS: callsFile,
              },
              stdout: "pipe",
              stderr: "pipe",
            }
          );
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          const output = `${stdout}\n${stderr}`.replace(/\s+/g, " ");
          expect(exitCode).toBe(2);
          expect(output).toContain(
            "Docker is installed, but OpenTeam could not connect to its engine."
          );
          expect(output).toContain(unavailable);
          expect(output).toContain("NEXT STEPS");
          expect(output).toContain("docker info");
          expect(output).toContain("docker context ls");
          if (process.platform === "darwin") expect(output).toContain("open -a Docker");
          expect(output.replace(/\s/g, "")).toContain(`openteaminstall--dir'${installDirectory}'`);
          expect(output).not.toContain("Fix the doctor failures above");
          expect(existsSync(installDirectory)).toBe(false);
        }
        const calls = (await Bun.file(callsFile).text()).trim().split("\n");
        expect(calls).toEqual([
          "--version",
          "info --format {{.ServerVersion}}",
          "compose version",
          "--version",
          "info --format {{.ServerVersion}}",
          "compose version",
        ]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  test.each([
    [
      "permission denied while trying to connect to the Docker daemon socket",
      "Docker denied access",
      "your user has access",
    ],
    [
      "client version 1.24 is too old. Minimum supported API version is 1.44",
      "API version",
      "DOCKER_API_VERSION",
    ],
    ["x509: certificate has expired", "trusted connection", "TLS certificates"],
    ['context "old-engine": context not found', "selected connection", "docker context use <name>"],
    [
      "Cannot connect to the Docker daemon at tcp://build-host:2376",
      "could not connect",
      "host is reachable",
    ],
  ])("preserves and explains the engine failure: %s", (error, explanation, recovery) => {
    const check = dockerFailureCheck("daemon", failure(error), "darwin");
    expect(check.detail).toContain(explanation);
    expect(check.diagnostic).toContain(error);
    expect(check.action).toContain(recovery);
    expect(check.action).not.toContain("open -a Docker");
  });

  test("reports timeout and executable permission errors without calling them missing Docker", () => {
    const timeout = dockerFailureCheck("daemon", {
      ...failure(""),
      error: Object.assign(new Error("spawnSync docker ETIMEDOUT"), { code: "ETIMEDOUT" }),
    });
    expect(timeout.detail).toContain("timed out");
    expect(timeout.diagnostic).toContain("Command timed out");
    const denied = dockerFailureCheck("cli", {
      ...failure(""),
      error: Object.assign(new Error("spawnSync docker EACCES"), { code: "EACCES" }),
    });
    expect(denied.detail).not.toContain("not found");
    expect(denied.action).toContain("executable's permissions");
  });

  test("keeps both Compose command errors and recommends updating an unsupported version", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-compose-recovery-"));
    try {
      for (const legacy of [false, true]) {
        const runner: CommandRunner = {
          run(command, args) {
            if (args[0] === "--version")
              return { status: 0, stdout: "Docker version 28.2.2", stderr: "" };
            if (args[0] === "info") return { status: 0, stdout: "28.2.2", stderr: "" };
            if (command === "docker-compose") return failure("standalone executable is missing");
            return legacy
              ? { status: 0, stdout: "Docker Compose version v1.29.2", stderr: "" }
              : failure("compose is not a docker command");
          },
        };
        const result = await runDoctor(installationPaths(directory), runner, "openteam", {
          checkInstallPorts: false,
        });
        const check = result.checks.find((c) => c.label === "Docker Compose")!;
        expect(check.level).toBe("fail");
        const output = renderCompactDoctor(result, { color: false }).replace(/\s+/g, " ");
        expect(output).toContain("2.20.0 or newer");
        if (legacy) expect(output).toContain("v1.29.2");
        else {
          expect(output).toContain("compose is not a docker command");
          expect(output).toContain("standalone executable is missing");
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("both report formats keep diagnostics readable and redact secrets and terminal controls", () => {
    const secret = "sk-proj-doctorInvalid0123456789012345";
    const check = dockerFailureCheck(
      "daemon",
      failure(`permission denied; API_KEY=${secret}\x1b[2J\rspoof`)
    );
    const result = failedDoctor([{ ...check, action: `${check.action} API_KEY=${secret}\x1b[2J` }]);
    for (const render of [renderDoctor, renderCompactDoctor]) {
      for (const width of [24, 40, 76, 110]) {
        for (const color of [false, true]) {
          const output = render(result, { width, color });
          const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
          expect(output).not.toContain(secret);
          expect(output).not.toContain("\x1b[2J");
          expect(output).not.toContain("\r");
          expect(plain.split("\n").every((line) => line.length <= width)).toBe(true);
          expect(plain).toContain("NEXT STEPS");
          expect(plain.replace(/\s+/g, " ")).toContain("permission denied");
        }
      }
    }
  });
});

test.each([
  [
    "Queue round trip",
    "Worker dependencies unavailable: authenticated computer API",
    "same installation control token",
  ],
  ["Queue round trip", "Worker dependencies unavailable: storage access", "volume permissions"],
  ["Queue round trip", "Worker dependencies unavailable: database/schema", "logs postgres"],
  ["Computer API", "Computer readiness failed (HTTP 401)", "OPENTEAM_CONTROL_TOKEN"],
])("explains dependency recovery for %s: %s", (label, detail, action) => {
  const output = renderDoctor(
    { ok: false, installed: true, checks: [{ level: "fail", label, detail }] },
    { width: 110, color: false }
  );
  expect(output.replace(/\s+/g, " ")).toContain(action);
});
