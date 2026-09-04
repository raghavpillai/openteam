#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { AuthEvent, AuthPrompt, AuthType, OAuthCredential } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  formatPiModelRef,
  normalizeInferenceModelId,
  normalizeInferenceProviderId,
  piModelRef,
  serverInferenceSettings,
} from "@openteam/contracts";
import { authOptionLabel, defaultAuthOption, selectedAuthOption } from "./provider-auth-prompt";

const agentDir = resolve(process.env.OPENTEAM_PI_AGENT_DIR ?? "/home/box/.pi/agent");
const authPath = join(agentDir, "auth.json");
const modelsPath = join(agentDir, "models.json");
const modelsStorePath = join(agentDir, "models-store.json");

const createRuntime = () =>
  ModelRuntime.create({ authPath, modelsPath, modelsStorePath, allowModelNetwork: false });

const usage = () => {
  console.error(`Usage:
  openteam-pi-auth providers
  openteam-pi-auth selection
  openteam-pi-auth models [provider]
  openteam-pi-auth login <provider> <oauth|api_key>
  openteam-pi-auth import <provider>   # reads OAuth tokens JSON from stdin
  openteam-pi-auth logout <provider>
  openteam-pi-auth verify <provider> <model>
  openteam-pi-auth add-custom       # reads JSON from stdin
  openteam-pi-auth remove-custom <provider>`);
};

const stdinText = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

const promptLabel = (prompt: AuthPrompt): string =>
  prompt.type === "manual_code" ? prompt.message || "Paste authorization code" : prompt.message;

const renderAuthEvent = (event: AuthEvent): void => {
  if (event.type === "auth_url") {
    console.log(event.instructions ?? "Open this URL to continue:");
    console.log(event.url);
    return;
  }
  if (event.type === "device_code") {
    console.log(`Open ${event.verificationUri} and enter code ${event.userCode}`);
    return;
  }
  console.log(event.message);
  for (const link of event.type === "info" ? (event.links ?? []) : []) {
    console.log(`${link.label ? `${link.label}: ` : ""}${link.url}`);
  }
};

const login = async (providerId: string, authType: AuthType): Promise<void> => {
  const runtime = await createRuntime();
  const provider = runtime.getProvider(providerId);
  if (!provider) throw new Error(`Unknown Pi inference provider: ${providerId}`);
  if (!provider.auth[authType === "api_key" ? "apiKey" : "oauth"]) {
    throw new Error(
      `${provider.name} does not support ${authType.replace("_", " ")} authentication`
    );
  }

  const pipedSecret =
    authType === "api_key" && !process.stdin.isTTY ? (await stdinText()).trim() : "";
  let secretUsed = false;
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await runtime.login(providerId, authType, {
      prompt: async (prompt) => {
        if (prompt.type === "secret" && pipedSecret && !secretUsed) {
          secretUsed = true;
          return pipedSecret;
        }
        if (prompt.type === "select") {
          const defaultOption = defaultAuthOption(prompt.options);
          prompt.options.forEach((option, index) => {
            console.log(`${index + 1}. ${authOptionLabel(option, option === defaultOption)}`);
          });
          const defaultIndex = defaultOption ? prompt.options.indexOf(defaultOption) : 0;
          const answer = (
            await terminal.question(`${prompt.message} [${defaultIndex + 1}]: `)
          ).trim();
          const selected = selectedAuthOption(prompt.options, answer);
          if (!selected) throw new Error("Invalid authentication selection");
          return selected.id;
        }
        return terminal.question(`${promptLabel(prompt)}: `);
      },
      notify: renderAuthEvent,
    });
  } finally {
    terminal.close();
  }
  const status = await runtime.checkAuth(providerId);
  if (!status) throw new Error(`${provider.name} authentication was not stored`);
  console.log(`${provider.name} ${status.type.replace("_", " ")} authentication is ready.`);
};

type OAuthImportInput = {
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
};

const oauthImportInput = (value: unknown): OAuthImportInput => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OAuth import input must be an object");
  }
  const input = value as Record<string, unknown>;
  const access = typeof input.access === "string" ? input.access.trim() : "";
  const refresh = typeof input.refresh === "string" ? input.refresh.trim() : "";
  if (!access || !refresh) throw new Error("OAuth import needs access and refresh tokens");
  const expires = Number(input.expires ?? 0);
  if (!Number.isFinite(expires) || expires < 0) throw new Error("OAuth expiry is invalid");
  const accountId = typeof input.accountId === "string" ? input.accountId.trim() : "";
  return { access, refresh, expires, ...(accountId ? { accountId } : {}) };
};

const writeAuthCredential = async (
  providerId: string,
  credential: OAuthCredential
): Promise<void> => {
  let document: Record<string, unknown> = {};
  if (existsSync(authPath)) {
    const parsed: unknown = JSON.parse(await readFile(authPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      document = parsed as Record<string, unknown>;
    }
  }
  document[providerId] = credential;
  await mkdir(dirname(authPath), { recursive: true });
  const temporary = `${authPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, authPath);
};

/**
 * Store an OAuth sign-in copied from a vendor CLI (Codex CLI, Claude Code). Pi uses the
 * same OAuth clients, so the refresh token keeps working. An expired access token is
 * refreshed here so a dead refresh token fails during setup rather than on first use.
 */
const importOAuthCredential = async (providerId: string): Promise<void> => {
  const runtime = await createRuntime();
  const provider = runtime.getProvider(providerId);
  if (!provider) throw new Error(`Unknown Pi inference provider: ${providerId}`);
  const oauth = provider.auth.oauth;
  if (!oauth) throw new Error(`${provider.name} does not support OAuth authentication`);
  const input = oauthImportInput(JSON.parse(await stdinText()));
  let credential: OAuthCredential = { type: "oauth", ...input };
  if (credential.expires <= Date.now()) {
    credential = {
      ...(await oauth.refresh(credential, AbortSignal.timeout(30_000))),
      type: "oauth",
    };
  }
  await writeAuthCredential(providerId, credential);
  const status = await runtime.checkAuth(providerId);
  if (!status) throw new Error(`${provider.name} authentication was not stored`);
  console.log(`${provider.name} sign-in was imported and is ready.`);
};

const readModelsDocument = async (): Promise<Record<string, unknown>> => {
  if (!existsSync(modelsPath)) return { providers: {} };
  const parsed = JSON.parse(await readFile(modelsPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Pi models.json must contain an object");
  }
  return parsed as Record<string, unknown>;
};

const writeModelsDocument = async (document: Record<string, unknown>): Promise<void> => {
  await mkdir(dirname(modelsPath), { recursive: true });
  const temporary = `${modelsPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, modelsPath);
};

type CustomProviderInput = {
  id: string;
  name: string;
  baseUrl: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
  model: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  createOnly?: boolean;
};

const customProviderInput = (value: unknown): CustomProviderInput => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Custom provider input must be an object");
  }
  const input = value as Record<string, unknown>;
  const id = normalizeInferenceProviderId(String(input.id ?? ""));
  const name = String(input.name ?? "").trim();
  if (!name || name.length > 100) throw new Error("Custom provider name is invalid");
  const endpoint = new URL(String(input.baseUrl ?? ""));
  if (!["https:", "http:"].includes(endpoint.protocol)) {
    throw new Error("Custom provider URL must use HTTP or HTTPS");
  }
  const supportedApis = [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
  ] as const;
  const api = String(input.api ?? "") as CustomProviderInput["api"];
  if (!supportedApis.includes(api)) throw new Error(`Unsupported Pi API protocol: ${api}`);
  const positiveInteger = (field: "contextWindow" | "maxTokens", fallback: number) => {
    const number = input[field] === undefined ? fallback : Number(input[field]);
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${field} must be positive`);
    return number;
  };
  return {
    id,
    name,
    baseUrl: endpoint.toString().replace(/\/$/, ""),
    api,
    model: normalizeInferenceModelId(String(input.model ?? "")),
    reasoning: input.reasoning === true,
    contextWindow: positiveInteger("contextWindow", 128_000),
    maxTokens: positiveInteger("maxTokens", 16_384),
    createOnly: input.createOnly === true,
  };
};

const addCustomProvider = async (): Promise<void> => {
  const input = customProviderInput(JSON.parse(await stdinText()));
  const document = await readModelsDocument();
  const configuredProviders =
    document.providers &&
    typeof document.providers === "object" &&
    !Array.isArray(document.providers)
      ? (document.providers as Record<string, unknown>)
      : {};
  const runtime = await createRuntime();
  if (runtime.getProvider(input.id) && !(input.id in configuredProviders)) {
    throw new Error(`Custom providers cannot replace built-in provider ${input.id}`);
  }
  if (input.createOnly && input.id in configuredProviders) {
    throw new Error(`Custom provider ${input.id} already exists`);
  }
  const providers = { ...configuredProviders };
  providers[input.id] = {
    name: input.name,
    baseUrl: input.baseUrl,
    api: input.api,
    models: [
      {
        id: input.model,
        name: input.model,
        reasoning: input.reasoning,
        contextWindow: input.contextWindow,
        maxTokens: input.maxTokens,
      },
    ],
  };
  await writeModelsDocument({ ...document, providers });
  console.log(`Added custom provider ${input.name} (${input.id}).`);
};

const removeCustomProvider = async (providerId: string): Promise<void> => {
  const document = await readModelsDocument();
  const providers =
    document.providers &&
    typeof document.providers === "object" &&
    !Array.isArray(document.providers)
      ? { ...(document.providers as Record<string, unknown>) }
      : {};
  if (!(providerId in providers))
    throw new Error(`Custom provider ${providerId} is not configured`);
  delete providers[providerId];
  await writeModelsDocument({ ...document, providers });
  const runtime = await createRuntime();
  await runtime.logout(providerId).catch(() => undefined);
  console.log(`Removed custom provider ${providerId}.`);
};

const main = async (): Promise<void> => {
  const [command, rawProvider, rawArgument] = process.argv.slice(2);
  if (!command) {
    usage();
    process.exitCode = 2;
    return;
  }
  if (command === "add-custom") return addCustomProvider();
  if (command === "selection") {
    const settingsPath = join(
      resolve(process.env.OPENTEAM_AGENT_DATA_ROOT ?? "/home/box/agent-data"),
      "settings.json"
    );
    const document = JSON.parse(await readFile(settingsPath, "utf8")) as {
      inference?: Record<string, unknown>;
    };
    const inference = document.inference;
    if (!inference) throw new Error("Inference settings are missing");
    console.log(
      JSON.stringify(
        serverInferenceSettings(
          String(inference.providerId ?? ""),
          String(inference.modelId ?? ""),
          inference.reasoning
        )
      )
    );
    return;
  }
  const runtime = await createRuntime();
  if (command === "providers") {
    const document = await readModelsDocument();
    const customProviderIds = new Set(
      document.providers &&
        typeof document.providers === "object" &&
        !Array.isArray(document.providers)
        ? Object.keys(document.providers)
        : []
    );
    const rows = await Promise.all(
      runtime.getProviders().map(async (provider) => {
        const status = await runtime.checkAuth(provider.id).catch(() => undefined);
        return {
          id: provider.id,
          name: provider.name,
          authMethods: [
            ...(provider.auth.oauth
              ? [
                  {
                    type: "oauth",
                    label: provider.auth.oauth.name,
                    subscription: Boolean(provider.auth.oauth.isSubscription),
                  },
                ]
              : []),
            ...(provider.auth.apiKey?.login
              ? [{ type: "api_key", label: provider.auth.apiKey.name, subscription: false }]
              : []),
          ],
          configured: Boolean(status),
          authType: status?.type ?? null,
          authSource: status?.source ?? null,
          models: runtime.getModels(provider.id).length,
          custom: customProviderIds.has(provider.id),
        };
      })
    );
    console.log(JSON.stringify(rows));
    return;
  }
  if (command === "models") {
    const providerId = rawProvider ? normalizeInferenceProviderId(rawProvider) : undefined;
    const models = runtime.getModels(providerId).map((model) => ({
      providerId: model.provider,
      modelId: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    }));
    console.log(JSON.stringify(models));
    return;
  }
  if (!rawProvider) throw new Error(`${command} requires a provider`);
  const providerId = normalizeInferenceProviderId(rawProvider);
  if (command === "login") {
    if (rawArgument !== "oauth" && rawArgument !== "api_key") {
      throw new Error("login requires oauth or api_key");
    }
    return login(providerId, rawArgument);
  }
  if (command === "import") return importOAuthCredential(providerId);
  if (command === "logout") {
    await runtime.logout(providerId);
    console.log(`Logged out of ${providerId}.`);
    return;
  }
  if (command === "verify") {
    if (!rawArgument) throw new Error("verify requires a model");
    const ref = piModelRef(providerId, rawArgument);
    if (!runtime.getModel(ref.providerId, ref.modelId)) {
      throw new Error(`Pi does not provide ${formatPiModelRef(ref)}`);
    }
    if (!(await runtime.checkAuth(providerId))) {
      throw new Error(`Inference provider ${providerId} is not authenticated`);
    }
    console.log(`${formatPiModelRef(ref)} is ready.`);
    return;
  }
  if (command === "remove-custom") return removeCustomProvider(providerId);
  usage();
  process.exitCode = 2;
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
