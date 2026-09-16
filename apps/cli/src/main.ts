#!/usr/bin/env node

import "./runtime-compat";
import { renderHelp, renderCommandError } from "./command-ui";
import { colorEnabled } from "./ui";
import { resolve } from "node:path";
import { parseArguments } from "./arguments";
import { defaultInstallDirectory, installationExists, installationPaths } from "./config";
import { CLI_VERSION } from "./constants";
import {
  durableUpdateCommand,
  reportActiveUpdate,
  runUpdateWorker,
  updateWorkerJobId,
} from "./durable-update";
import { CliError, errorMessage } from "./errors";
import { helpFor } from "./help";
import {
  doctorCommand,
  installCommand,
  logsCommand,
  startCommand,
  statusCommand,
  stopCommand,
  uninstallCommand,
} from "./lifecycle";
import { accountUpdateCommand } from "./password";
import { SystemCommandRunner } from "./process";
import {
  modelListCommand,
  modelUseCommand,
  providerAddCommand,
  providerListCommand,
  providerLoginCommand,
  providerLogoutCommand,
  providerRemoveCommand,
} from "./providers";
import { modelCommand } from "./model-command";
import { setupCommand } from "./setup";

const main = async (): Promise<void> => {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === "help") {
    console.log(renderHelp(helpFor(options.helpTopic)));
    return;
  }
  if (options.command === "version") {
    console.log(CLI_VERSION);
    return;
  }
  const directory = options.directory ? resolve(options.directory) : defaultInstallDirectory();
  const paths = installationPaths(directory);
  const runner = new SystemCommandRunner();
  switch (options.command) {
    case "install":
      await installCommand(paths, options, runner);
      break;
    case "setup":
      if (installationExists(paths))
        await setupCommand(paths, runner, { advanced: options.advanced });
      else await installCommand(paths, options, runner);
      break;
    case "doctor":
      await doctorCommand(paths, options, runner);
      break;
    case "status":
      if (options.jsonProgress && reportActiveUpdate(paths, options)) break;
      await statusCommand(paths, runner);
      break;
    case "update":
      {
        const workerJobId = updateWorkerJobId();
        if (workerJobId) await runUpdateWorker(paths, options, runner, workerJobId);
        else await durableUpdateCommand(paths, options);
      }
      break;
    case "stop":
      stopCommand(paths, runner);
      break;
    case "start":
      await startCommand(paths, runner);
      break;
    case "logs":
      logsCommand(paths, runner, options);
      break;
    case "provider-login":
      await providerLoginCommand(paths, runner, options);
      break;
    case "provider-list":
      providerListCommand(paths, runner);
      break;
    case "provider-logout":
      providerLogoutCommand(paths, runner, options.providerId);
      break;
    case "provider-add":
      await providerAddCommand(paths, runner, options);
      break;
    case "provider-remove":
      if (!options.providerId) throw new CliError("Removing a provider requires its id");
      providerRemoveCommand(paths, runner, options.providerId);
      break;
    case "model":
      await modelCommand(paths);
      break;
    case "model-list":
      modelListCommand(paths, runner, options.providerId);
      break;
    case "model-use":
      await modelUseCommand(paths, runner, options);
      break;
    case "account-update":
      await accountUpdateCommand(paths, runner, {
        username: options.username,
        password: options.password,
      });
      break;
    case "uninstall":
      await uninstallCommand(paths, options, runner);
      break;
  }
};

main().catch((error) => {
  if (!(error instanceof CliError && error.reported)) {
    console.error(
      renderCommandError(errorMessage(error), {
        color: colorEnabled(process.env, Boolean(process.stderr.isTTY)),
        width: process.stderr.columns,
      })
    );
  }
  process.exitCode = error instanceof CliError ? error.exitCode : 1;
});
