import { readFileSync } from "node:fs";
import type { InstallationPaths } from "./config";
import { parseEnvironment } from "./config";

export interface HealthResult {
  ok: boolean;
  url: string;
  detail: string;
  agent?: string;
}

export const healthUrl = (paths: InstallationPaths): string => {
  const environment = parseEnvironment(readFileSync(paths.environment, "utf8"));
  const configuredHost = environment.get("OPENBOT_BIND_HOST") || "127.0.0.1";
  const host = configuredHost === "0.0.0.0" ? "127.0.0.1" : configuredHost;
  const port = environment.get("OPENBOT_API_PORT") || "8787";
  return `http://${host}:${port}/api/v0/health`;
};

export const checkHealth = async (paths: InstallationPaths): Promise<HealthResult> => {
  const url = healthUrl(paths);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    const body = (await response.json().catch(() => null)) as {
      status?: unknown;
      runtime?: { agent?: unknown };
    } | null;
    if (!response.ok) return { ok: false, url, detail: `HTTP ${response.status}` };
    return {
      ok: true,
      url,
      detail: typeof body?.status === "string" ? body.status : "reachable",
      agent: typeof body?.runtime?.agent === "string" ? body.runtime.agent : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      url,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
};

export const waitForHealth = async (
  paths: InstallationPaths,
  timeoutMs = 180_000
): Promise<HealthResult> => {
  const deadline = Date.now() + timeoutMs;
  let latest = await checkHealth(paths);
  while (!latest.ok && Date.now() < deadline) {
    process.stdout.write(".");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    latest = await checkHealth(paths);
  }
  process.stdout.write("\n");
  return latest;
};
