import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectReusableLogins,
  readClaudeCredential,
  readReusableCredential,
} from "../src/detected-logins";
import type { CommandRunner, RunOptions, RunResult } from "../src/process";

const homes: string[] = [];
const home = () => {
  const directory = mkdtempSync(join(tmpdir(), "openteam-login-home-"));
  homes.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of homes.splice(0)) rmSync(directory, { recursive: true, force: true });
});

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
  test("reads the Claude Code sign-in from its credentials file or the macOS Keychain", () => {
    const directory = home();
    mkdirSync(join(directory, ".claude"));
    writeFileSync(
      join(directory, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "claude-access",
          refreshToken: "claude-refresh",
          expiresAt: 42,
        },
      })
    );
    expect(readClaudeCredential({ home: directory, env: {}, platform: "linux" })).toEqual({
      credential: {
        type: "oauth",
        access: "claude-access",
        refresh: "claude-refresh",
        expires: 42,
      },
      source: "Claude Code (~/.claude/.credentials.json)",
    });

    const bare = home();
    expect(readClaudeCredential({ home: bare, env: {}, platform: "linux" })).toBeNull();
    const runner = new KeychainRunner(
      JSON.stringify({
        claudeAiOauth: { accessToken: "kc-access", refreshToken: "kc-refresh" },
      })
    );
    expect(readClaudeCredential({ home: bare, env: {}, platform: "darwin", runner })).toEqual({
      credential: {
        type: "oauth",
        access: "kc-access",
        refresh: "kc-refresh",
        expires: 0,
      },
      source: "Claude Code (macOS Keychain)",
    });
    expect(runner.calls[0]?.args).toEqual([
      "find-generic-password",
      "-s",
      "Claude Code-credentials",
      "-w",
    ]);
    expect(
      readClaudeCredential({
        home: bare,
        env: {},
        platform: "darwin",
        runner: new KeychainRunner(null),
      })
    ).toBeNull();
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
