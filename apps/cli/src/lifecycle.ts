import { readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import semver from "semver";
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
  parseEnvironment,
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
import { setupCommand, type SetupPrompter } from "./setup";
import { ACCESS_MODES, accessLabel, type AccessMode } from "./setup-values";
import {
  assertOwnServer,
  assertPortsAvailable,
  portRequirementsFromEnvironment,
  runningServices,
} from "./stack";
import {
  acquireUpdateLock,
  assertUpdatePreflight,
  createDatabaseBackup,
  readUpdateState,
  restoreDatabaseBackup,
  writeUpdateState,
  type PersistedUpdateState,
} from "./update-safety";

export const UPDATE_PROGRESS_PREFIX = "@@OPENTEAM_UPDATE@@";
export type UpdateProgressPhase =
  | "checking"
  | "downloading"
  | "backing-up"
  | "pulling"
  | "restarting"
  | "verifying"
  | "rolling-back"
  | "complete";

const reportUpdateProgress = (
  options: CliOptions,
  phase: UpdateProgressPhase,
  message: string,
  version?: string,
  jobId?: string
) => {
  if (!options.jsonProgress) return;
  console.log(
    `${UPDATE_PROGRESS_PREFIX}${JSON.stringify({ phase, message, version, jobId, safeToCloseDesktop: true })}`
  );
};

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

const manifestProjectName = (manifest: InstallationManifest): string =>
  normalizeProjectName(manifest.projectName || PROJECT_NAME);

const startProject = async (
  project: ComposeProject,
  paths: InstallationPaths,
  runner: CommandRunner,
  expectedVersion?: string
): Promise<void> => {
  // Refuse to race another stack for the ports; Docker's own error names only the port.
  const running = runningServices(project);
  const environment = parseEnvironment(readFileSync(paths.environment, "utf8"));
  assertOwnServer(runner, await checkHealth(paths), running, environment);
  await assertPortsAvailable(runner, portRequirementsFromEnvironment(environment, running));
  project.runOrThrow(["up", "--detach", "--remove-orphans", "--wait", "--wait-timeout", "180"], {
    inherit: true,
  });
  process.stdout.write("Waiting for OpenTeam");
  const health = await waitForHealth(paths, 180_000, expectedVersion);
  if (!health.ok) throw new CliError(`OpenTeam did not become healthy: ${health.detail}`);
  console.log(`OpenTeam is ready at ${health.url.replace(/\/api\/v0\/health$/, "")}`);
};

export const installCommand = async (
  paths: InstallationPaths,
  options: CliOptions,
  runner: CommandRunner,
  suppliedPrompter?: SetupPrompter
): Promise<void> => {
  if (installationExists(paths)) {
    const existing = requireInstallation(paths);
    if (options.version && normalizeVersion(options.version) !== existing.version) {
      throw new CliError(
        `OpenTeam ${existing.version} is already installed. Use openteam update --version ${normalizeVersion(options.version)}.`
      );
    }
    if (!existing.ownerUsername && !options.noSetup) {
      console.log(
        `OpenTeam ${existing.version} is installed but setup is incomplete; resuming setup.`
      );
      await setupCommand(
        paths,
        runner,
        { advanced: options.advanced, fresh: true },
        suppliedPrompter
      );
    } else {
      console.log(`OpenTeam ${existing.version} is already installed; starting it.`);
      await startCommand(paths, runner);
    }
    return;
  }

  const projectName = normalizeProjectName(options.projectName || PROJECT_NAME);
  const diagnosis = await runDoctor(paths, runner, projectName, {
    checkInstallPorts: options.noSetup,
  });
  printDoctor(diagnosis, { compact: true });
  if (!diagnosis.ok) throw new CliError("Fix the doctor failures above, then run install again.");

  const version = normalizeVersion(options.version || CLI_VERSION);
  const repository = normalizeRepository(options.repository || DEFAULT_REPOSITORY);
  console.log(`\nDownloading OpenTeam ${version} release configuration…`);
  const release = await downloadRelease({
    repository,
    version,
    composeUrl: options.composeUrl,
    checksumUrl: options.checksumUrl,
    signatureUrl: options.signatureUrl,
    allowUnsigned: options.allowUnsigned,
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
  console.log("Pulling OpenTeam container images…");
  project.runOrThrow(["pull"], { inherit: true });
  if (options.noSetup) {
    await startProject(project, paths, runner, version);
    console.log(`Installation configuration: ${paths.directory}`);
    console.log("Guided setup was skipped. Run this same launcher with: setup");
    return;
  }
  await setupCommand(paths, runner, { advanced: options.advanced, fresh: true }, suppliedPrompter);
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
  console.log(`OpenTeam ${manifest.version}`);
  console.log(`Installation: ${paths.directory}\n`);
  const environment = parseEnvironment(readFileSync(paths.environment, "utf8"));
  const accessMode = environment.get("OPENTEAM_ACCESS_MODE") || "local";
  const publicUrl = environment.get("OPENTEAM_PUBLIC_URL") || "not configured";
  const connection = ACCESS_MODES.includes(accessMode as AccessMode)
    ? accessLabel(accessMode as AccessMode)
    : accessMode;
  console.log(`Connection: ${connection}`);
  console.log(`Server: ${publicUrl}\n`);
  const project = requireComposeProject(paths, runner, manifestProjectName(manifest));
  const status = project.run(["ps"], { inherit: true });
  if (status.status !== 0) throw new CliError("Could not read Docker Compose service status.");
  assertOwnServer(runner, await checkHealth(paths), runningServices(project), environment);
  const health = await checkHealth(paths, manifest.version);
  if (!health.ok)
    throw new CliError(`OpenTeam is not healthy at ${health.url}: ${health.detail}`, 2);
  console.log(
    `\nHealth: ${health.detail}${health.version ? `; release ${health.version}` : ""}${health.inference ? `; inference ${health.inference}` : ""} (${health.url})`
  );
};

export const stopCommand = (paths: InstallationPaths, runner: CommandRunner): void => {
  const manifest = requireInstallation(paths);
  requireComposeProject(paths, runner, manifestProjectName(manifest)).runOrThrow(["stop"], {
    inherit: true,
  });
  console.log("OpenTeam is stopped. Its data and containers are preserved.");
};

export const startCommand = async (
  paths: InstallationPaths,
  runner: CommandRunner
): Promise<void> => {
  const manifest = requireInstallation(paths);
  await startProject(
    requireComposeProject(paths, runner, manifestProjectName(manifest)),
    paths,
    runner,
    manifest.version
  );
  if (manifest.uninstalledAt) {
    writeManifest(paths, { ...manifest, uninstalledAt: undefined });
  }
};

export const logsCommand = (
  paths: InstallationPaths,
  runner: CommandRunner,
  options: CliOptions
): void => {
  const manifest = requireInstallation(paths);
  const args = ["logs", "--tail", options.tail || "200"];
  if (options.follow) args.push("--follow");
  if (options.service) args.push(options.service);
  requireComposeProject(paths, runner, manifestProjectName(manifest)).runOrThrow(args, {
    inherit: true,
  });
};

const updateCommandUnlocked = async (
  paths: InstallationPaths,
  options: CliOptions,
  runner: CommandRunner,
  jobId: string
): Promise<void> => {
  const manifest = requireInstallation(paths);
  const repository = normalizeRepository(options.repository || manifest.repository);
  let persisted: PersistedUpdateState = writeUpdateState(paths, {
    schemaVersion: 1,
    jobId,
    workerPid: process.pid,
    status: "running",
    phase: "checking",
    fromVersion: manifest.version,
    targetVersion: options.version ? normalizeVersion(options.version) : null,
    message: "Update accepted; it will continue if this window closes",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const report = (
    phase: UpdateProgressPhase,
    message: string,
    version?: string,
    extra: Partial<PersistedUpdateState> = {}
  ) => {
    reportUpdateProgress(options, phase, message, version, jobId);
    persisted = writeUpdateState(paths, {
      ...persisted,
      ...extra,
      phase,
      status: phase === "complete" ? "complete" : "running",
      message,
      targetVersion: version ?? persisted.targetVersion,
    });
  };
  report("checking", "Checking the latest OpenTeam release");
  const target = options.version
    ? normalizeVersion(options.version)
    : await latestReleaseVersion(repository);
  persisted = writeUpdateState(paths, { ...persisted, targetVersion: target });
  if (semver.lt(target, manifest.version) && !options.allowDowngrade) {
    throw new CliError(
      `Refusing to downgrade OpenTeam ${manifest.version} to ${target}. Use --allow-downgrade only for an intentional recovery.`
    );
  }
  if (semver.prerelease(target) && !options.allowPrerelease) {
    throw new CliError(
      `Refusing prerelease ${target} on the stable channel. Use --allow-prerelease to opt in.`
    );
  }
  if (target === manifest.version && !options.force) {
    report("complete", `OpenTeam ${target} is already installed`, target);
    console.log(`OpenTeam ${target} is already installed.`);
    return;
  }
  console.log(`Updating OpenTeam ${manifest.version} → ${target}…`);
  report("downloading", `Downloading and verifying OpenTeam ${target}`, target);
  const release = await downloadRelease({
    repository,
    version: target,
    composeUrl: options.composeUrl,
    checksumUrl: options.checksumUrl,
    signatureUrl: options.signatureUrl,
    allowUnsigned: options.allowUnsigned,
  });
  const previousCompose = readFileSync(paths.compose, "utf8");
  const previousEnvironment = readFileSync(paths.environment, "utf8");
  const nextEnvironment = ensureAuthenticationSecret(
    replaceEnvironmentValue(previousEnvironment, "OPENTEAM_VERSION", target)
  );
  const nextCompose = `${paths.compose}.next`;
  const project = requireComposeProject(paths, runner, manifestProjectName(manifest));
  let maintenanceStarted = false;
  let newStackStarted = false;
  let backupPath: string | null = null;
  try {
    writeFileAtomic(nextCompose, release.compose, 0o600);
    assertUpdatePreflight(paths, runner, project, nextCompose);
    report("pulling", `Pulling OpenTeam ${target} container images`, target);
    project.runOrThrow(["pull"], { inherit: true, composeFile: nextCompose });
    maintenanceStarted = true;
    project.runOrThrow(["stop", "server", "worker", "computer"], { inherit: true });
    report("backing-up", `Backing up the OpenTeam database before ${target}`, target);
    backupPath = createDatabaseBackup(paths, project, manifest.version, target);
    persisted = writeUpdateState(paths, { ...persisted, backupPath });
    writeFileAtomic(paths.environment, nextEnvironment, 0o600);
    writeFileAtomic(paths.compose, release.compose, 0o600);
    rmSync(nextCompose, { force: true });
    report("restarting", "Restarting the server, worker, and computer", target);
    newStackStarted = true;
    await startProject(project, paths, runner, target);
    report("verifying", `OpenTeam ${target} passed its readiness checks`, target);
  } catch (error) {
    report(
      "rolling-back",
      "The update failed; restoring the previous OpenTeam configuration",
      manifest.version
    );
    writeFileAtomic(paths.compose, previousCompose, 0o600);
    writeFileAtomic(paths.environment, previousEnvironment, 0o600);
    rmSync(nextCompose, { force: true });
    let databaseRecoveryError: string | null = null;
    if (newStackStarted && backupPath) {
      try {
        project.runOrThrow(["stop", "server", "worker", "computer"], { inherit: true });
        restoreDatabaseBackup(project, backupPath);
      } catch (restoreError) {
        databaseRecoveryError =
          restoreError instanceof Error ? restoreError.message : String(restoreError);
      }
    }
    const recovery = maintenanceStarted
      ? project.run(["up", "--detach", "--remove-orphans", "--wait", "--wait-timeout", "180"], {
          inherit: true,
        })
      : { status: 0 };
    const recoveryDetail = !maintenanceStarted
      ? "; the running services were never stopped"
      : recovery.status === 0
        ? " and restarted"
        : ", but it could not be restarted";
    throw new CliError(
      `Update failed and the previous Compose configuration was restored${recoveryDetail}${databaseRecoveryError ? `; database restore also failed: ${databaseRecoveryError}` : ""}: ${error instanceof Error ? error.message : error}`
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
  report("complete", `OpenTeam is now running ${target}`, target);
  console.log(`OpenTeam is now running ${target}.`);
};

export const updateCommand = async (
  paths: InstallationPaths,
  options: CliOptions,
  runner: CommandRunner,
  jobId: string = randomUUID()
): Promise<void> => {
  const releaseLock = acquireUpdateLock(paths);
  try {
    await updateCommandUnlocked(paths, options, runner, jobId);
  } catch (error) {
    const state = readUpdateState(paths);
    if (state?.jobId === jobId && state.status === "running") {
      writeUpdateState(paths, {
        ...state,
        status: "error",
        phase: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  } finally {
    releaseLock();
  }
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
    ? "Permanently delete all OpenTeam containers, volumes, configuration, sessions, and workspace data?"
    : "Remove the OpenTeam containers while preserving configuration and data?";
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
    console.log("OpenTeam and its local Docker data were permanently removed.");
    return;
  }
  writeManifest(paths, { ...manifest, uninstalledAt: new Date().toISOString() });
  console.log(
    `OpenTeam containers were removed. Configuration and data remain at ${paths.directory}.`
  );
  console.log("Run openteam start to recreate the containers with the preserved data.");
};
