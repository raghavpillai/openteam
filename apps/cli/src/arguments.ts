import { CliError } from "./errors";

export type CommandName =
  | "install"
  | "setup"
  | "doctor"
  | "status"
  | "update"
  | "stop"
  | "start"
  | "logs"
  | "provider-list"
  | "provider-login"
  | "provider-logout"
  | "provider-add"
  | "provider-remove"
  | "model-list"
  | "model-use"
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
  noSetup: boolean;
  follow: boolean;
  tail?: string;
  service?: string;
  jsonProgress: boolean;
  username?: string;
  password: boolean;
  providerId?: string;
  modelId?: string;
  authType?: string;
  providerName?: string;
  baseUrl?: string;
  apiProtocol?: string;
  thinking?: string;
  contextWindow?: string;
  maxTokens?: string;
  reasoning?: boolean;
}

const commands = new Set<CommandName>([
  "install",
  "setup",
  "doctor",
  "status",
  "update",
  "stop",
  "start",
  "logs",
  "provider-list",
  "provider-login",
  "provider-logout",
  "provider-add",
  "provider-remove",
  "model-list",
  "model-use",
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
  | "tail"
  | "service"
  | "authType"
  | "providerName"
  | "baseUrl"
  | "apiProtocol"
  | "modelId"
  | "thinking"
  | "contextWindow"
  | "maxTokens"
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
  ["--tail", "tail"],
  ["--service", "service"],
  ["--auth", "authType"],
  ["--name", "providerName"],
  ["--base-url", "baseUrl"],
  ["--api", "apiProtocol"],
  ["--model", "modelId"],
  ["--thinking", "thinking"],
  ["--context-window", "contextWindow"],
  ["--max-tokens", "maxTokens"],
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
      noSetup: false,
      follow: false,
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
      noSetup: false,
      follow: false,
      jsonProgress: false,
      password: false,
    };
  }
  const nestedPasswordReset = rawCommand === "password" && rawRest[0] === "reset";
  const nestedAccountUpdate = rawCommand === "account" && rawRest[0] === "update";
  const providerAction = rawCommand === "provider" ? rawRest[0] : undefined;
  const modelAction = rawCommand === "model" ? rawRest[0] : undefined;
  const nestedProviderList = rawCommand === "provider" && providerAction === "list";
  const nestedProviderLogin = rawCommand === "provider" && providerAction === "login";
  const nestedProviderLogout = rawCommand === "provider" && providerAction === "logout";
  const nestedProviderAdd = rawCommand === "provider" && providerAction === "add";
  const nestedProviderRemove = rawCommand === "provider" && providerAction === "remove";
  const nestedModelList = rawCommand === "model" && modelAction === "list";
  const nestedModelUse = rawCommand === "model" && modelAction === "use";
  const command = nestedPasswordReset
    ? "password-reset"
    : nestedAccountUpdate
      ? "account-update"
      : nestedProviderList
        ? "provider-list"
        : nestedProviderLogin
          ? "provider-login"
          : nestedProviderLogout
            ? "provider-logout"
            : nestedProviderAdd
              ? "provider-add"
              : nestedProviderRemove
                ? "provider-remove"
                : nestedModelList
                  ? "model-list"
                  : nestedModelUse
                    ? "model-use"
                    : rawCommand;
  let rest =
    nestedPasswordReset ||
    nestedAccountUpdate ||
    nestedProviderList ||
    nestedProviderLogin ||
    nestedProviderLogout ||
    nestedProviderAdd ||
    nestedProviderRemove ||
    nestedModelList ||
    nestedModelUse
      ? rawRest.slice(1)
      : rawRest;
  if (rest.includes("--help") || rest.includes("-h")) {
    return {
      command: "help",
      yes: false,
      purge: false,
      force: false,
      allowDowngrade: false,
      allowPrerelease: false,
      allowUnsigned: false,
      advanced: false,
      noSetup: false,
      follow: false,
      jsonProgress: false,
      password: false,
    };
  }
  if (!commands.has(command as CommandName)) {
    if (rawCommand === "password") throw new CliError("Usage: openteam password reset");
    if (rawCommand === "account") {
      throw new CliError("Usage: openteam account update [--username <name>] [--password]");
    }
    if (rawCommand === "provider") {
      throw new CliError("Usage: openteam provider <list|login|logout|add|remove>");
    }
    if (rawCommand === "model") throw new CliError("Usage: openteam model <list|use>");
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
    noSetup: false,
    follow: false,
    jsonProgress: false,
    password: false,
  };
  const positional: string[] = [];
  while (rest[0] && !rest[0].startsWith("-")) {
    positional.push(rest[0]);
    rest = rest.slice(1);
  }
  if (command === "provider-login" || command === "provider-logout") {
    if (positional.length > 1)
      throw new CliError(`openteam provider ${providerAction} accepts one provider`);
    options.providerId = positional[0];
  } else if (command === "provider-add" || command === "provider-remove") {
    if (positional.length !== 1)
      throw new CliError(`openteam provider ${providerAction} requires a provider id`);
    options.providerId = positional[0];
  } else if (command === "model-list") {
    if (positional.length > 1) throw new CliError("openteam model list accepts one provider");
    options.providerId = positional[0];
  } else if (command === "model-use") {
    if (positional.length !== 2)
      throw new CliError("openteam model use requires a provider and model");
    [options.providerId, options.modelId] = positional;
  } else if (positional.length > 0) {
    throw new CliError(`Unexpected argument for ${rawCommand}: ${positional[0]}`);
  }
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
    if (flag === "--no-setup") {
      options.noSetup = true;
      continue;
    }
    if (flag === "--follow" || flag === "-f") {
      options.follow = true;
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
          "--password does not accept a value; OpenTeam prompts securely so the password is not saved in shell history"
        );
      }
      options.password = true;
      continue;
    }
    if (flag === "--reasoning") {
      options.reasoning = true;
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
    throw new CliError("--username and --password are only valid with openteam account update");
  }
  if (options.authType !== undefined) {
    const normalized = options.authType.replace("-", "_");
    if (normalized !== "oauth" && normalized !== "api_key") {
      throw new CliError("--auth must be oauth or api-key");
    }
    options.authType = normalized;
    if (options.command !== "provider-login") {
      throw new CliError("--auth is only valid with openteam provider login");
    }
  }
  const providerAddOptions = [
    options.providerName,
    options.baseUrl,
    options.apiProtocol,
    options.contextWindow,
    options.maxTokens,
    options.reasoning,
  ];
  if (
    providerAddOptions.some((value) => value !== undefined) &&
    options.command !== "provider-add"
  ) {
    throw new CliError("Custom provider options are only valid with openteam provider add");
  }
  if (options.command === "provider-add") {
    if (!options.providerName || !options.baseUrl || !options.apiProtocol || !options.modelId) {
      throw new CliError("provider add requires --name, --base-url, --api, and --model");
    }
    if (
      ![
        "openai-completions",
        "openai-responses",
        "anthropic-messages",
        "google-generative-ai",
      ].includes(options.apiProtocol)
    ) {
      throw new CliError(
        "--api must be openai-completions, openai-responses, anthropic-messages, or google-generative-ai"
      );
    }
    for (const [flag, value] of [
      ["--context-window", options.contextWindow],
      ["--max-tokens", options.maxTokens],
    ] as const) {
      if (value !== undefined && (!/^\d+$/.test(value) || Number(value) <= 0)) {
        throw new CliError(`${flag} must be a positive whole number`);
      }
    }
  }
  if (options.providerId !== undefined) {
    options.providerId = options.providerId.toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(options.providerId)) {
      throw new CliError(
        "Provider ids may contain lowercase letters, numbers, dots, underscores, or hyphens"
      );
    }
  }
  if (options.modelId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(options.modelId)) {
    throw new CliError("Invalid model id");
  }
  if (options.thinking !== undefined && options.command !== "model-use") {
    throw new CliError("--thinking is only valid with openteam model use");
  }
  if (
    options.thinking !== undefined &&
    !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(options.thinking)
  ) {
    throw new CliError("--thinking must be off, minimal, low, medium, high, xhigh, or max");
  }
  if (options.noSetup && options.command !== "install") {
    throw new CliError("--no-setup is only valid with openteam install");
  }
  if (
    (options.follow || options.tail !== undefined || options.service !== undefined) &&
    options.command !== "logs"
  ) {
    throw new CliError("--follow, --tail, and --service are only valid with openteam logs");
  }
  if (options.tail !== undefined && !/^\d+$/.test(options.tail)) {
    throw new CliError("--tail must be a whole number");
  }
  if (
    options.service !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(options.service)
  ) {
    throw new CliError("--service must be a Compose service name");
  }
  return options;
};
