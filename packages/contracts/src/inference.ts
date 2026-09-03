export const PI_RUNTIME_ENGINE = "pi" as const;
export const RUNTIME_ENGINES = [PI_RUNTIME_ENGINE] as const;
export type RuntimeEngine = (typeof RUNTIME_ENGINES)[number];

export const isRuntimeEngine = (value: unknown): value is RuntimeEngine =>
  typeof value === "string" && (RUNTIME_ENGINES as readonly string[]).includes(value);

export const DEFAULT_PI_INFERENCE_PROVIDER = "openai-codex";
export const DEFAULT_PI_INFERENCE_MODEL = "gpt-5.5";
export const DEFAULT_PI_REASONING_LEVEL = "high" as const;

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
}

export interface InferenceModelView {
  providerId: string;
  modelId: string;
  name: string;
  reasoning: boolean;
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
  input: Partial<ServerInferenceSettings> = {}
): ServerInferenceSettings =>
  serverInferenceSettings(
    input.providerId ?? DEFAULT_PI_INFERENCE_PROVIDER,
    input.modelId ?? DEFAULT_PI_INFERENCE_MODEL,
    input.reasoning ?? DEFAULT_PI_REASONING_LEVEL
  );

export const piModelRef = (providerId: string, modelId: string): PiModelRef => ({
  providerId: normalizeInferenceProviderId(providerId),
  modelId: normalizeInferenceModelId(modelId),
});

export const formatPiModelRef = (model: PiModelRef): string =>
  `${model.providerId}/${model.modelId}`;

/** A bare model id keeps the configured/default provider for backwards compatibility. */
export const parsePiModelRef = (
  value: string,
  defaultProvider = DEFAULT_PI_INFERENCE_PROVIDER
): PiModelRef => {
  const normalized = normalizeInferenceModelId(value);
  const separator = normalized.indexOf("/");
  return separator > 0
    ? piModelRef(normalized.slice(0, separator), normalized.slice(separator + 1))
    : piModelRef(defaultProvider, normalized);
};
