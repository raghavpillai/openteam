import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installationPaths, createEnvironment, writeFileAtomic } from "../src/config";
import {
  AUTH_REQUEST_SCRIPT,
  createProviderConnectionAPI,
  runConnectionProcess,
  type AsyncProcess,
} from "../src/provider-connection-api";
import type { CommandRunner } from "../src/process";
import { authView } from "./fixtures/provider-connection";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const runner: CommandRunner = {
  run: () => ({
    status: 0,
    stdout: "Docker Compose version v2.30.0",
    stderr: "",
  }),
};
const fixture = (run: AsyncProcess) => {
  const directory = mkdtempSync(join(tmpdir(), "openteam-connect-"));
  directories.push(directory);
  const paths = installationPaths(directory);
  writeFileAtomic(paths.compose, "services:\n  computer:\n    image: example/computer\n");
  writeFileAtomic(paths.environment, createEnvironment({ version: "1.2.3" }));
  return {
    directory,
    paths,
    api: createProviderConnectionAPI(paths, runner, run, {
      home: directory,
      env: {},
      platform: "linux",
    }),
  };
};
describe("provider connection transport", () => {
  test("uses the existing Docker service API, piping prompt values without exposing secrets in argv", async () => {
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const f = fixture(async (command, input) => {
      calls.push({ args: command.args, input });
      return JSON.stringify({ status: 200, body: authView() });
    });
    await f.api.start("claude-code", "oauth");
    await f.api.respond("session-1", "prompt-1", "sensitive-code-for-test");
    await f.api.cancel("session-1");
    expect(calls[0]!.args).toContain("--no-TTY");
    expect(calls[0]!.args).toContain("computer");
    expect(calls[0]!.args).toContain(AUTH_REQUEST_SCRIPT);
    expect(calls.flatMap((call) => call.args).join(" ")).not.toContain("sensitive-code-for-test");
    expect(JSON.parse(calls[1]!.input!)).toEqual({
      path: "/v1/inference/auth-sessions/session-1/respond",
      method: "POST",
      body: { promptId: "prompt-1", value: "sensitive-code-for-test" },
    });
    expect(JSON.parse(calls[2]!.input!).method).toBe("DELETE");
  });
  test("imports Claude credentials from its config file over stdin, then verifies storage", async () => {
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const f = fixture(async (command, input) => {
      calls.push({ args: command.args, input });
      return command.args.includes("providers")
        ? JSON.stringify([{ id: "claude-code", configured: true, authType: "oauth" }])
        : "";
    });
    mkdirSync(join(f.directory, ".claude"));
    writeFileSync(
      join(f.directory, ".claude/.credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "test-access",
          refreshToken: "test-refresh",
          expiresAt: Date.now() + 60_000,
        },
      }),
      { mode: 0o600 }
    );
    await f.api.importLogin("claude-code");
    expect(JSON.parse(calls[0]!.input!)).toMatchObject({
      access: "test-access",
      refresh: "test-refresh",
    });
    expect(calls[0]!.args).toContain("import");
    expect(calls[0]!.args.join(" ")).not.toContain("test-refresh");
    expect(calls[1]!.args).toContain("providers");
  });
  test("subprocess failures, timeouts and oversized output are bounded and redact diagnostics", async () => {
    for (const code of [
      'console.error("private-test-token"); process.exit(1)',
      "setInterval(() => {}, 1000)",
      'console.log("x".repeat(300000))',
    ]) {
      const error = await runConnectionProcess(
        { command: process.execPath, args: ["-e", code] },
        undefined,
        80
      ).catch((error) => error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).not.toContain("private-test-token");
      expect(error.message).toContain("doctor");
    }
  });
});
