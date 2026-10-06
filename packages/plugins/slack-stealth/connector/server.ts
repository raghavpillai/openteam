import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { scopedProcessEnvironment } from "@openteam/plugin-sdk";
import release from "./release.json";

export const enabledTools = [
  "channels_list",
  "channels_me",
  "users_search",
  "conversations_history",
  "conversations_replies",
  "conversations_search_messages",
  "conversations_add_message",
  "reactions_add",
  "reactions_remove",
] as const;

export function sessionEnvironment(environment: Record<string, string | undefined>) {
  const token = environment.SLACK_MCP_XOXC_TOKEN?.trim();
  const cookie = environment.SLACK_MCP_XOXD_TOKEN?.trim();
  if (!token?.startsWith("xoxc-") || token.length <= 5 || /[\s;\r\n]/.test(token))
    throw new Error("Enter a valid Slack browser token starting with xoxc- in account settings.");
  if (!cookie?.startsWith("xoxd-") || cookie.length <= 5 || /[\s;\r\n]/.test(cookie))
    throw new Error("Enter a valid Slack session cookie starting with xoxd- in account settings.");
  return scopedProcessEnvironment(environment, {
    SLACK_MCP_XOXC_TOKEN: token,
    SLACK_MCP_XOXD_TOKEN: cookie,
    SLACK_MCP_ENABLED_TOOLS: enabledTools.join(","),
    SLACK_MCP_LOG_LEVEL: "warn",
  });
}

export async function executableBytes(
  packageRoot: string,
  platform: string = process.platform,
  architecture: string = process.arch,
) {
  const key = `${platform}-${architecture}`;
  if (!(key in release.binaries))
    throw new Error("Slack (stealth) requires an OpenTeam Linux computer with x64 or arm64 architecture.");
  const binary = release.binaries[key as keyof typeof release.binaries];
  const archive = await readFile(join(packageRoot, binary.path));
  if (createHash("sha256").update(archive).digest("hex") !== binary.gzipSha256)
    throw new Error("Slack MCP archive verification failed. Reinstall Slack (stealth).");
  const bytes = gunzipSync(archive, { maxOutputLength: binary.size });
  if (bytes.length !== binary.size || createHash("sha256").update(bytes).digest("hex") !== binary.sha256)
    throw new Error("Slack MCP executable verification failed. Reinstall Slack (stealth).");
  return bytes;
}

export async function runServer() {
  const env = sessionEnvironment(process.env);
  // Each connection gets a private executable and cache directory. Credentials stay in memory.
  const bytes = await executableBytes(join(import.meta.dir, ".."));
  // OpenTeam mounts /tmp with noexec. Keep the native executable under the user's
  // private cache, with a separate disposable directory for every connection.
  const cache = join(homedir(), ".cache", "openteam", "slack-stealth");
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(cache, "session-"));
  try {
    const executable = join(directory, "slack-mcp-server");
    await writeFile(executable, bytes, { mode: 0o700, flag: "wx" });
    const child = Bun.spawn([executable, "--transport", "stdio"], {
      cwd: directory,
      env: { ...env, XDG_CACHE_HOME: join(directory, "cache") },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const stop = () => child.kill("SIGTERM");
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    try {
      process.exitCode = await child.exited;
    } finally {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
      child.kill();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    await runServer();
  } catch (error) {
    // Validation errors never include credential values; stdout is reserved for MCP.
    console.error(error instanceof Error ? error.message : "Slack MCP server could not start.");
    process.exitCode = 1;
  }
}
