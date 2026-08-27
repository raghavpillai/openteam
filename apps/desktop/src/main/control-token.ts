import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_CONTROL_TOKEN = "local-compose-only-change-me";
const TOKEN_FILE = "control-token";

const cleanToken = (value: string | undefined): string | null => {
  const token = value?.trim().replace(/^['"]|['"]$/g, "");
  return token ? token : null;
};

const tokenFromEnvFile = (path: string): string | null => {
  try {
    return cleanToken(readFileSync(path, "utf8").match(/^OPENBOT_CONTROL_TOKEN=(.+)$/m)?.[1]);
  } catch {
    return null;
  }
};

const ancestorDirectories = (path: string): string[] => {
  const directories: string[] = [];
  let current = path;
  for (;;) {
    directories.push(current);
    const parent = dirname(current);
    if (parent === current) return directories;
    current = parent;
  }
};

const persistToken = (path: string, token: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
};

export const resolveControlToken = (options: {
  environmentToken?: string;
  cwd: string;
  appPath: string;
  executablePath: string;
  userDataPath: string;
}): string => {
  const persistedPath = join(options.userDataPath, TOKEN_FILE);
  const environmentToken = cleanToken(options.environmentToken);
  if (environmentToken) {
    persistToken(persistedPath, environmentToken);
    return environmentToken;
  }

  const roots = [options.cwd, dirname(options.appPath), dirname(options.executablePath)];
  const candidates = [
    ...new Set(
      roots.flatMap((root) => ancestorDirectories(root).map((path) => join(path, ".env")))
    ),
  ];
  for (const candidate of candidates) {
    const token = tokenFromEnvFile(candidate);
    if (token) {
      persistToken(persistedPath, token);
      return token;
    }
  }

  try {
    const persisted = cleanToken(readFileSync(persistedPath, "utf8"));
    if (persisted) return persisted;
  } catch {
    // The first packaged launch can legitimately have no persisted token yet.
  }
  return DEFAULT_CONTROL_TOKEN;
};
