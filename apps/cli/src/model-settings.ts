import type { InstallationPaths } from "./config";
import { CliError } from "./errors";
import { runtimeSettingsRequest, type RuntimeInferenceSettings } from "./runtime-settings";

export type ModelProvider = {
  id: string;
  name: string;
  connected: boolean;
  modelCount: number;
  modelStatus?: string;
  modelMessage?: string;
  custom?: boolean;
  authType?: "oauth" | "api_key" | null;
  authMethods?: Array<{ type: "oauth" | "api_key"; label: string; subscription: boolean }>;
};
export type ModelChoice = {
  providerId: string;
  modelId: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
};
export interface ModelCatalog {
  inference: RuntimeInferenceSettings;
  providers: ModelProvider[];
  models: ModelChoice[];
  modelProviderId: string;
}
export interface TranscriptionDraft {
  enabled: boolean;
  provider: "openai" | "openai-compatible";
  baseUrl: string;
  model: string;
  language: string;
  apiKey?: string | null;
}
export interface TranscriptionView extends Omit<TranscriptionDraft, "apiKey"> {
  hasApiKey: boolean;
  configured: boolean;
}
export type ModelCheck = { level: "pass" | "warn" | "fail"; detail: string };
export interface ModelSettingsAPI {
  catalog(provider?: string, signal?: AbortSignal): Promise<ModelCatalog>;
  transcription(signal?: AbortSignal): Promise<TranscriptionView>;
  saveInference(
    settings: RuntimeInferenceSettings,
    signal?: AbortSignal
  ): Promise<RuntimeInferenceSettings>;
  saveTranscription(settings: TranscriptionDraft, signal?: AbortSignal): Promise<TranscriptionView>;
  checkTranscription(signal?: AbortSignal): Promise<ModelCheck>;
  transcriptionModels(settings: TranscriptionDraft, signal?: AbortSignal): Promise<string[]>;
}
export const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const invalid = () =>
  new CliError(
    "The server returned invalid model settings. Run openteam doctor and check the server version."
  );
const inference = (value: unknown): RuntimeInferenceSettings => {
  if (
    !object(value) ||
    typeof value.providerId !== "string" ||
    !value.providerId ||
    typeof value.modelId !== "string" ||
    !value.modelId ||
    !THINKING.includes(value.reasoning as never)
  )
    throw invalid();
  return {
    providerId: value.providerId,
    modelId: value.modelId,
    reasoning: value.reasoning as RuntimeInferenceSettings["reasoning"],
  };
};
const transcription = (value: unknown): TranscriptionView => {
  if (
    !object(value) ||
    typeof value.enabled !== "boolean" ||
    !["openai", "openai-compatible"].includes(String(value.provider)) ||
    !["baseUrl", "model", "language"].every((key) => typeof value[key] === "string") ||
    typeof value.hasApiKey !== "boolean" ||
    typeof value.configured !== "boolean"
  )
    throw invalid();
  // Never retain an unexpected credential field from a response.
  return {
    enabled: value.enabled,
    provider: value.provider as TranscriptionView["provider"],
    baseUrl: value.baseUrl as string,
    model: value.model as string,
    language: value.language as string,
    hasApiKey: value.hasApiKey,
    configured: value.configured,
  };
};
export const createModelSettingsAPI = (paths: InstallationPaths): ModelSettingsAPI => ({
  async catalog(provider, signal) {
    const body = await runtimeSettingsRequest<unknown>(paths, "", { signal }, provider);
    if (
      !object(body) ||
      !Array.isArray(body.providers) ||
      !Array.isArray(body.models) ||
      typeof body.modelProviderId !== "string"
    )
      throw invalid();
    const providers = body.providers.map((value): ModelProvider => {
      if (
        !object(value) ||
        typeof value.id !== "string" ||
        typeof value.name !== "string" ||
        typeof value.connected !== "boolean" ||
        typeof value.modelCount !== "number"
      )
        throw invalid();
      return {
        id: value.id,
        name: value.name,
        connected: value.connected,
        modelCount: value.modelCount,
        modelStatus: typeof value.modelStatus === "string" ? value.modelStatus : undefined,
        modelMessage: typeof value.modelMessage === "string" ? value.modelMessage : undefined,
        custom: typeof value.custom === "boolean" ? value.custom : undefined,
        authType:
          value.authType === "oauth" || value.authType === "api_key" ? value.authType : null,
        authMethods: Array.isArray(value.authMethods)
          ? value.authMethods.flatMap((method) =>
              object(method) &&
              (method.type === "oauth" || method.type === "api_key") &&
              typeof method.label === "string" &&
              typeof method.subscription === "boolean"
                ? [{ type: method.type, label: method.label, subscription: method.subscription }]
                : []
            )
          : undefined,
      };
    });
    const models = body.models.map((value) => {
      if (
        !object(value) ||
        typeof value.providerId !== "string" ||
        typeof value.modelId !== "string" ||
        typeof value.name !== "string" ||
        typeof value.reasoning !== "boolean" ||
        typeof value.contextWindow !== "number" ||
        typeof value.maxTokens !== "number"
      )
        throw invalid();
      return {
        providerId: value.providerId,
        modelId: value.modelId,
        name: value.name,
        reasoning: value.reasoning,
        contextWindow: value.contextWindow,
        maxTokens: value.maxTokens,
      };
    });
    return {
      inference: inference(body.inference),
      providers,
      models,
      modelProviderId: body.modelProviderId,
    };
  },
  async transcription(signal) {
    return transcription(await runtimeSettingsRequest(paths, "/transcription", { signal }));
  },
  async saveInference(settings, signal) {
    return inference(
      await runtimeSettingsRequest(paths, "/inference", {
        method: "PATCH",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
      })
    );
  },
  async saveTranscription(settings, signal) {
    return transcription(
      await runtimeSettingsRequest(paths, "/transcription", {
        method: "PUT",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
      })
    );
  },
  async transcriptionModels(settings, signal) {
    const result = await runtimeSettingsRequest<unknown>(paths, "/transcription/models", {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settings),
    });
    if (
      !object(result) ||
      !Array.isArray(result.models) ||
      result.models.some((m) => typeof m !== "string")
    )
      throw invalid();
    return result.models as string[];
  },
  async checkTranscription(signal) {
    const result = await runtimeSettingsRequest<unknown>(paths, "/transcription/check", {
      method: "POST",
      signal,
    });
    if (
      !object(result) ||
      !["pass", "warn", "fail"].includes(String(result.level)) ||
      typeof result.detail !== "string"
    )
      throw invalid();
    return { level: result.level as ModelCheck["level"], detail: result.detail };
  },
});
