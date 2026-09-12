import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installationPaths } from "../src/config";
import { ComposeProject } from "../src/docker";
import type { CommandRunner, RunOptions, RunResult } from "../src/process";
import { assertServerReachable, inspectStartupState } from "../src/startup";

describe("startup forwarding diagnosis", () => {
  test("requires the bundled HTTPS proxy only when its profile is enabled", () => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-cli-startup-"));
    const paths = installationPaths(directory);
    writeFileSync(paths.compose, "services: {}\n");
    const services = ["postgres", "server", "worker", "computer"].map((Service) => ({
      Service,
      State: "running",
      Health: "healthy",
    }));
    const runner: CommandRunner = {
      run: () => ({ status: 0, stdout: JSON.stringify(services), stderr: "" }),
    };
    const project = new ComposeProject(
      paths,
      { executable: "docker", prefix: ["compose"], version: "2.30.0", supported: true },
      runner
    );
    try {
      expect(inspectStartupState(project, new Map())).toEqual({ stopped: false, notReady: [] });
      const environment = new Map([["COMPOSE_PROFILES", "https"]]);
      expect(inspectStartupState(project, environment)).toEqual({
        stopped: false,
        notReady: ["caddy"],
      });
      services.push({ Service: "caddy", State: "running", Health: "" });
      expect(inspectStartupState(project, environment)).toEqual({ stopped: false, notReady: [] });
      services.push({ Service: "worker", State: "running", Health: "unhealthy" });
      expect(inspectStartupState(project, environment).notReady).toEqual(["worker"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("requires evidence of both a failed host connection and a ready container", () => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-cli-startup-"));
    const paths = installationPaths(directory);
    writeFileSync(paths.compose, "services: {}\n");
    const calls: RunOptions[] = [];
    let result: RunResult = { status: 0, stdout: "ready\n", stderr: "" };
    const runner: CommandRunner = {
      run(_command, _args, options) {
        calls.push(options ?? {});
        return result;
      },
    };
    const project = new ComposeProject(
      paths,
      { executable: "docker", prefix: ["compose"], version: "2.30.0", supported: true },
      runner
    );
    const health = {
      ok: false,
      url: "http://127.0.0.1:8787/api/v0/health",
      detail: "fetch failed (ECONNREFUSED)",
      connectionFailed: true,
    };
    try {
      expect(() =>
        assertServerReachable(project, { ...health, connectionFailed: false, detail: "HTTP 503" })
      ).not.toThrow();
      expect(calls).toHaveLength(0);
      expect(() => assertServerReachable(project, health)).toThrow("ready inside Docker");
      expect(calls.at(-1)?.timeoutMs).toBe(5_000);
      for (const failure of [
        { status: 0, stdout: "", stderr: "" },
        { status: 1, stdout: "", stderr: "container is starting" },
        { status: 1, stdout: "", stderr: "timed out" },
      ]) {
        result = failure;
        expect(() => assertServerReachable(project, health)).not.toThrow();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
