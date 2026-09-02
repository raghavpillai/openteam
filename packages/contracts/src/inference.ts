export const PI_RUNTIME_ENGINE = "pi" as const;
export const RUNTIME_ENGINES = [PI_RUNTIME_ENGINE] as const;
export type RuntimeEngine = (typeof RUNTIME_ENGINES)[number];

export const isRuntimeEngine = (value: unknown): value is RuntimeEngine =>
  typeof value === "string" && (RUNTIME_ENGINES as readonly string[]).includes(value);

export const DEFAULT_PI_INFERENCE_PROVIDER = "openai-codex";
export const DEFAULT_PI_INFERENCE_MODEL = "gpt-5.5";

export interface PiModelRef {
  providerId: string;
  modelId: string;
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
