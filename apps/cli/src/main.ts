#!/usr/bin/env node

import { resolve } from "node:path";
import { parseArguments } from "./arguments";
import { defaultInstallDirectory, installationPaths } from "./config";
import { CLI_VERSION } from "./constants";
import { CliError, errorMessage } from "./errors";
import {
  doctorCommand,
  installCommand,
  logsCommand,
  providerLoginCommand,
  startCommand,
  statusCommand,
  stopCommand,
  uninstallCommand,
  updateCommand,
} from "./lifecycle";
import { SystemCommandRunner } from "./process";
import { accountUpdateCommand, passwordResetCommand } from "./password";
import { setupCommand } from "./setup";

const help = `OpenBot CLI ${CLI_VERSION}

Usage:
  openbot <command> [options]

Commands:
  install      Install and start the OpenBot server stack
  setup        Guided access, owner, runtime, launch, and verification stages
  doctor       Check Docker, system resources, configuration, and health
  status       Show the installed version, services, and health
  update       Update to the latest stable OpenBot release
  stop         Stop OpenBot while preserving its containers and data
  start        Start or recreate the installed OpenBot services
  logs         Show recent service logs (use --follow to stream)
  provider login  Sign in to OpenAI Codex without rerunning setup
  account update  Update the owner username and/or password
  password reset  Reset the owner password and revoke all sessions
  uninstall    Remove OpenBot containers; data is preserved by default

Options:
  --dir <path>             Override the installation directory
  --version <version>      Install or update to a specific version
  --repository <owner/repo>  Override the GitHub release repository
  --yes, -y                Skip uninstall confirmation
  --purge                  Permanently delete data during uninstall
  --force                  Reapply an update at the current version
  --allow-downgrade        Permit an explicit downgrade (advanced recovery only)
  --allow-prerelease       Permit an explicit prerelease target
  --allow-unsigned         Permit unsigned test bundles (unsafe; advanced only)
  --json-progress          Emit machine-readable update progress
  --advanced               Show advanced server prompts during setup
  --no-setup               Install/start only; skip the guided setup (automation)
  --follow, -f             Stream logs until interrupted
  --tail <lines>           Number of recent log lines to show (default: 200)
  --service <name>         Limit logs to one Compose service
  --username <name>        Set a new owner username with account update
  --password               Prompt for a new password with account update
  --help, -h               Show this help
  --version, -v            Show the CLI version when used without a command

Advanced release testing:
  --compose-url <url>      Override the release Compose asset URL
  --checksum-url <url>     Override the SHA256SUMS asset URL
  --signature-url <url>    Override the Sigstore bundle asset URL
  --project-name <name>    Override and persist the Compose project name
  --image-prefix <prefix>  Override the release container image prefix
`;

const main = async (): Promise<void> => {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === "help") {
    console.log(help.trimEnd());
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
      await setupCommand(paths, runner, { advanced: options.advanced });
      break;
    case "doctor":
      await doctorCommand(paths, options, runner);
      break;
    case "status":
      await statusCommand(paths, runner);
      break;
    case "update":
      await updateCommand(paths, options, runner);
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
      await providerLoginCommand(paths, runner);
      break;
    case "account-update":
      await accountUpdateCommand(paths, runner, {
        username: options.username,
        password: options.password,
      });
      break;
    case "password-reset":
      await passwordResetCommand(paths, runner);
      break;
    case "uninstall":
      await uninstallCommand(paths, options, runner);
      break;
  }
};

main().catch((error) => {
  console.error(`openbot: ${errorMessage(error)}`);
  process.exitCode = error instanceof CliError ? error.exitCode : 1;
});
