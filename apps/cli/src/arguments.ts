import { CliError } from "./errors";

export type CommandName =
  | "install"
  | "setup"
  | "doctor"
  | "status"
  | "update"
  | "stop"
  | "start"
  | "account-update"
  | "password-reset"
  | "uninstall";

export interface CliOptions {
  command: CommandName | "help" | "version";
  directory?: string;
  version?: string;
  repository?: string;
  composeUrl?: string;
  checksumUrl?: string;
  signatureUrl?: string;
  projectName?: string;
  imagePrefix?: string;
  yes: boolean;
  purge: boolean;
  force: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  allowUnsigned: boolean;
  advanced: boolean;
  jsonProgress: boolean;
  username?: string;
  password: boolean;
}

const commands = new Set<CommandName>([
  "install",
  "setup",
  "doctor",
  "status",
  "update",
  "stop",
  "start",
  "account-update",
  "password-reset",
  "uninstall",
]);

const valueFlags = new Map<
  string,
  | "directory"
  | "version"
  | "repository"
  | "composeUrl"
  | "checksumUrl"
  | "signatureUrl"
  | "projectName"
  | "imagePrefix"
  | "username"
>([
  ["--dir", "directory"],
  ["--install-dir", "directory"],
  ["--version", "version"],
  ["--repository", "repository"],
  ["--compose-url", "composeUrl"],
  ["--checksum-url", "checksumUrl"],
  ["--signature-url", "signatureUrl"],
  ["--project-name", "projectName"],
  ["--image-prefix", "imagePrefix"],
  ["--username", "username"],
] as const);

export const parseArguments = (argv: readonly string[]): CliOptions => {
  const [rawCommand, ...rawRest] = argv;
  if (!rawCommand || ["help", "--help", "-h"].includes(rawCommand)) {
    return {
      command: "help",
      yes: false,
      purge: false,
      force: false,
      allowDowngrade: false,
      allowPrerelease: false,
      allowUnsigned: false,
      advanced: false,
      jsonProgress: false,
      password: false,
    };
  }
  if (["version", "--version", "-v"].includes(rawCommand)) {
    return {
      command: "version",
      yes: false,
      purge: false,
      force: false,
      allowDowngrade: false,
      allowPrerelease: false,
      allowUnsigned: false,
      advanced: false,
      jsonProgress: false,
      password: false,
    };
  }
  const nestedPasswordReset = rawCommand === "password" && rawRest[0] === "reset";
  const nestedAccountUpdate = rawCommand === "account" && rawRest[0] === "update";
  const command = nestedPasswordReset
    ? "password-reset"
    : nestedAccountUpdate
      ? "account-update"
      : rawCommand;
  const rest = nestedPasswordReset || nestedAccountUpdate ? rawRest.slice(1) : rawRest;
  if (!commands.has(command as CommandName)) {
    if (rawCommand === "password") throw new CliError("Usage: openbot password reset");
    if (rawCommand === "account") {
      throw new CliError("Usage: openbot account update [--username <name>] [--password]");
    }
    throw new CliError(`Unknown command: ${rawCommand}`);
  }

  const options: CliOptions = {
    command: command as CommandName,
    yes: false,
    purge: false,
    force: false,
    allowDowngrade: false,
    allowPrerelease: false,
    allowUnsigned: false,
    advanced: false,
    jsonProgress: false,
    password: false,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (!flag) continue;
    if (flag === "--yes" || flag === "-y") {
      options.yes = true;
      continue;
    }
    if (flag === "--purge") {
      options.purge = true;
      continue;
    }
    if (flag === "--force") {
      options.force = true;
      continue;
    }
    if (flag === "--allow-downgrade") {
      options.allowDowngrade = true;
      continue;
    }
    if (flag === "--allow-prerelease") {
      options.allowPrerelease = true;
      continue;
    }
    if (flag === "--allow-unsigned") {
      options.allowUnsigned = true;
      continue;
    }
    if (flag === "--advanced") {
      options.advanced = true;
      continue;
    }
    if (flag === "--json-progress") {
      options.jsonProgress = true;
      continue;
    }
    if (flag === "--password") {
      const next = rest[index + 1];
      if (next && !next.startsWith("--")) {
        throw new CliError(
          "--password does not accept a value; OpenBot prompts securely so the password is not saved in shell history"
        );
      }
      options.password = true;
      continue;
    }
    const property = valueFlags.get(flag);
    if (property) {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) throw new CliError(`${flag} requires a value`);
      options[property] = value;
      index += 1;
      continue;
    }
    throw new CliError(
      `Unknown option for ${nestedPasswordReset ? "password reset" : nestedAccountUpdate ? "account update" : rawCommand}: ${flag}`
    );
  }
  if (
    (options.username !== undefined || options.password) &&
    options.command !== "account-update"
  ) {
    throw new CliError("--username and --password are only valid with openbot account update");
  }
  return options;
};
