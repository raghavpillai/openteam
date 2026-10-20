export const PI_RUNTIME_ENGINE = "pi" as const;
export const RUNTIME_ENGINES = [PI_RUNTIME_ENGINE] as const;
export type RuntimeEngine = (typeof RUNTIME_ENGINES)[number];

export const isRuntimeEngine = (value: unknown): value is RuntimeEngine =>
  typeof value === "string" && (RUNTIME_ENGINES as readonly string[]).includes(value);

export const DEFAULT_PI_INFERENCE_PROVIDER = "openai-codex";
export const DEFAULT_PI_REASONING_LEVEL = "medium" as const;

export const PI_REASONING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type PiReasoningLevel = (typeof PI_REASONING_LEVELS)[number];

export interface PiModelRef {
  providerId: string;
  modelId: string;
}

export interface ServerInferenceSettings extends PiModelRef {
  /** Empty until a model is selected from a connected provider's catalog. */
  modelId: string;
  reasoning: PiReasoningLevel;
}

export interface InferenceProviderAuthMethodView {
  type: "api_key" | "oauth";
  label: string;
  subscription: boolean;
}

export interface InferenceProviderView {
  id: string;
  name: string;
  authMethods: InferenceProviderAuthMethodView[];
  connected: boolean;
  authType: "api_key" | "oauth" | null;
  authSource: string | null;
  custom: boolean;
  modelCount: number;
  modelStatus?: "ready" | "disconnected" | "unavailable";
  modelMessage?: string;
}

export interface InferenceModelView {
  providerId: string;
  modelId: string;
  name: string;
  reasoning: boolean;
  reasoningLevels: PiReasoningLevel[];
  defaultReasoningLevel: PiReasoningLevel;
  contextWindow: number;
  maxTokens: number;
}

export interface ServerSettingsView {
  inference: ServerInferenceSettings;
  providers: InferenceProviderView[];
  models: InferenceModelView[];
  modelProviderId: string;
}

export interface InferenceProviderAuthPromptView {
  id: string;
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
}

export interface InferenceProviderAuthSessionView {
  id: string;
  providerId: string;
  authType: "api_key" | "oauth";
  status: "running" | "waiting" | "connected" | "failed" | "cancelled";
  prompt: InferenceProviderAuthPromptView | null;
  authorizationUrl: string | null;
  deviceCode: {
    userCode: string;
    verificationUri: string;
    expiresInSeconds?: number;
  } | null;
  messages: string[];
  error: string | null;
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export const normalizeInferenceProviderId = (value: string): string => {
  const providerId = value.trim().toLowerCase();
  if (!PROVIDER_ID.test(providerId)) throw new Error(`Invalid inference provider: ${value}`);
  return providerId;
};

export const normalizeInferenceModelId = (value: string): string => {
  const modelId = value.trim();
  if (!modelId || /[\r\n\0]/.test(modelId)) throw new Error(`Invalid inference model: ${value}`);
  return modelId;
};

export const normalizePiReasoningLevel = (value: unknown): PiReasoningLevel => {
  if (typeof value !== "string" || !(PI_REASONING_LEVELS as readonly string[]).includes(value)) {
    throw new Error(`Invalid inference reasoning level: ${String(value)}`);
  }
  return value as PiReasoningLevel;
};

export const serverInferenceSettings = (
  providerId: string,
  modelId: string,
  reasoning: unknown
): ServerInferenceSettings => ({
  ...piModelRef(providerId, modelId),
  reasoning: normalizePiReasoningLevel(reasoning),
});

export const defaultServerInferenceSettings = (
  providerId = DEFAULT_PI_INFERENCE_PROVIDER,
  reasoning: unknown = DEFAULT_PI_REASONING_LEVEL
): ServerInferenceSettings => ({
  providerId: normalizeInferenceProviderId(providerId),
  modelId: "",
  reasoning: normalizePiReasoningLevel(reasoning),
});

export const piModelRef = (providerId: string, modelId: string): PiModelRef => ({
  providerId: normalizeInferenceProviderId(providerId),
  modelId: normalizeInferenceModelId(modelId),
});

export const formatPiModelRef = (model: PiModelRef): string =>
  `${model.providerId}/${model.modelId}`;

/** Parses a provider-qualified `provider/model` reference. */
export const parsePiModelRef = (value: string): PiModelRef => {
  const normalized = normalizeInferenceModelId(value);
  const separator = normalized.indexOf("/");
  if (separator <= 0) throw new Error(`A provider-qualified inference model is required: ${value}`);
  return piModelRef(normalized.slice(0, separator), normalized.slice(separator + 1));
};
