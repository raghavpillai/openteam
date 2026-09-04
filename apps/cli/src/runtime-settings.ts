import { readFileSync } from "node:fs";
import type { InstallationPaths } from "./config";
import { parseEnvironment } from "./config";
import { CliError } from "./errors";
import { healthUrl } from "./health";

export interface RuntimeInferenceSettings {
  providerId: string;
  modelId: string;
  reasoning: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

const internalSettingsUrl = (paths: InstallationPaths, suffix = ""): URL =>
  new URL(`/api/v0/internal/server-settings${suffix}`, healthUrl(paths));

const controlToken = (paths: InstallationPaths): string => {
  const environment = parseEnvironment(readFileSync(paths.environment, "utf8"));
  const token = environment.get("OPENTEAM_CONTROL_TOKEN");
  if (!token) throw new CliError("The installation control token is missing");
  return token;
};

const request = async (paths: InstallationPaths, url: URL, init: RequestInit = {}) => {
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${controlToken(paths)}`,
      ...init.headers,
    },
    signal: init.signal ?? AbortSignal.timeout(10_000),
  }).catch((error) => {
    throw new CliError(
      `Could not reach runtime settings: ${error instanceof Error ? error.message : String(error)}`
    );
  });
  const body = (await response.json().catch(() => null)) as {
    inference?: RuntimeInferenceSettings;
    error?: { message?: unknown };
  } | null;
  if (response.status === 401 || response.status === 403) {
    throw new CliError(
      `The OpenTeam server at ${url.origin} rejected this installation's control token. Another OpenTeam instance is probably listening on that port; run openteam doctor to see which containers hold it.`
    );
  }
  if (!response.ok) {
    throw new CliError(
      typeof body?.error?.message === "string"
        ? body.error.message
        : `Runtime settings request failed (HTTP ${response.status})`
    );
  }
  return body;
};

export const readRuntimeInferenceSettings = async (
  paths: InstallationPaths,
  providerId?: string
): Promise<RuntimeInferenceSettings> => {
  const url = internalSettingsUrl(paths);
  if (providerId) url.searchParams.set("provider", providerId);
  const body = await request(paths, url);
  if (!body?.inference) throw new CliError("The server returned invalid runtime settings");
  return body.inference;
};

export const writeRuntimeInferenceSettings = async (
  paths: InstallationPaths,
  settings: RuntimeInferenceSettings
): Promise<RuntimeInferenceSettings> => {
  const body = await request(paths, internalSettingsUrl(paths, "/inference"), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings),
  });
  return body as unknown as RuntimeInferenceSettings;
};
