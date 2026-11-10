import { readFileSync } from "node:fs";
import type { BusyBotsView } from "@openteam/contracts";
import { updateBusyMessage } from "@openteam/contracts/server-updates";
import type { CliOptions } from "./arguments";
import { type InstallationPaths, parseEnvironment } from "./config";
import { CliError } from "./errors";
import { healthUrl } from "./health";

/** Desktop asks through the environment, which reaches the CLI an older one stages for the update. */
export const updateWaitsForIdle = (
  options: CliOptions,
  environment: NodeJS.ProcessEnv = process.env
): boolean => options.whenIdle || environment.OPENTEAM_UPDATE_WHEN_IDLE === "1";

/** Desktop shows this refusal as it is. */
export class UpdateBusyError extends CliError {
  constructor(names: readonly string[]) {
    super(updateBusyMessage(names));
  }
}

/**
 * Refuses while a bot is working, before the update has stopped anything. A server that can't
 * answer (stopped, or a release without the check) has no work it could lose.
 */
export const assertNoAgentWorking = async (
  paths: InstallationPaths,
  fetcher: typeof fetch = fetch
): Promise<void> => {
  const token =
    parseEnvironment(readFileSync(paths.environment, "utf8")).get("OPENTEAM_CONTROL_TOKEN") ?? "";
  const response = await fetcher(new URL("/api/v0/internal/busy-bots", healthUrl(paths)), {
    headers: { authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  const activity = response?.ok
    ? ((await response.json().catch(() => null)) as BusyBotsView | null)
    : null;
  const working = activity?.bots ?? [];
  if (working.length === 0) return;
  throw new UpdateBusyError(working.map((bot) => bot.name));
};
