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

  // Pi 0.84.3 drops "off" from Codex requests. Omitting reasoning lets the
  // provider choose its default effort, so explicitly encode the supported
  // off value at the request boundary. Other providers keep Pi's mapping.
  return {
    onPayload(payload) {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
      return {
        ...payload,
        reasoning: { effort: model.thinkingLevelMap?.off ?? "none" },
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
