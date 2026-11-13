import { describe, expect, test } from "bun:test";
import { doctorNextSteps } from "../src/doctor-ui";
import { dockerFailureCheck } from "../src/docker-diagnostics";
import type { RunResult } from "../src/process";

const failure = (stderr: string): RunResult => ({ status: 1, stdout: "", stderr });
const socketDenied = failure(
  "permission denied while trying to connect to the docker API at unix:///var/run/docker.sock"
);
const membership = (configuredMember: boolean) => ({
  socketPath: "/var/run/docker.sock",
  username: "azureuser",
  groupName: "docker",
  configuredMember,
  activeMember: false,
});

describe("doctor recovery advice", () => {
  test("separates missing Docker group membership from a stale login", () => {
    const missing = dockerFailureCheck("daemon", socketDenied, "linux", membership(false));
    expect(missing.detail).toBe(
      "Docker's local socket (/var/run/docker.sock) belongs to the docker group, but azureuser is not a member."
    );
    expect(missing.action).toContain("sudo usermod -aG docker azureuser");
    expect(missing.action).toContain("root-equivalent access");
    const stale = dockerFailureCheck("daemon", socketDenied, "linux", membership(true));
    expect(stale.detail).toContain("this terminal has not picked up");
    expect(stale.action).not.toContain("usermod");
  });

  test("next steps resolve Docker first and quote a custom directory for the shell", () => {
    const steps = doctorNextSteps({
      ok: false,
      installed: true,
      commandDirectory: "/tmp/team's $HOME",
      checks: [
        { label: "Compose services", level: "fail", detail: "not running: server" },
        { label: "Owner account", level: "fail", detail: "missing" },
        {
          label: "Docker daemon",
          level: "fail",
          detail: "unreachable",
          action: "Open Docker Desktop and run docker info.",
        },
      ],
    });
    expect(steps[0]).toContain("Open Docker Desktop");
    expect(steps.join(" ")).not.toContain("openteam setup");
    const start = doctorNextSteps({
      ok: false,
      installed: true,
      commandDirectory: "/tmp/team's $HOME",
      checks: [{ label: "Compose services", level: "fail", detail: "not running: server" }],
    });
    expect(start[0]).toContain("openteam start --dir '/tmp/team'\\''s $HOME'");
  });
});
