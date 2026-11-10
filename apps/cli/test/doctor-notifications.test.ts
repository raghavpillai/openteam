import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import {
  APNS_CONFIGURATION_PROBE,
  NOTIFICATION_STATE_PROBE,
  notificationChecks,
  runNotificationChecks,
} from "../src/doctor-notifications";
import { doctorNextSteps, renderDoctor } from "../src/doctor-ui";
import type { ComposeProject } from "../src/docker";
import type { RunOptions } from "../src/process";

const state = {
  total: 1,
  eligible: 1,
  invalid: 0,
  topics: ["dev.openbot.mobile"],
  failed: 0,
  waiting: 0,
};
const config = { missing: [], issue: null, topic: "dev.openbot.mobile" };
const missing = ["OPENTEAM_APNS_KEY_ID", "OPENTEAM_APNS_TEAM_ID", "OPENTEAM_APNS_PRIVATE_KEY"];
const check = (checks: ReturnType<typeof notificationChecks>, label: string) =>
  checks.find((c) => c.label === label)!;

describe("Doctor notification readiness", () => {
  test("catches the Azure failure despite healthy services and an enabled phone", () => {
    const checks = notificationChecks({ ...state, failed: 87 }, { ...config, missing });
    expect(check(checks, "iOS push registration").level).toBe("pass");
    expect(check(checks, "iOS push credentials")).toMatchObject({ level: "fail" });
    expect(check(checks, "iOS push credentials").detail).toContain("running worker");
    expect(check(checks, "iOS push delivery")).toMatchObject({ level: "fail" });
    expect(check(checks, "iOS push delivery").detail).toContain("87");
    const result = { ok: false, installed: true, checks };
    const output = renderDoctor(result, { color: false, width: 100 });
    expect(output).toContain("NOTIFICATIONS");
    expect(doctorNextSteps(result).join("\n")).toContain("notifications configure");
    expect(doctorNextSteps(result).join("\n")).toContain("apply it live");
  });

  test("APNs is optional for installations without an eligible iPhone", () => {
    const checks = notificationChecks(
      { ...state, total: 0, eligible: 0, topics: [] },
      { ...config, missing }
    );
    expect(checks.some((c) => c.level === "fail")).toBe(false);
    expect(check(checks, "iOS push registration").detail).toContain("No iOS push registration");
    expect(check(checks, "iOS push credentials").level).toBe("warn");
    expect(checks.map((c) => c.label)).toEqual([
      "iOS push registration",
      "iOS push credentials",
      "iOS push delivery",
    ]);
  });

  test("disabled and expired registrations cannot masquerade as push readiness", () => {
    const checks = notificationChecks({ ...state, eligible: 0, topics: [] }, config);
    expect(check(checks, "iOS push registration")).toMatchObject({ level: "warn" });
    expect(check(checks, "iOS push registration").detail).toContain("no valid login session");
    expect(check(checks, "iOS push delivery").level).toBe("warn");
  });

  test("valid local configuration does not claim Apple acceptance or visible delivery", () => {
    const checks = notificationChecks(state, config);
    expect(check(checks, "iOS push credentials").level).toBe("pass");
    expect(check(checks, "iOS push credentials").detail).toContain("not verified");
    expect(check(checks, "iOS push delivery").detail).toContain("skipped alerts");
  });

  test("checks bundle ID, incomplete device metadata, and stalled deliveries", () => {
    expect(
      check(
        notificationChecks(state, { ...config, topic: "dev.openteam.mobile.swift" }),
        "iOS push credentials"
      ).level
    ).toBe("fail");
    expect(
      check(notificationChecks({ ...state, invalid: 1 }, config), "iOS push registration").level
    ).toBe("fail");
    expect(
      check(notificationChecks({ ...state, waiting: 2 }, config), "iOS push delivery").level
    ).toBe("warn");
  });

  test("executes bounded read-only probes inside the actual services", () => {
    const calls: Array<{ args: readonly string[]; options?: RunOptions }> = [];
    const project = {
      run(args: readonly string[], options?: RunOptions) {
        calls.push({ args, options });
        return {
          status: 0,
          stdout: JSON.stringify(args.includes("worker") ? config : state),
          stderr: "",
        };
      },
    } as unknown as ComposeProject;
    const checks = runNotificationChecks(project, new Set(["server", "worker"]));
    expect(check(checks, "iOS push credentials").level).toBe("pass");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args).toContain("bun");
    expect(calls[1]!.args).toContain("node");
    expect(calls.every((c) => c.options?.timeoutMs === 15_000 && c.args.includes("--no-TTY"))).toBe(
      true
    );
    expect(NOTIFICATION_STATE_PROBE).not.toMatch(/INSERT|UPDATE|DELETE/);
  });

  test.each([
    "{broken",
    "{}",
    "null",
    '{"missing":["secret-token"],"issue":null,"topic":"dev.openbot.mobile"}',
  ])("invalid probe output %s never passes or leaks its contents", (stdout) => {
    const project = { run: () => ({ status: 0, stdout, stderr: "" }) } as unknown as ComposeProject;
    const checks = runNotificationChecks(project, new Set(["server", "worker"]));
    expect(checks.every((c) => c.level === "fail")).toBe(true);
    expect(JSON.stringify(checks)).not.toContain("secret-token");
  });

  test("stopped services are skipped and failed execs never expose stderr", () => {
    let calls = 0;
    const project = {
      run: () => {
        calls++;
        return { status: 1, stdout: "", stderr: "secret-token" };
      },
    } as unknown as ComposeProject;
    expect(runNotificationChecks(project, new Set()).every((c) => c.level === "warn")).toBe(true);
    expect(calls).toBe(0);
    const checks = runNotificationChecks(project, new Set(["server", "worker"]));
    expect(check(checks, "iOS push credentials").level).toBe("fail");
    expect(JSON.stringify(checks)).not.toContain("secret-token");
  });
});

const runConfig = async (socketPath: string) => {
  const script = APNS_CONFIGURATION_PROBE.replace("/tmp/openteam-worker-doctor.sock", socketPath);
  const child = Bun.spawn(
    ["node", "-e", `(async () => {${script}})().catch(() => process.exitCode = 1)`],
    { env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" }
  );
  const output = await new Response(child.stdout).text();
  return { exitCode: await child.exited, output };
};

describe("real APNs worker configuration probe", () => {
  test("reads the worker's live APNs setting from its diagnostics socket", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-apns-socket-"));
    const socket = join(directory, "doctor.sock");
    let issue: string | null = null;
    let status = 200;
    const server = createServer((request, response) => {
      expect(request.url).toBe("/notifications");
      response.statusCode = status;
      response.end(JSON.stringify({ ...config, source: "database", issue }));
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      const first = await runConfig(socket);
      expect(first.exitCode).toBe(0);
      expect(JSON.parse(first.output)).toMatchObject({ ...config, source: "database" });
      issue = "runtime-settings";
      const second = await runConfig(socket);
      expect(JSON.parse(second.output).issue).toBe("runtime-settings");
      expect(
        check(notificationChecks(state, JSON.parse(second.output)), "iOS push credentials").level
      ).toBe("fail");
      // A worker without the endpoint is a failed probe, never an environment guess.
      status = 404;
      expect(await runConfig(socket)).toEqual({ exitCode: 1, output: "" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("fails without a diagnostics socket", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-apns-socket-"));
    try {
      expect(await runConfig(join(directory, "missing.sock"))).toEqual({ exitCode: 1, output: "" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
