import { readFileSync, rmSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import type { CliOptions } from "./arguments";
import type { InstallationManifest, InstallationPaths } from "./config";
import {
  createEnvironment,
  ensureAuthenticationSecret,
  ensureDirectory,
  installationExists,
  normalizeProjectName,
  normalizeRepository,
  normalizeVersion,
  readManifest,
  replaceEnvironmentValue,
  writeFileAtomic,
  writeManifest,
} from "./config";
import { CLI_VERSION, DEFAULT_REPOSITORY, PROJECT_NAME } from "./constants";
import { type ComposeProject, requireComposeProject } from "./docker";
import { printDoctor, runDoctor } from "./doctor";
import { CliError } from "./errors";
import { checkHealth, waitForHealth } from "./health";
import type { CommandRunner } from "./process";
import { downloadRelease, latestReleaseVersion } from "./release";

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

const manifestProjectName = (manifest: InstallationManifest): string =>
  normalizeProjectName(manifest.projectName || PROJECT_NAME);

const startProject = async (project: ComposeProject, paths: InstallationPaths): Promise<void> => {
  project.runOrThrow(["up", "--detach", "--remove-orphans"], { inherit: true });
  process.stdout.write("Waiting for OpenBot");
  const health = await waitForHealth(paths);
  if (!health.ok) throw new CliError(`OpenBot did not become healthy: ${health.detail}`);
  console.log(`OpenBot is ready at ${health.url.replace(/\/api\/v0\/health$/, "")}`);
};

export const installCommand = async (
  paths: InstallationPaths,
  options: CliOptions,
  runner: CommandRunner
): Promise<void> => {
  if (installationExists(paths)) {
    const existing = requireInstallation(paths);
    if (options.version && normalizeVersion(options.version) !== existing.version) {
      throw new CliError(
        `OpenBot ${existing.version} is already installed. Use openbot update --version ${normalizeVersion(options.version)}.`
      );
    }
    console.log(`OpenBot ${existing.version} is already installed; starting it.`);
    await startCommand(paths, runner);
    return;
  }

  const projectName = normalizeProjectName(options.projectName || PROJECT_NAME);
  const diagnosis = await runDoctor(paths, runner, projectName);
  printDoctor(diagnosis);
  if (!diagnosis.ok) throw new CliError("Fix the doctor failures above, then run install again.");

  const version = normalizeVersion(options.version || CLI_VERSION);
  const repository = normalizeRepository(options.repository || DEFAULT_REPOSITORY);
  console.log(`\nDownloading OpenBot ${version} release configuration…`);
  const release = await downloadRelease({
    repository,
    version,
    composeUrl: options.composeUrl,
    checksumUrl: options.checksumUrl,
  });
  ensureDirectory(paths.directory);
  const now = new Date().toISOString();
  writeFileAtomic(paths.compose, release.compose, 0o600);
  writeFileAtomic(
    paths.environment,
    createEnvironment({ version, imagePrefix: options.imagePrefix }),
    0o600
  );
  writeManifest(paths, {
    schemaVersion: 1,
    repository,
    version,
    composeUrl: release.composeUrl,
    installedAt: now,
    updatedAt: now,
    projectName,
  });

  const project = requireComposeProject(paths, runner, projectName);
  console.log("Pulling OpenBot container images…");
  project.runOrThrow(["pull"], { inherit: true });
  await startProject(project, paths);
  console.log(`Installation configuration: ${paths.directory}`);
  console.log("Next: run openbot setup to configure the server and sign in to OpenAI Codex.");
};

export const doctorCommand = async (
  paths: InstallationPaths,
  options: CliOptions,
  runner: CommandRunner
): Promise<void> => {
  const manifest = readManifest(paths);
  const projectName = normalizeProjectName(
    options.projectName || manifest?.projectName || PROJECT_NAME
  );
  const diagnosis = await runDoctor(paths, runner, projectName);
  printDoctor(diagnosis);
  if (!diagnosis.ok) throw new CliError("Doctor checks failed.", 2);
};

export const statusCommand = async (
  paths: InstallationPaths,
  runner: CommandRunner
): Promise<void> => {
  const manifest = requireInstallation(paths);
  console.log(`OpenBot ${manifest.version}`);
  console.log(`Installation: ${paths.directory}\n`);
  const project = requireComposeProject(paths, runner, manifestProjectName(manifest));
  const status = project.run(["ps"], { inherit: true });
  if (status.status !== 0) throw new CliError("Could not read Docker Compose service status.");
  const health = await checkHealth(paths);
  if (!health.ok)
    throw new CliError(`OpenBot is not healthy at ${health.url}: ${health.detail}`, 2);
  console.log(
    `\nHealth: ${health.detail}${health.agent ? `; model ${health.agent}` : ""} (${health.url})`
  );
};

export const stopCommand = (paths: InstallationPaths, runner: CommandRunner): void => {
  const manifest = requireInstallation(paths);
  requireComposeProject(paths, runner, manifestProjectName(manifest)).runOrThrow(["stop"], {
    inherit: true,
  });
  console.log("OpenBot is stopped. Its data and containers are preserved.");
};

export const startCommand = async (
  paths: InstallationPaths,
  runner: CommandRunner
): Promise<void> => {
  const manifest = requireInstallation(paths);
  await startProject(requireComposeProject(paths, runner, manifestProjectName(manifest)), paths);
  if (manifest.uninstalledAt) {
    writeManifest(paths, { ...manifest, uninstalledAt: undefined });
  }
};

export const updateCommand = async (
  paths: InstallationPaths,
  options: CliOptions,
  runner: CommandRunner
): Promise<void> => {
  const manifest = requireInstallation(paths);
  const repository = normalizeRepository(options.repository || manifest.repository);
  const target = options.version
    ? normalizeVersion(options.version)
    : await latestReleaseVersion(repository);
  if (target === manifest.version && !options.force) {
    console.log(`OpenBot ${target} is already installed.`);
    return;
  }
  console.log(`Updating OpenBot ${manifest.version} → ${target}…`);
  const release = await downloadRelease({
    repository,
    version: target,
    composeUrl: options.composeUrl,
    checksumUrl: options.checksumUrl,
  });
  const previousCompose = readFileSync(paths.compose, "utf8");
  const previousEnvironment = readFileSync(paths.environment, "utf8");
  const nextEnvironment = ensureAuthenticationSecret(
    replaceEnvironmentValue(previousEnvironment, "OPENBOT_VERSION", target)
  );
  const nextCompose = `${paths.compose}.next`;
  writeFileAtomic(nextCompose, release.compose, 0o600);
  writeFileAtomic(paths.environment, nextEnvironment, 0o600);
  const project = requireComposeProject(paths, runner, manifestProjectName(manifest));
  try {
    project.runOrThrow(["pull"], { inherit: true, composeFile: nextCompose });
    writeFileAtomic(paths.compose, release.compose, 0o600);
    rmSync(nextCompose, { force: true });
    await startProject(project, paths);
  } catch (error) {
    writeFileAtomic(paths.compose, previousCompose, 0o600);
    writeFileAtomic(paths.environment, previousEnvironment, 0o600);
    rmSync(nextCompose, { force: true });
    const recovery = project.run(["up", "--detach", "--remove-orphans"], { inherit: true });
    throw new CliError(
      `Update failed and the previous Compose configuration was restored${
        recovery.status === 0 ? " and restarted" : ", but it could not be restarted"
      }: ${error instanceof Error ? error.message : error}`
    );
  }
  writeManifest(paths, {
    ...manifest,
    repository,
    version: target,
    composeUrl: release.composeUrl,
    updatedAt: new Date().toISOString(),
    uninstalledAt: undefined,
  });
  console.log(`OpenBot is now running ${target}.`);
};

const confirmation = async (question: string): Promise<boolean> => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError("Interactive confirmation is unavailable; pass --yes to confirm.");
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`${question} [y/N] `);
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
};

export const uninstallCommand = async (
  paths: InstallationPaths,
  options: CliOptions,
  runner: CommandRunner
): Promise<void> => {
  const manifest = requireInstallation(paths);
  const question = options.purge
    ? "Permanently delete all OpenBot containers, volumes, configuration, sessions, and workspace data?"
    : "Remove the OpenBot containers while preserving configuration and data?";
  if (!options.yes && !(await confirmation(question))) {
    console.log("Uninstall cancelled.");
    return;
  }
  const project = requireComposeProject(paths, runner, manifestProjectName(manifest));
  project.runOrThrow(
    options.purge ? ["down", "--volumes", "--remove-orphans"] : ["down", "--remove-orphans"],
    { inherit: true }
  );
  if (options.purge) {
    rmSync(paths.directory, { recursive: true, force: true });
    console.log("OpenBot and its local Docker data were permanently removed.");
    return;
  }
  writeManifest(paths, { ...manifest, uninstalledAt: new Date().toISOString() });
  console.log(
    `OpenBot containers were removed. Configuration and data remain at ${paths.directory}.`
  );
  console.log("Run openbot start to recreate the containers with the preserved data.");
};
