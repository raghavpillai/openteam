import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "./process";

/** Providers whose Pi OAuth client matches the vendor CLI, so its tokens can be reused. */
export type ReusableProvider = "openai-codex" | "anthropic";

export interface DetectedLogin {
  provider: ReusableProvider;
  /** Where the sign-in lives, such as "Codex CLI (~/.codex/auth.json)". */
  source: string;
}

export interface ReusableCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}

export interface LoginDetectionOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  /** Used to query the macOS Keychain, where Claude Code stores its credentials. */
  runner?: CommandRunner;
}

const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;

const readJson = (path: string): Json | null => {
  try {
    return asObject(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
};

const decodeJwtPayload = (token: string): Json | null => {
  const segment = token.split(".")[1];
  if (!segment) return null;
  try {
    const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
    return asObject(JSON.parse(Buffer.from(normalized, "base64").toString("utf8")));
  } catch {
    return null;
  }
};

const displayPath = (path: string, home: string): string =>
  home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;

const settings = (options: LoginDetectionOptions) => ({
  env: options.env ?? process.env,
  home: options.home ?? homedir(),
  platform: options.platform ?? process.platform,
  runner: options.runner,
});

export const codexAuthPath = (options: LoginDetectionOptions = {}): string => {
  const { env, home } = settings(options);
  return join(env.CODEX_HOME || join(home, ".codex"), "auth.json");
};

export const claudeCredentialsPath = (options: LoginDetectionOptions = {}): string => {
  const { env, home } = settings(options);
  return join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), ".credentials.json");
};

/** The ChatGPT sign-in the Codex CLI keeps in auth.json, when present. */
export const readCodexCredential = (
  options: LoginDetectionOptions = {}
): { credential: ReusableCredential; source: string } | null => {
  const { home } = settings(options);
  const path = codexAuthPath(options);
  const tokens = asObject(readJson(path)?.tokens);
  const access = typeof tokens?.access_token === "string" ? tokens.access_token : "";
  const refresh = typeof tokens?.refresh_token === "string" ? tokens.refresh_token : "";
  if (!access || !refresh) return null;
  const payload = decodeJwtPayload(access);
  const claim = asObject(payload?.[OPENAI_AUTH_CLAIM]);
  const accountId =
    typeof tokens?.account_id === "string" && tokens.account_id
      ? tokens.account_id
      : typeof claim?.chatgpt_account_id === "string"
        ? claim.chatgpt_account_id
        : undefined;
  const expires = typeof payload?.exp === "number" ? payload.exp * 1000 : 0;
  return {
    credential: {
      type: "oauth",
      access,
      refresh,
      expires,
      ...(accountId ? { accountId } : {}),
    },
    source: `Codex CLI (${displayPath(path, home)})`,
  };
};

const claudeCredentialFrom = (
  document: Json | null,
  source: string
): { credential: ReusableCredential; source: string } | null => {
  const oauth = asObject(document?.claudeAiOauth);
  const access = typeof oauth?.accessToken === "string" ? oauth.accessToken : "";
  const refresh = typeof oauth?.refreshToken === "string" ? oauth.refreshToken : "";
  if (!access || !refresh) return null;
  const expires = typeof oauth?.expiresAt === "number" ? oauth.expiresAt : 0;
  return { credential: { type: "oauth", access, refresh, expires }, source };
};

/** The Claude Pro/Max sign-in Claude Code keeps in .credentials.json or the macOS Keychain. */
export const readClaudeCredential = (
  options: LoginDetectionOptions = {}
): { credential: ReusableCredential; source: string } | null => {
  const { home, platform, runner } = settings(options);
  const path = claudeCredentialsPath(options);
  const fromFile = claudeCredentialFrom(readJson(path), `Claude Code (${displayPath(path, home)})`);
  if (fromFile) return fromFile;
  if (platform !== "darwin" || !runner) return null;
  const result = runner.run("security", [
    "find-generic-password",
    "-s",
    CLAUDE_KEYCHAIN_SERVICE,
    "-w",
  ]);
  if (result.status !== 0) return null;
  try {
    return claudeCredentialFrom(
      asObject(JSON.parse(result.stdout.trim())),
      "Claude Code (macOS Keychain)"
    );
  } catch {
    return null;
  }
};

export const readReusableCredential = (
  provider: ReusableProvider,
  options: LoginDetectionOptions = {}
): { credential: ReusableCredential; source: string } | null =>
  provider === "openai-codex" ? readCodexCredential(options) : readClaudeCredential(options);

/** Sign-ins on this machine that setup can reuse, without keeping their secrets around. */
export const detectReusableLogins = (options: LoginDetectionOptions = {}): DetectedLogin[] => {
  const found: DetectedLogin[] = [];
  const codex = readCodexCredential(options);
  if (codex) found.push({ provider: "openai-codex", source: codex.source });
  const claude = readClaudeCredential(options);
  if (claude) found.push({ provider: "anthropic", source: claude.source });
  return found;
};
