import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import {
  DEFAULT_PI_REASONING_LEVEL,
  PI_REASONING_LEVELS,
  type PiReasoningLevel,
} from "@openteam/contracts";

export type ReasoningModel = Model<Api> & { defaultReasoningLevel?: PiReasoningLevel };

export const reasoningLevel = (value: unknown): PiReasoningLevel | undefined => {
  const normalized = value === "none" ? "off" : value;
  return typeof normalized === "string" &&
    (PI_REASONING_LEVELS as readonly string[]).includes(normalized)
    ? (normalized as PiReasoningLevel)
    : undefined;
};

/** Complete maps prevent unsupported levels from reappearing through Pi's defaults. */
export function reasoningLevelMap(values: ReadonlyMap<PiReasoningLevel, string>) {
  return Object.fromEntries(PI_REASONING_LEVELS.map((level) => [level, values.get(level) ?? null]));
}

/** Shared by API, CLI and validation; the map is also consumed by Pi during inference. */
export function reasoningCapabilities(model: ReasoningModel) {
  const reasoningLevels = getSupportedThinkingLevels(model);
  const preferred = model.defaultReasoningLevel;
  const defaultReasoningLevel =
    preferred && reasoningLevels.includes(preferred)
      ? preferred
      : reasoningLevels.includes(DEFAULT_PI_REASONING_LEVEL)
        ? DEFAULT_PI_REASONING_LEVEL
        : (reasoningLevels[0] ?? "off");
  // An empty list means provider-managed reasoning. The stored off sentinel omits
  // effort altogether because every map entry, including off, is null.
  return { reasoningLevels, defaultReasoningLevel };
}

/** OpenRouter's effort metadata has different semantics from Codex's level list. */
export function openRouterReasoning(metadata: unknown) {
  const data =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  const values = new Map<PiReasoningLevel, string>();
  const efforts =
    data.supported_efforts === null
      ? PI_REASONING_LEVELS.map((level) => (level === "off" ? "none" : level))
      : Array.isArray(data.supported_efforts)
        ? data.supported_efforts
        : [];
  for (const value of efforts) {
    const level = reasoningLevel(value);
    if (level && typeof value === "string") values.set(level, level === "off" ? "none" : value);
  }
  if (data.mandatory === true) values.delete("off");
  // Disable is separate from effort selection, but only expose it when there
  // is an effort selector. Missing/empty/malformed efforts use provider defaults.
  else if (values.size) values.set("off", "none");
  let defaultReasoningLevel = reasoningLevel(data.default_effort);
  if (data.default_enabled === false && data.mandatory !== true) defaultReasoningLevel = "off";
  else if (
    data.default_enabled === true &&
    (!defaultReasoningLevel || !values.has(defaultReasoningLevel))
  )
    defaultReasoningLevel = values.has(DEFAULT_PI_REASONING_LEVEL)
      ? DEFAULT_PI_REASONING_LEVEL
      : PI_REASONING_LEVELS.find((level) => level !== "off" && values.has(level));
  return { thinkingLevelMap: reasoningLevelMap(values), defaultReasoningLevel };
}
