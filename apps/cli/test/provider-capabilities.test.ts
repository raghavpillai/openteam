import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installationPaths } from "../src/config";
import { ComposeProject } from "../src/docker";
import type { CommandRunner, RunOptions, RunResult } from "../src/process";
import { supportsCredentialImport } from "../src/provider-capabilities";

describe("installed provider capabilities", () => {
  test("recognizes supported commands even when usage exits nonzero, without sending credentials", () => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-provider-capabilities-"));
    const paths = installationPaths(directory);
    writeFileSync(paths.compose, "services: {}\n");
    const calls: Array<{ args: readonly string[]; options?: RunOptions }> = [];
    let result: RunResult = {
      status: 2,
      stdout: "",
      stderr: "Usage:\n  openteam-pi-auth import <provider>\n",
    };
    const runner: CommandRunner = {
      run(_command, args, options) {
        calls.push({ args, options });
        return result;
      },
    };
    const project = new ComposeProject(
      paths,
      { executable: "docker", prefix: ["compose"], version: "2.30.0", supported: true },
      runner
    );
    try {
      expect(supportsCredentialImport(project, true)).toBe(true);
      expect(calls.at(-1)?.args.slice(-4)).toEqual([
        "exec",
        "--no-TTY",
        "computer",
        "openteam-pi-auth",
      ]);
      expect(calls.at(-1)?.options?.input).toBeUndefined();
      expect(calls.at(-1)?.options?.timeoutMs).toBe(10_000);
      result = {
        status: 2,
        stdout: "",
        stderr: "Usage:\n  openteam-pi-auth login <provider> <oauth|api_key>\n",
      };
      expect(supportsCredentialImport(project, false)).toBe(false);
      expect(calls.at(-1)?.args.slice(-6)).toEqual([
        "run",
        "--rm",
        "--no-deps",
        "--no-TTY",
        "computer",
        "openteam-pi-auth",
      ]);
      result = { status: 1, stdout: "", stderr: "container unavailable" };
      expect(supportsCredentialImport(project, true)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
