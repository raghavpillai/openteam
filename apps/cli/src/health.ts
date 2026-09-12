import { readFileSync } from "node:fs";
import type { InstallationPaths } from "./config";
import { parseEnvironment } from "./config";

export interface HealthResult {
  ok: boolean;
  url: string;
  detail: string;
  inference?: string;
  version?: string;
  connectionFailed?: boolean;
}

export const healthUrl = (paths: InstallationPaths): string => {
  const environment = parseEnvironment(readFileSync(paths.environment, "utf8"));
  const configuredHost = environment.get("OPENTEAM_BIND_HOST") || "127.0.0.1";
  const host = configuredHost === "0.0.0.0" ? "127.0.0.1" : configuredHost;
  const port = environment.get("OPENTEAM_API_PORT") || "8787";
  return `http://${host}:${port}/api/v0/health`;
};

export const checkHealth = async (
  paths: InstallationPaths,
  expectedVersion?: string
): Promise<HealthResult> => {
  const url = healthUrl(paths);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    const body = (await response.json().catch(() => null)) as {
      status?: unknown;
      runtime?: { inference?: unknown };
      release?: { releaseVersion?: unknown };
    } | null;
    if (!response.ok) return { ok: false, url, detail: `HTTP ${response.status}` };
    const status = typeof body?.status === "string" ? body.status : null;
    const version =
      typeof body?.release?.releaseVersion === "string" ? body.release.releaseVersion : undefined;
    if (status !== "ready") {
      return { ok: false, url, detail: status ? `runtime is ${status}` : "readiness is unknown" };
    }
    return withExpectedVersion(
      {
        ok: true,
        url,
        detail: status,
        inference:
          typeof body?.runtime?.inference === "string" ? body.runtime.inference : undefined,
        version,
      },
      expectedVersion
    );
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    const code =
      cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string"
        ? cause.code
        : undefined;
    return {
      ok: false,
      url,
      detail: `${error instanceof Error ? error.message : String(error)}${code ? ` (${code})` : ""}`,
      connectionFailed: true,
    };
  }
};

/** Downgrade a ready result when a different release than expected is answering. */
export const withExpectedVersion = (
  result: HealthResult,
  expectedVersion?: string
): HealthResult => {
  if (!result.ok || !expectedVersion || result.version === expectedVersion) return result;
  return {
    ok: false,
    url: result.url,
    detail: result.version
      ? `expected release ${expectedVersion}, but ${result.version} is responding`
      : `release ${expectedVersion} was not reported`,
    version: result.version,
  };
};

export const waitForHealth = async (
  paths: InstallationPaths,
  timeoutMs = 180_000,
  expectedVersion?: string,
  diagnose?: (health: HealthResult, elapsedMs: number) => void
): Promise<HealthResult> => {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let latest = await checkHealth(paths, expectedVersion);
  let lastDetail: string | undefined;
  let lastReported = 0;
  try {
    while (!latest.ok) {
      if (latest.detail !== lastDetail || Date.now() - lastReported >= 10_000) {
        process.stdout.write(
          `\n  ${latest.url}: ${latest.detail} (${Math.floor((Date.now() - started) / 1_000)}s elapsed)`
        );
        lastDetail = latest.detail;
        lastReported = Date.now();
      }
      diagnose?.(latest, Date.now() - started);
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, deadline - Date.now())));
      latest = await checkHealth(paths, expectedVersion);
    }
    return latest;
  } finally {
    process.stdout.write("\n");
  }
};
