import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isOpenTeamVersion } from "@openteam/contracts/version-compatibility";

interface Installation {
  directory: string;
  version: string;
  apiPort: string;
  ownerUsername?: string;
}

const defaultInstallDirectory = (
  environment: NodeJS.ProcessEnv,
  platform = process.platform,
  home = homedir()
) => {
  if (environment.OPENTEAM_HOME?.trim()) return resolve(environment.OPENTEAM_HOME.trim());
  if (platform === "win32") {
    return resolve(environment.LOCALAPPDATA?.trim() || join(home, "AppData", "Local"), "OpenTeam");
  }
  if (environment.XDG_CONFIG_HOME?.trim()) {
    return resolve(environment.XDG_CONFIG_HOME.trim(), "openteam");
  }
  return resolve(home, ".openteam");
};

const environmentValues = (contents: string) => {
  const result = new Map<string, string>();
  for (const line of contents.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
    result.set(key, value);
  }
  return result;
};

export const readManagedInstallation = (
  environment: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  home = homedir()
): Installation | null => {
  const directory = defaultInstallDirectory(environment, platform, home);
  const manifestPath = join(directory, "installation.json");
  const environmentPath = join(directory, ".env");
  const composePath = join(directory, "compose.yaml");
  if (!existsSync(manifestPath) || !existsSync(environmentPath) || !existsSync(composePath)) {
    return null;
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      version?: unknown;
      ownerUsername?: unknown;
    };
    if (typeof manifest.version !== "string" || !isOpenTeamVersion(manifest.version)) return null;
    const values = environmentValues(readFileSync(environmentPath, "utf8"));
    return {
      directory,
      version: manifest.version,
      apiPort: values.get("OPENTEAM_API_PORT") || "8787",
      ...(typeof manifest.ownerUsername === "string" && manifest.ownerUsername
        ? { ownerUsername: manifest.ownerUsername }
        : {}),
    };
  } catch {
    return null;
  }
};

const loopbackHost = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

export const canManageLocalInstallation = (
  serverUrl: string,
  installation: Installation | null
): boolean => {
  if (!installation) return false;
  try {
    const url = new URL(serverUrl);
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return url.protocol === "http:" && loopbackHost(url.hostname) && port === installation.apiPort;
  } catch {
    return false;
  }
};
