import { botPersistThreshold } from "../compaction/messages";

/** Keep the advertised output maximum from consuming the conversation's budget. */
export function withAgentOutputBudget<T extends { contextWindow: number; maxTokens: number }>(model: T): T {
  if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0 ||
      !Number.isFinite(model.maxTokens) || model.maxTokens <= 0) return model;
  // Conversation compaction starts at 90% of the window. Reserve the remaining
  // space for a response, rather than requesting the provider's full output
  // capability on every turn (which can occupy almost the entire window).
  // Pi still clamps this further against its per-request input estimate.
  const maxTokens = Math.min(model.maxTokens,
    Math.max(1, Math.floor(model.contextWindow - botPersistThreshold(model.contextWindow))));
  return maxTokens === model.maxTokens ? model : { ...model, maxTokens };
}
