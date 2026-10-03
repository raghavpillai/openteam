import {
  type Api,
  clampThinkingLevel,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PiReasoningLevel } from "@openteam/contracts";

export function inferenceReasoningOptions(
  model: Model<Api>,
  requested: PiReasoningLevel
): SimpleStreamOptions {
  const level = clampThinkingLevel(model, requested);
  if (model.api !== "openai-codex-responses" || !model.reasoning || level !== "off") {
    return { reasoning: level === "off" ? undefined : level };
  }

  // Pi 0.84.3 drops "off" from Codex requests. Only encode it when the model
  // catalog explicitly maps off to a provider value. For dynamically discovered
  // models without capability metadata, omission safely uses the provider default.
  const off = model.thinkingLevelMap?.off;
  if (off === undefined || off === null) return {};
  return {
    onPayload(payload) {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
      return {
        ...payload,
        reasoning: { effort: off },
      };
    },
  };
}

export function reasoningExtension(
  model: Model<Api>,
  requested: PiReasoningLevel
): { name: string; hidden: boolean; factory: ExtensionFactory } {
  const { onPayload } = inferenceReasoningOptions(model, requested);
  return {
    name: "openteam-reasoning",
    hidden: true,
    factory(pi) {
      if (onPayload) pi.on("before_provider_request", (event) => onPayload(event.payload, model));
    },
  };
}
