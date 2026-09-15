/** Provider APIs do not share a modality schema. Prefer declared capabilities, then known families. */
export const isTranscriptionModel = (
  model: Record<string, unknown>,
  customEndpoint = false
): boolean => {
  if (typeof model.id !== "string") return false;
  const task = String(model.task ?? model.type ?? "").toLowerCase();
  if (/transcri|automatic-speech-recognition|speech-to-text|^asr$/.test(task)) return true;
  if (/chat|llm|embedding|text-generation|image|text-to-speech|tts/.test(task)) return false;
  if (Array.isArray(model.supported_endpoints))
    return model.supported_endpoints.some((path) => /audio\/transcriptions$/.test(String(path)));
  const id = model.id.toLowerCase();
  if (/whisper|transcrib|transcri|parakeet|canary|speech-to-text/.test(id)) return true;
  if (
    /gpt|claude|embed|rerank|moderation|dall-e|image|tts|realtime|sora|llama|qwen|deepseek|gemma/.test(
      id
    )
  )
    return false;
  // A custom audio endpoint declares its intended task; opaque model IDs can be used there.
  return customEndpoint;
};
