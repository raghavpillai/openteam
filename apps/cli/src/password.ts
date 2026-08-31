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
  passwordResetAlias?: boolean;
}

const requireInstallation = (paths: InstallationPaths): InstallationManifest => {
  if (!installationExists(paths)) {
    throw new CliError(
      `OpenBot is not installed at ${paths.directory}. Run openbot install first.`
    );
  }
  const manifest = readManifest(paths);
  if (!manifest)
    throw new CliError(`OpenBot installation manifest is missing at ${paths.manifest}`);
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
      `${options.passwordResetAlias ? "Reset the OpenBot password" : "Update the OpenBot owner account"}${
        manifest.ownerUsername ? ` for ${manifest.ownerUsername}` : ""
      }.`
    );
    if (updateBoth) {
      username = await collectOwnerUsername(prompter!, manifest.ownerUsername || "openbot");
    }
    if (updateBoth || options.password) password = await collectConfirmedPassword(prompter!);
  } finally {
    if (!suppliedPrompter) prompter?.close();
  }

  project.runOrThrow(["exec", "--no-TTY", "server", "bun", "main.js", "owner-credentials"], {
    input: JSON.stringify({ operation: "update", username, password }),
  });
  const ownerUsername = username || manifest.ownerUsername;
  writeManifest(paths, { ...manifest, ownerUsername });
  console.log(
    options.passwordResetAlias
      ? "OpenBot password reset. All desktop and mobile sessions have been signed out."
      : `OpenBot owner account updated${ownerUsername ? ` for ${ownerUsername}` : ""}. All desktop and mobile sessions have been signed out.`
  );
};

export const passwordResetCommand = (
  paths: InstallationPaths,
  runner: CommandRunner,
  suppliedPrompter?: SetupPrompter
): Promise<void> =>
  accountUpdateCommand(
    paths,
    runner,
    { password: true, passwordResetAlias: true },
    suppliedPrompter
  );
