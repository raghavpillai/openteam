import { installationCommand, renderSummary } from "./command-ui";
import { printMessage, TerminalReport } from "./terminal";
import { readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import semver from "semver";
import type { CliOptions } from "./arguments";
import { promoteStagedCli, readCliPromotion, waitForCliFollowerToExit } from "./cli-update";
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
import { checkHealth, type HealthResult, withExpectedVersion } from "./health";
import type { CommandRunner } from "./process";
import { downloadRelease, latestReleaseVersion } from "./release";
import { setupCommand, type SetupPrompter } from "./setup";
export { statusCommand } from "./status";
import {
  assertServerReachable,
  inspectStartupState,
  SETUP_JOBS_NOTE,
  waitForStartup,
} from "./startup";
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
  | "updating-cli"
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

const printStartupReady = (
  paths: InstallationPaths,
  environment: ReadonlyMap<string, string>,
  health: HealthResult,
  alreadyRunning = false
): void => {
  const localUrl = health.url.replace(/\/api\/v0\/health$/, "");
  const publicUrl = environment.get("OPENTEAM_PUBLIC_URL")?.trim().replace(/\/+$/, "");
  console.log(
    renderSummary(
      "start",
      alreadyRunning ? "ALREADY RUNNING" : "READY",
      [
        { label: "Server", value: localUrl },
        ...(publicUrl && publicUrl !== localUrl
          ? [{ label: "Network address", value: publicUrl }]
          : []),
        ...(health.version ? [{ label: "Version", value: health.version }] : []),
      ],
      [
        { text: `OpenTeam is ${alreadyRunning ? "already running" : "ready"}.`, tone: "success" },
        ...(health.inference && health.inference !== "ready"
          ? [
              {
                text:
                  health.inference === "missing"
                    ? `No AI provider is connected. Run ${installationCommand(paths, "setup")} to connect one before starting AI tasks.`
                    : `AI is not ready (${health.inference}). Run ${installationCommand(paths, "setup")} to check your provider connection.`,
                tone: "warning" as const,
              },
            ]
          : []),
        { text: `To stop OpenTeam, run: ${installationCommand(paths, "stop")}`, tone: "info" },
      ]
    )
  );
};

const startProject = async (
  project: ComposeProject,
  paths: InstallationPaths,
  runner: CommandRunner,
  expectedVersion?: string,
  options: { skipIfReady?: boolean } = {}
): Promise<void> => {
  // Refuse to race another stack for the ports; Docker's own error names only the port.
  const running = runningServices(project);
  const environment = parseEnvironment(readFileSync(paths.environment, "utf8"));
  printMessage("Checking startup ports…");
  const initialHealth = await checkHealth(paths);
  assertOwnServer(runner, initialHealth, running, environment);
  await assertPortsAvailable(runner, portRequirementsFromEnvironment(environment, running));
  if (running.has("server")) assertServerReachable(project, initialHealth);
  if (options.skipIfReady) {
    const state = inspectStartupState(project, environment);
    const health = withExpectedVersion(initialHealth, expectedVersion);
    if (!state.notReady.length && health.ok) {
      printStartupReady(paths, environment, health, true);
      return;
    }
    if (state.stopped) printMessage("OpenTeam is stopped. Starting services…");
    else if (state.notReady.length) {
      printMessage(
        `OpenTeam is partially running. Starting or checking: ${state.notReady.join(", ")}…`
      );
    } else printMessage(`OpenTeam is running but not ready (${health.detail}). Checking services…`);
  }
  printMessage(SETUP_JOBS_NOTE, "muted");
  project.runOrThrow(["up", "--detach", "--remove-orphans", "--wait", "--wait-timeout", "180"], {
    inherit: true,
  });
  printMessage("Waiting for OpenTeam…");
  const health = await waitForStartup(project, paths, expectedVersion);
  if (!health.ok) throw new CliError(`OpenTeam did not become healthy: ${health.detail}`);
  printStartupReady(paths, environment, health);
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
      printMessage(`OpenTeam ${existing.version} is already installed; starting it.`);
      await startCommand(paths, runner, { allowIncompleteSetup: options.noSetup });
    }
    return;
  }

  const projectName = normalizeProjectName(options.projectName || PROJECT_NAME);
  const diagnosis = await runDoctor(paths, runner, projectName, {
    checkInstallPorts: options.noSetup,
  });
  printDoctor(diagnosis, { compact: true });
  if (!diagnosis.ok)
    throw new CliError(
      `Server setup paused. The CLI is available. Fix the failed checks above, then run ${installationCommand(paths, "setup")} again.`,
      2
    );

  if (!options.noSetup && !suppliedPrompter && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new CliError(
      `Preflight checks passed. Guided setup needs an interactive terminal. Run ${installationCommand(paths, "setup")} in a terminal to continue.`,
      2
    );
  }

  const version = normalizeVersion(options.version || CLI_VERSION);
  const repository = normalizeRepository(options.repository || DEFAULT_REPOSITORY);
  printMessage(`Downloading OpenTeam ${version} release configuration…`);
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
  printMessage("Pulling OpenTeam container images…");
  project.runOrThrow(["pull"], { inherit: true });
  if (options.noSetup) {
    await startProject(project, paths, runner, version);
    printMessage(`Installation configuration: ${paths.directory}`, "muted");
    printMessage(
      `Guided setup was skipped. Run ${installationCommand(paths, "setup")} to finish setup.`
    );
    return;
  }
  await setupCommand(paths, runner, { advanced: options.advanced, fresh: true }, suppliedPrompter);
};

export const doctorCommand = async (
  paths: InstallationPaths,
  options: CliOptions,
  runner: CommandRunner
): Promise<void> => {
  const projectName = normalizeProjectName(options.projectName || PROJECT_NAME);
  const interactive = Boolean(process.stdout.isTTY) && process.env.TERM !== "dumb";
  const diagnosis = await runDoctor(paths, runner, projectName, {
    testInference: true,
    deepChecks: true,
    onProgress: interactive
      ? (stage) =>
          process.stdout.write(
            `\r\x1b[2K${`  ◇ ${stage}…`.slice(0, Math.max(16, process.stdout.columns || 80) - 1)}`
          )
      : undefined,
  }).finally(() => {
    if (interactive) process.stdout.write("\r\x1b[2K");
  });
  printDoctor(diagnosis);
  if (!diagnosis.ok) throw new CliError("Doctor checks failed.", 2, true);
};

export const stopCommand = (paths: InstallationPaths, runner: CommandRunner): void => {
  const manifest = requireInstallation(paths);
  requireComposeProject(paths, runner, manifestProjectName(manifest)).runOrThrow(["stop"], {
    inherit: true,
  });
  console.log(
    renderSummary(
      "stop",
      "STOPPED",
      [{ label: "Installation", value: paths.directory }],
      [
        { text: "OpenTeam is stopped. Its data and containers are preserved.", tone: "success" },
        { text: installationCommand(paths, "start"), tone: "info" },
      ]
    )
  );
};

export const startCommand = async (
  paths: InstallationPaths,
  runner: CommandRunner,
  options: { allowIncompleteSetup?: boolean } = {}
): Promise<void> => {
  const manifest = requireInstallation(paths);
  if (!manifest.ownerUsername?.trim() && !options.allowIncompleteSetup) {
    throw new CliError(
      "OpenTeam is installed, but account setup is incomplete. Run openteam setup to create your sign-in, then retry openteam start.",
      2
    );
  }
  await startProject(
    requireComposeProject(paths, runner, manifestProjectName(manifest)),
    paths,
    runner,
    manifest.version,
    { skipIfReady: true }
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
  const target = await resolveUpdateTarget(manifest.version, options, repository);
  const cliPromotion = readCliPromotion(process.env, process.execPath, CLI_VERSION);
  persisted = writeUpdateState(paths, { ...persisted, targetVersion: target });
  if (target === manifest.version && !options.force) {
    if (cliPromotion) {
      report("updating-cli", `Installing OpenTeam ${target} command-line tools`, target);
      await waitForCliFollowerToExit(cliPromotion);
      promoteStagedCli(cliPromotion);
    }
    const message = cliPromotion
      ? `OpenTeam ${target} and its command-line tools are up to date`
      : `OpenTeam ${target} is already installed`;
    report("complete", message, target);
    console.log(`${message}.`);
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
  let manifestUpdated = false;
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
    writeManifest(paths, {
      ...manifest,
      repository,
      version: target,
      composeUrl: release.composeUrl,
      updatedAt: new Date().toISOString(),
      uninstalledAt: undefined,
    });
    manifestUpdated = true;
    if (cliPromotion) {
      report("updating-cli", `Installing OpenTeam ${target} command-line tools`, target);
      await waitForCliFollowerToExit(cliPromotion);
      promoteStagedCli(cliPromotion);
    }
  } catch (error) {
    report(
      "rolling-back",
      "The update failed; restoring the previous OpenTeam configuration",
      manifest.version
    );
    writeFileAtomic(paths.compose, previousCompose, 0o600);
    writeFileAtomic(paths.environment, previousEnvironment, 0o600);
    if (manifestUpdated) writeManifest(paths, manifest);
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
  const completion = cliPromotion
    ? `OpenTeam and its command-line tools are now running ${target}`
    : `OpenTeam is now running ${target}`;
  report("complete", completion, target);
  console.log(`${completion}.`);
};

export const resolveUpdateTarget = async (
  currentVersion: string,
  options: CliOptions,
  repository: string
): Promise<string> => {
  const target = options.version
    ? normalizeVersion(options.version)
    : await latestReleaseVersion(repository);
  if (semver.lt(target, currentVersion) && !options.allowDowngrade) {
    throw new CliError(
      `Refusing to downgrade OpenTeam ${currentVersion} to ${target}. Use --allow-downgrade only for an intentional recovery.`
    );
  }
  if (semver.prerelease(target) && !options.allowPrerelease) {
    throw new CliError(
      `Refusing prerelease ${target} on the stable channel. Use --allow-prerelease to opt in.`
    );
  }
  return target;
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
    console.log(new TerminalReport().notice(question, "warning").toString());
    const answer = await prompt.question("  Continue? [y/N] ");
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
    printMessage("Uninstall cancelled.", "muted");
    return;
  }
  const project = requireComposeProject(paths, runner, manifestProjectName(manifest));
  project.runOrThrow(
    options.purge ? ["down", "--volumes", "--remove-orphans"] : ["down", "--remove-orphans"],
    { inherit: true }
  );
  if (options.purge) {
    rmSync(paths.directory, { recursive: true, force: true });
    printMessage("OpenTeam and its local Docker data were permanently removed.", "success");
    return;
  }
  writeManifest(paths, { ...manifest, uninstalledAt: new Date().toISOString() });
  console.log(
    renderSummary(
      "uninstall",
      "CONTAINERS REMOVED",
      [{ label: "Data preserved", value: paths.directory }],
      [
        {
          text: `Run ${installationCommand(paths, "start")} to recreate the containers with the preserved data.`,
          tone: "info",
        },
      ]
    )
  );
};
