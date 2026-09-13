import {
  parsePiModelRef,
  serverInferenceSettings,
  type ServerInferenceSettings,
} from "@openteam/contracts";

/** Memory calls use separate sessions and can use a different provider/model. */
export const memoryInferenceSettings = (
  main: ServerInferenceSettings,
  env: Record<string, string | undefined> = process.env
): ServerInferenceSettings => {
  const model = env.OPENTEAM_MEMORY_MODEL?.trim();
  const reference = model ? parsePiModelRef(model, main.providerId) : main;
  return serverInferenceSettings(
    reference.providerId,
    reference.modelId,
    env.OPENTEAM_MEMORY_REASONING?.trim() || (model ? "off" : main.reasoning)
  );
};
