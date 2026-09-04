import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectReusableLogins,
  readClaudeCredential,
  readCodexCredential,
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

const jwt = (payload: Record<string, unknown>): string =>
  ["e30", Buffer.from(JSON.stringify(payload)).toString("base64url"), "sig"].join(".");

class KeychainRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[] }> = [];
  constructor(private readonly secret: string | null) {}
  run(command: string, args: readonly string[], _options?: RunOptions): RunResult {
    this.calls.push({ command, args });
    if (command === "security" && this.secret !== null) {
      return { status: 0, stdout: `${this.secret}\n`, stderr: "" };
    }
    return { status: 44, stdout: "", stderr: "The specified item could not be found." };
  }
}

describe("detected vendor sign-ins", () => {
  test("reads the Codex CLI ChatGPT sign-in with its account id and expiry", () => {
    const directory = home();
    mkdirSync(join(directory, ".codex"));
    const access = jwt({
      exp: 1_800_000_000,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-from-token" },
    });
    writeFileSync(
      join(directory, ".codex", "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: access, refresh_token: "refresh-1", account_id: "acct-stored" },
      })
    );

    expect(readCodexCredential({ home: directory, env: {} })).toEqual({
      credential: {
        type: "oauth",
        access,
        refresh: "refresh-1",
        expires: 1_800_000_000_000,
        accountId: "acct-stored",
      },
      source: "Codex CLI (~/.codex/auth.json)",
    });

    writeFileSync(
      join(directory, ".codex", "auth.json"),
      JSON.stringify({ tokens: { access_token: access, refresh_token: "refresh-1" } })
    );
    expect(readCodexCredential({ home: directory, env: {} })?.credential.accountId).toBe(
      "acct-from-token"
    );
  });

  test("ignores Codex API-key mode, missing files, and honours CODEX_HOME", () => {
    const directory = home();
    expect(readCodexCredential({ home: directory, env: {} })).toBeNull();
    mkdirSync(join(directory, ".codex"));
    writeFileSync(
      join(directory, ".codex", "auth.json"),
      JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test", tokens: null })
    );
    expect(readCodexCredential({ home: directory, env: {} })).toBeNull();

    const elsewhere = join(directory, "codex-home");
    mkdirSync(elsewhere);
    writeFileSync(
      join(elsewhere, "auth.json"),
      JSON.stringify({ tokens: { access_token: "plain", refresh_token: "refresh-2" } })
    );
    expect(readCodexCredential({ home: directory, env: { CODEX_HOME: elsewhere } })).toMatchObject({
      credential: { access: "plain", refresh: "refresh-2", expires: 0 },
      source: "Codex CLI (~/codex-home/auth.json)",
    });
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
      JSON.stringify({ claudeAiOauth: { accessToken: "kc-access", refreshToken: "kc-refresh" } })
    );
    expect(readClaudeCredential({ home: bare, env: {}, platform: "darwin", runner })).toEqual({
      credential: { type: "oauth", access: "kc-access", refresh: "kc-refresh", expires: 0 },
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
        claudeAiOauth: { accessToken: "ca", refreshToken: "claude-refresh-secret" },
      })
    );

    const logins = detectReusableLogins({ home: directory, env: {}, platform: "linux" });
    expect(logins).toEqual([
      { provider: "openai-codex", source: "Codex CLI (~/.codex/auth.json)" },
      { provider: "anthropic", source: "Claude Code (~/.claude/.credentials.json)" },
    ]);
    expect(JSON.stringify(logins)).not.toContain("claude-refresh-secret");
    expect(
      readReusableCredential("anthropic", { home: directory, env: {} })?.credential.refresh
    ).toBe("claude-refresh-secret");
    expect(detectReusableLogins({ home: home(), env: {}, platform: "linux" })).toEqual([]);
  });
});
