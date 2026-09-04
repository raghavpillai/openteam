import type { InstallationManifest, InstallationPaths } from "./config";
import { installationExists, readManifest, writeManifest } from "./config";
import { PROJECT_NAME } from "./constants";
import { requireComposeProject } from "./docker";
import { CliError } from "./errors";
import type { CommandRunner } from "./process";
import {
  collectConfirmedPassword,
  collectOwnerUsername,
  createTerminalPrompter,
  type SetupPrompter,
  validateOwnerUsername,
} from "./setup";

export interface AccountUpdateOptions {
  username?: string;
  password: boolean;
}

const requireInstallation = (paths: InstallationPaths): InstallationManifest => {
  if (!installationExists(paths)) {
    throw new CliError(
      `OpenTeam is not installed at ${paths.directory}. Run openteam install first.`
    );
  }
  const manifest = readManifest(paths);
  if (!manifest)
    throw new CliError(`OpenTeam installation manifest is missing at ${paths.manifest}`);
  return manifest;
};

export const accountUpdateCommand = async (
  paths: InstallationPaths,
  runner: CommandRunner,
  options: AccountUpdateOptions,
  suppliedPrompter?: SetupPrompter
): Promise<void> => {
  const manifest = requireInstallation(paths);
  const project = requireComposeProject(paths, runner, manifest.projectName || PROJECT_NAME);
  const updateBoth = options.username === undefined && !options.password;
  const needsPrompt = updateBoth || options.password;
  const prompter = suppliedPrompter || (needsPrompt ? createTerminalPrompter() : undefined);
  let username =
    options.username === undefined ? undefined : validateOwnerUsername(options.username);
  let password: string | undefined;
  try {
    console.log(
      `Update the OpenTeam owner account${
        manifest.ownerUsername ? ` for ${manifest.ownerUsername}` : ""
      }.`
    );
    if (needsPrompt) {
      if (!prompter) throw new CliError("Updating account credentials requires a terminal.");
      if (updateBoth) {
        username = await collectOwnerUsername(prompter, manifest.ownerUsername || "openteam");
      }
      password = await collectConfirmedPassword(prompter);
    }
  } finally {
    if (!suppliedPrompter) prompter?.close();
  }

  project.runOrThrow(["exec", "--no-TTY", "server", "bun", "main.js", "owner-credentials"], {
    input: JSON.stringify({ operation: "update", username, password }),
  });
  const ownerUsername = username || manifest.ownerUsername;
  writeManifest(paths, { ...manifest, ownerUsername });
  console.log(
    `OpenTeam owner account updated${ownerUsername ? ` for ${ownerUsername}` : ""}. All desktop and mobile sessions have been signed out.`
  );
};
