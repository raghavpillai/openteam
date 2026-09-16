import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installationPaths, createEnvironment, writeFileAtomic } from "../src/config";
import {
  AUTH_REQUEST_SCRIPT,
  createProviderConnectionAPI,
  parseAuthSession,
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
  run: () => ({ status: 0, stdout: "Docker Compose version v2.30.0", stderr: "" }),
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
  test("cancelling during Keychain lookup never starts an import", async () => {
    const f = fixture(async () => "");
    const abort = new AbortController();
    let imports = 0;
    const api = createProviderConnectionAPI(
      f.paths,
      runner,
      async (invocation) => {
        if (invocation.command === "security") {
          abort.abort();
          return JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r" } });
        }
        imports++;
        return "";
      },
      { home: f.directory, env: {}, platform: "darwin" }
    );
    await expect(api.importLogin("anthropic", abort.signal)).rejects.toThrow();
    expect(imports).toBe(0);
  });
  test("uses the existing Docker service API, piping prompt values without exposing secrets in argv", async () => {
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const f = fixture(async (command, input) => {
      calls.push({ args: command.args, input });
      return JSON.stringify({ status: 200, body: authView() });
    });
    await f.api.start("anthropic", "oauth");
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
  test.each([
    401, 403, 404, 500,
  ])("HTTP %i is actionable without echoing provider credentials", async (status) => {
    const f = fixture(async () =>
      JSON.stringify({ status, body: { error: "sk-test-secret-token" } })
    );
    const error = await f.api.start("anthropic", "oauth").catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain("sk-test-secret-token");
    expect(error.message).toMatch(/doctor|Go back/);
  });
  test("cancelling an expired, missing session succeeds", async () => {
    const f = fixture(async () => JSON.stringify({ status: 404, body: null }));
    await expect(f.api.cancel("expired-session")).resolves.toBeUndefined();
  });
  test("validates auth data and discards unexpected credential fields", () => {
    expect(
      JSON.stringify(parseAuthSession({ ...authView(), refreshToken: "private-token" }))
    ).not.toContain("private-token");
    expect(() =>
      parseAuthSession({ ...authView(), prompt: { type: "select", options: [] } })
    ).toThrow("invalid data");
    expect(() =>
      parseAuthSession({ ...authView(), authorizationUrl: { secret: "value" } })
    ).toThrow("invalid data");
  });
  test("imports Claude credentials from its config file over stdin, then verifies storage", async () => {
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const f = fixture(async (command, input) => {
      calls.push({ args: command.args, input });
      return command.args.includes("providers")
        ? JSON.stringify([{ id: "anthropic", configured: true, authType: "oauth" }])
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
    await f.api.importLogin("anthropic");
    expect(JSON.parse(calls[0]!.input!)).toMatchObject({
      access: "test-access",
      refresh: "test-refresh",
    });
    expect(calls[0]!.args).toContain("import");
    expect(calls[0]!.args.join(" ")).not.toContain("test-refresh");
    expect(calls[1]!.args).toContain("providers");
  });
  test("a missing local login never starts a remote import", async () => {
    let calls = 0;
    const f = fixture(async () => {
      calls++;
      return "";
    });
    await expect(f.api.importLogin("anthropic")).rejects.toThrow("No reusable Claude Code login");
    expect(calls).toBe(0);
  });
  test("a failed or unverified import does not report success", async () => {
    const f = fixture(async () => "[]");
    mkdirSync(join(f.directory, ".claude"));
    writeFileSync(
      join(f.directory, ".claude/.credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "expired-access",
          refreshToken: "expired-refresh",
          expiresAt: 0,
        },
      })
    );
    await expect(f.api.importLogin("anthropic")).rejects.toThrow("not saved");
    const failed = createProviderConnectionAPI(
      f.paths,
      runner,
      async () => {
        throw new Error("private-refresh-token");
      },
      { home: f.directory, env: {}, platform: "linux" }
    );
    const error = await failed.importLogin("anthropic").catch((error) => error);
    expect(error.message).toContain("may have expired");
    expect(error.message).not.toContain("private-refresh-token");
  });
  test("the actual bridge script sends authenticated JSON to the computer API", async () => {
    let received: unknown;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        expect(request.headers.get("authorization")).toBe("Bearer synthetic-control-token");
        expect(new URL(request.url).pathname).toBe("/v1/inference/auth-sessions/test/respond");
        received = await request.json();
        return Response.json(authView());
      },
    });
    try {
      const output = await runConnectionProcess(
        {
          command: process.execPath,
          args: ["-e", AUTH_REQUEST_SCRIPT],
          env: {
            ...process.env,
            OPENTEAM_COMPUTER_PORT: String(server.port),
            OPENTEAM_CONTROL_TOKEN: "synthetic-control-token",
          },
        },
        JSON.stringify({
          path: "/v1/inference/auth-sessions/test/respond",
          method: "POST",
          body: { promptId: "p1", value: "synthetic-code" },
        })
      );
      expect(JSON.parse(output).status).toBe(200);
      expect(received).toEqual({ promptId: "p1", value: "synthetic-code" });
    } finally {
      server.stop(true);
    }
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
