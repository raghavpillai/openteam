import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { formatPiModelRef, type PiModelRef } from "@openteam/contracts";

// Pi's bundled catalog can outlive provider retirements, including in models-store.json.
// https://learn.chatgpt.com/docs/models#deprecated-codex-models (2026-08-31)
const retiredCodexModels = new Map([
  ["gpt-5.4", "gpt-5.6-terra"],
  ["gpt-5.4-mini", "gpt-5.6-luna"],
]);

const replacementFor = (providerId: string, modelId: string): string | undefined =>
  providerId === "openai-codex" ? retiredCodexModels.get(modelId) : undefined;

export const availableInferenceModels = (runtime: ModelRuntime, providerId?: string) =>
  runtime.getModels(providerId).filter((model) => !replacementFor(model.provider, model.id));

export const requireInferenceModel = (runtime: ModelRuntime, ref: PiModelRef) => {
  const replacement = replacementFor(ref.providerId, ref.modelId);
  if (replacement) {
    throw new Error(
      `${formatPiModelRef(ref)} was retired for ChatGPT sign-in. Select openai-codex/${replacement} instead.`
    );
  }
  const model = runtime.getModel(ref.providerId, ref.modelId);
  if (!model) throw new Error(`Pi does not provide ${formatPiModelRef(ref)}`);
  return model;
};
