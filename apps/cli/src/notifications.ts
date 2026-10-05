import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  validateApnsConfiguration,
  type ApnsConfiguration,
  type ApnsStatus,
} from "@openteam/db/apns-settings";
import type { CliOptions } from "./arguments";
import type { InstallationPaths } from "./config";
import { CliError } from "./errors";
import { runtimeSettingsRequest } from "./runtime-settings";

const readConfigurationFile = (path: string): string => {
  try {
    if (!statSync(path).isFile() || statSync(path).size > 32_768) throw new Error();
    return readFileSync(path, "utf8");
  } catch {
    throw new CliError("Could not read the APNs configuration or key file (maximum 32 KiB).");
  }
};

export function readApnsConfiguration(options: CliOptions): ApnsConfiguration {
  let input: Record<string, unknown>;
  if (options.apnsConfig) {
    if (options.apnsKeyFile || options.apnsKeyId || options.apnsTeamId || options.apnsTopic)
      throw new CliError("Choose --config or --key-file with --key-id, --team-id and --topic.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(readConfigurationFile(resolve(options.apnsConfig)));
    } catch {
      throw new CliError("Could not read valid APNs configuration JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new CliError("APNs configuration must be a JSON object.");
    input = { ...(parsed as Record<string, unknown>) };
    if ("privateKeyFile" in input) {
      if (
        typeof input.privateKeyFile !== "string" ||
        !input.privateKeyFile ||
        "privateKey" in input
      )
        throw new CliError("Choose one privateKeyFile path or privateKey in the APNs JSON.");
      const keyPath = resolve(dirname(resolve(options.apnsConfig)), input.privateKeyFile);
      delete input.privateKeyFile;
      input.privateKey = readConfigurationFile(keyPath);
    }
  } else {
    if (!options.apnsKeyFile || !options.apnsKeyId || !options.apnsTeamId || !options.apnsTopic)
      throw new CliError(
        "Use --config ./apns.json, or --key-file with --key-id, --team-id and --topic."
      );
    input = {
      keyId: options.apnsKeyId,
      teamId: options.apnsTeamId,
      topic: options.apnsTopic,
      privateKey: readConfigurationFile(resolve(options.apnsKeyFile)),
    };
  }
  try {
    return validateApnsConfiguration(input);
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : "Invalid APNs configuration.");
  }
}

export async function notificationsCommand(
  paths: InstallationPaths,
  options: CliOptions
): Promise<void> {
  const configure = options.command === "notifications-configure";
  const config = configure ? readApnsConfiguration(options) : null;
  const status = await runtimeSettingsRequest<ApnsStatus>(
    paths,
    "/notifications",
    config
      ? {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(config),
        }
      : {}
  );
  if (
    !status ||
    !["database", "environment"].includes(status.source) ||
    !Array.isArray(status.missing) ||
    typeof status.topic !== "string" ||
    !(status.issue === null || typeof status.issue === "string")
  )
    throw new CliError(
      "The server returned invalid APNs status. Update OpenTeam to a release supporting live notification configuration."
    );
  // Only known metadata is printed. Never serialize a server response wholesale.
  console.log(
    configure
      ? "APNs configuration saved. Workers apply it before their next push; no restart needed."
      : `APNs configuration source: ${status.source}`
  );
  console.log(`Topic: ${status.topic || "unavailable"}`);
  console.log(
    status.issue
      ? `Configuration needs attention: ${status.issue}`
      : status.missing.length
        ? "APNs credentials are not fully configured."
        : "Signing key and configuration are valid locally."
  );
  console.log(
    "Run openteam doctor to check worker configuration and registrations. Apple acceptance and phone delivery require a real notification."
  );
}
