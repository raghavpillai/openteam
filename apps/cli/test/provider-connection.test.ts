import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  detectReusableLogins,
  readClaudeCredential,
  readReusableCredential,
} from "../src/detected-logins";
import type { CommandRunner, RunOptions, RunResult } from "../src/process";
import {
  AUTH_REQUEST_SCRIPT,
  type AsyncProcess,
  createProviderConnectionAPI,
  runConnectionProcess,
} from "../src/provider-connection-api";
import { installStack, ok, scratch } from "./fixtures/harness";
import {
  authView,
  choose,
  connectionFixture,
  connectionScreen,
  settle,
} from "./fixtures/provider-connection";

const s = scratch();
const home = () => s.dir("openteam-login-home-");

class KeychainRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[] }> = [];
  constructor(private readonly secret: string | null) {}
  run(command: string, args: readonly string[], _options?: RunOptions): RunResult {
    this.calls.push({ command, args });
    if (command === "security" && this.secret !== null) {
      return { status: 0, stdout: `${this.secret}\n`, stderr: "" };
    }
    return {
      status: 44,
      stdout: "",
      stderr: "The specified item could not be found.",
    };
  }
}

describe("detected vendor sign-ins", () => {
  test("a custom Claude config uses its own credentials and never the default Keychain account", () => {
    const directory = home();
    const custom = join(directory, "other-account");
    mkdirSync(custom);
    const runner = new KeychainRunner(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "wrong-account",
          refreshToken: "wrong-refresh",
        },
      })
    );
    const options = {
      home: directory,
      env: { CLAUDE_CONFIG_DIR: custom },
      platform: "darwin" as const,
      runner,
    };
    expect(readClaudeCredential(options)).toBeNull();
    expect(runner.calls).toHaveLength(0);
    writeFileSync(
      join(custom, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "right-account",
          refreshToken: "right-refresh",
          expiresAt: 42,
        },
      })
    );
    expect(readClaudeCredential(options)?.credential.access).toBe("right-account");
    expect(runner.calls).toHaveLength(0);
  });
  test("reads the Claude Code sign-in from the macOS Keychain only on macOS", () => {
    const bare = home();
    const runner = new KeychainRunner(
      JSON.stringify({ claudeAiOauth: { accessToken: "kc-access", refreshToken: "kc-refresh" } })
    );
    expect(
      readClaudeCredential({ home: bare, env: {}, platform: "darwin", runner })?.credential
    ).toMatchObject({ access: "kc-access", refresh: "kc-refresh" });
    expect(runner.calls[0]?.args).toEqual([
      "find-generic-password",
      "-s",
      "Claude Code-credentials",
      "-w",
    ]);
    expect(readClaudeCredential({ home: bare, env: {}, platform: "linux", runner })).toBeNull();
  });

  test("lists detected sign-ins without their secrets", () => {
    const directory = home();
    mkdirSync(join(directory, ".codex"));
    writeFileSync(
      join(directory, ".codex", "auth.json"),
      JSON.stringify({ tokens: { access_token: "a", refresh_token: "r" } })
    );
    mkdirSync(join(directory, ".claude"));
    writeFileSync(
      join(directory, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "ca",
          refreshToken: "claude-refresh-secret",
        },
      })
    );

    const logins = detectReusableLogins({
      home: directory,
      env: {},
      platform: "linux",
    });
    expect(logins).toEqual([
      { provider: "openai-codex", source: "Codex CLI (~/.codex/auth.json)" },
      {
        provider: "claude-code",
        source: "Claude Code (~/.claude/.credentials.json)",
      },
    ]);
    expect(JSON.stringify(logins)).not.toContain("claude-refresh-secret");
    expect(
      readReusableCredential("claude-code", { home: directory, env: {} })?.credential.refresh
    ).toBe("claude-refresh-secret");
    expect(detectReusableLogins({ home: home(), env: {}, platform: "linux" })).toEqual([]);
  });
});

describe("provider connection screen", () => {
  test("Ctrl-C cancels the remote browser session exactly once", async () => {
    const f = connectionFixture();
    let result: unknown;
    f.session.subscribe((value) => {
      if (value) result = value;
    });
    choose(f.session, "browser");
    await settle(() => f.session.actions().some((a) => a.id === "open"));
    expect(connectionScreen(f.session)).not.toContain("synthetic-state");
    expect(connectionScreen(f.session)).not.toContain("here::");
    expect(f.calls.links).toHaveLength(0);
    f.session.handle("", { ctrl: true, name: "c" });
    await settle(() => !!result);
    expect(result).toEqual({ type: "complete", value: "cancelled" });
    expect(f.calls.cancel).toEqual(["session-1"]);
    await f.session.dispose();
    expect(f.calls.cancel).toHaveLength(1);
  });
  test("paste can be cancelled separately and never echoes a code or redirect URL", async () => {
    const f = connectionFixture();
    choose(f.session, "browser");
    await settle(() => f.session.actions().some((a) => a.id === "paste"));
    choose(f.session, "paste");
    f.session.handle("http://localhost/callback?code=synthetic-sensitive-code", {});
    expect(connectionScreen(f.session)).toContain("••••");
    expect(connectionScreen(f.session)).not.toContain("synthetic-sensitive-code");
    f.session.handle("", { name: "escape" });
    expect(f.session.actions().some((a) => a.id === "paste")).toBe(true);
    expect(f.calls.responses).toHaveLength(0);
    choose(f.session, "paste");
    f.session.handle("new-code", {});
    f.session.handle("", { name: "return" });
    await settle(() => connectionScreen(f.session).includes("Connected."));
    expect(f.calls.responses).toEqual(["new-code"]);
    await f.session.dispose();
  });
});

const runner: CommandRunner = { run: () => ok("Docker Compose version v2.30.0") };
const fixture = (run: AsyncProcess) => {
  const directory = s.dir("openteam-connect-");
  const { paths } = installStack(directory, {
    compose: "services:\n  computer:\n    image: example/computer\n",
  });
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
