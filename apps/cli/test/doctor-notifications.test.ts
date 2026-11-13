import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import {
  APNS_CONFIGURATION_PROBE,
  notificationChecks,
  runNotificationChecks,
} from "../src/doctor-notifications";
import { doctorNextSteps, renderDoctor } from "../src/doctor-ui";
import type { ComposeProject } from "../src/docker";
import { parseArguments } from "../src/arguments";
import { readApnsConfiguration } from "../src/notifications";

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
    expect(check(checks, "iOS push credentials")).toMatchObject({
      level: "fail",
    });
    expect(check(checks, "iOS push credentials").detail).toContain("running worker");
    expect(check(checks, "iOS push delivery")).toMatchObject({ level: "fail" });
    expect(check(checks, "iOS push delivery").detail).toContain("87");
    const result = { ok: false, installed: true, checks };
    expect(renderDoctor(result, { color: false, width: 100 })).toContain("NOTIFICATIONS");
    expect(doctorNextSteps(result).join("\n")).toContain("notifications configure");
    // A key for another app's bundle ID is the same silent failure.
    const wrongTopic = notificationChecks(state, {
      ...config,
      topic: "dev.openteam.mobile.swift",
    });
    expect(check(wrongTopic, "iOS push credentials").level).toBe("fail");
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
      expect(JSON.parse(first.output)).toMatchObject({
        ...config,
        source: "database",
      });
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
});

const privateKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const metadata = { keyId: "ABCDE12345", teamId: "FGHIJ67890", topic: "dev.openbot.mobile" };
describe("APNs configuration import", () => {
  test("rejects ambiguous imports, unknown fields, malformed JSON and oversized files without exposing contents", () => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-apns-invalid-"));
    const path = join(directory, "apns.json");
    const options = parseArguments(["notifications", "configure", "--config", path]);
    try {
      writeFileSync(
        path,
        JSON.stringify({ ...metadata, privateKey, privateKeyFile: "secret-key-path" })
      );
      expect(() => readApnsConfiguration(options)).toThrow("Choose one");
      writeFileSync(
        path,
        JSON.stringify({ ...metadata, privateKey, secretUnknownField: "secret-value" })
      );
      expect(() => readApnsConfiguration(options)).toThrow("Unknown APNs configuration field");
      writeFileSync(path, "secret-value".repeat(4000));
      expect(() => readApnsConfiguration(options)).toThrow(
        "Could not read valid APNs configuration JSON"
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
