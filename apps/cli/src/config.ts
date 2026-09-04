import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  COMPOSE_FILENAME,
  BACKUP_DIRECTORY,
  DEFAULT_IMAGE_PREFIX,
  DEFAULT_REPOSITORY,
  ENV_FILENAME,
  INSTALLATION_FILENAME,
  UPDATE_EVENTS_FILENAME,
  UPDATE_LOCK_DIRECTORY,
  UPDATE_LOG_FILENAME,
  UPDATE_STATE_FILENAME,
} from "./constants";
import { CliError } from "./errors";

export interface InstallationManifest {
  schemaVersion: 1;
  repository: string;
  version: string;
  composeUrl: string;
  installedAt: string;
  updatedAt: string;
  uninstalledAt?: string;
  projectName?: string;
  ownerUsername?: string;
}

export interface InstallationPaths {
  directory: string;
  compose: string;
  environment: string;
  manifest: string;
  updateState: string;
  updateEvents: string;
  updateLog: string;
  updateLock: string;
  backups: string;
}

export const defaultInstallDirectory = (
  environment: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  home = homedir()
): string => {
  if (environment.OPENTEAM_HOME?.trim()) return resolve(environment.OPENTEAM_HOME.trim());
  if (platform === "win32") {
    return resolve(environment.LOCALAPPDATA?.trim() || join(home, "AppData", "Local"), "OpenTeam");
  }
  if (environment.XDG_CONFIG_HOME?.trim()) {
    return resolve(environment.XDG_CONFIG_HOME.trim(), "openteam");
  }
  return resolve(home, ".openteam");
};

export const installationPaths = (directory: string): InstallationPaths => ({
  directory: resolve(directory),
  compose: join(resolve(directory), COMPOSE_FILENAME),
  environment: join(resolve(directory), ENV_FILENAME),
  manifest: join(resolve(directory), INSTALLATION_FILENAME),
  updateState: join(resolve(directory), UPDATE_STATE_FILENAME),
  updateEvents: join(resolve(directory), UPDATE_EVENTS_FILENAME),
  updateLog: join(resolve(directory), UPDATE_LOG_FILENAME),
  updateLock: join(resolve(directory), UPDATE_LOCK_DIRECTORY),
  backups: join(resolve(directory), BACKUP_DIRECTORY),
});

const assertSingleLine = (name: string, value: string): string => {
  if (!value || /[\r\n\0]/.test(value)) throw new CliError(`${name} is invalid`);
  return value;
};

export const normalizeVersion = (value: string): string => {
  const version = value.trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new CliError(`Invalid OpenTeam version: ${value}`);
  }
  return version;
};

export const normalizeRepository = (value = DEFAULT_REPOSITORY): string => {
  const repository = value
    .trim()
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/\.git$/, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new CliError(`Invalid GitHub repository: ${value}`);
  }
  return repository;
};

export const detectTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

export const detectWorkerConcurrency = (parallelism = availableParallelism()): string =>
  String(Math.max(1, Math.min(8, Math.floor(parallelism))));

export const createEnvironment = (options: {
  version: string;
  imagePrefix?: string;
  timeZone?: string;
  workerConcurrency?: string;
}): string => {
  const version = normalizeVersion(options.version);
  const imagePrefix = assertSingleLine(
    "image prefix",
    options.imagePrefix?.trim() || DEFAULT_IMAGE_PREFIX
  );
  const timeZone = assertSingleLine("time zone", options.timeZone?.trim() || detectTimeZone());
  const workerConcurrency = assertSingleLine(
    "worker concurrency",
    options.workerConcurrency?.trim() || detectWorkerConcurrency()
  );
  if (
    !/^\d+$/.test(workerConcurrency) ||
    Number(workerConcurrency) < 1 ||
    Number(workerConcurrency) > 64
  ) {
    throw new CliError("worker concurrency must be between 1 and 64");
  }
  return [
    `OPENTEAM_VERSION=${version}`,
    `OPENTEAM_IMAGE_PREFIX=${imagePrefix}`,
    `OPENTEAM_POSTGRES_PASSWORD=${randomBytes(32).toString("hex")}`,
    `OPENTEAM_CONTROL_TOKEN=${randomBytes(32).toString("hex")}`,
    `OPENTEAM_AUTH_SECRET=${randomBytes(32).toString("hex")}`,
    `OPENTEAM_PROXY_SECRET=${randomBytes(32).toString("hex")}`,
    "OPENTEAM_AUTH_MODE=required",
    `OPENTEAM_TIME_ZONE=${timeZone}`,
    "OPENTEAM_ACCESS_MODE=local",
    "OPENTEAM_BIND_HOST=127.0.0.1",
    "OPENTEAM_VIEWER_BIND_HOST=127.0.0.1",
    "OPENTEAM_PUBLIC_HOST=127.0.0.1",
    "OPENTEAM_PUBLIC_URL=http://127.0.0.1:8787",
    "OPENTEAM_AUTH_URL=http://127.0.0.1:8787",
    "OPENTEAM_API_PORT=8787",
    "COMPOSE_PROFILES=direct",
    `OPENTEAM_WORKER_CONCURRENCY=${workerConcurrency}`,
    "",
  ].join("\n");
};

export const parseEnvironment = (contents: string): ReadonlyMap<string, string> => {
  const values = new Map<string, string>();
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const raw = trimmed.slice(separator + 1).trim();
    values.set(key, raw.replace(/^(['"])(.*)\1$/, "$2"));
  }
  return values;
};

export const replaceEnvironmentValue = (contents: string, key: string, value: string): string => {
  assertSingleLine(key, value);
  const lines = contents.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (index >= 0) lines[index] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  return `${lines.filter((line, lineIndex) => line || lineIndex < lines.length - 1).join("\n")}\n`;
};

export const ensureAuthenticationSecret = (contents: string): string => {
  let updated = contents;
  const current = parseEnvironment(updated);
  if ((current.get("OPENTEAM_AUTH_SECRET")?.length ?? 0) < 32) {
    updated = replaceEnvironmentValue(
      updated,
      "OPENTEAM_AUTH_SECRET",
      randomBytes(32).toString("hex")
    );
  }
  if ((current.get("OPENTEAM_PROXY_SECRET")?.length ?? 0) < 32) {
    updated = replaceEnvironmentValue(
      updated,
      "OPENTEAM_PROXY_SECRET",
      randomBytes(32).toString("hex")
    );
  }
  return updated;
};

export const ensureDirectory = (path: string): void => {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(path, 0o700);
};

export const writeFileAtomic = (path: string, contents: string, mode = 0o600): void => {
  ensureDirectory(dirname(path));
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", mode });
    if (process.platform !== "win32") chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
};

export const readManifest = (paths: InstallationPaths): InstallationManifest | null => {
  if (!existsSync(paths.manifest)) return null;
  try {
    const value = JSON.parse(readFileSync(paths.manifest, "utf8")) as InstallationManifest;
    if (
      value.schemaVersion !== 1 ||
      typeof value.repository !== "string" ||
      typeof value.version !== "string" ||
      typeof value.composeUrl !== "string" ||
      (value.projectName !== undefined && typeof value.projectName !== "string") ||
      (value.ownerUsername !== undefined && typeof value.ownerUsername !== "string")
    ) {
      throw new Error("unsupported manifest shape");
    }
    return value;
  } catch (error) {
    throw new CliError(
      `Could not read ${paths.manifest}: ${error instanceof Error ? error.message : error}`
    );
  }
};

export const writeManifest = (paths: InstallationPaths, manifest: InstallationManifest): void => {
  writeFileAtomic(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
};

export const installationExists = (paths: InstallationPaths): boolean =>
  existsSync(paths.compose) && existsSync(paths.environment) && existsSync(paths.manifest);

export const environmentModeIsPrivate = (paths: InstallationPaths): boolean => {
  if (process.platform === "win32" || !existsSync(paths.environment)) return true;
  return (statSync(paths.environment).mode & 0o077) === 0;
};

export const normalizeProjectName = (value: string): string => {
  const projectName = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(projectName)) {
    throw new CliError(
      "Compose project name must start with a letter or number and contain only lowercase letters, numbers, underscores, or hyphens"
    );
  }
  return projectName;
};
