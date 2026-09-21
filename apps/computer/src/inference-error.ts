/** Stable public diagnostics: never return provider payloads or private prompts. */
export function inferenceFailure(error: unknown): { status: number; error: { code: string; message: string } } {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed? out|timeout/i.test(message)) return {
    status: 504, error: { code: "inference_timeout", message: "Inference exceeded its time limit" },
  };
  if (/cancell?ed|abort/i.test(message)) return {
    status: 499, error: { code: "inference_cancelled", message: "Inference was cancelled" },
  };
  if (/not configured|unauthorized|authentication|invalid|unsupported|\b(?:400|401|403|404|422)\b/i.test(message)) return {
    status: 422, error: { code: "inference_configuration", message: "Inference provider rejected the configuration or request" },
  };
  if (/rate.?limit|\b429\b/i.test(message)) return {
    status: 429, error: { code: "inference_rate_limit", message: "Inference provider is rate limited" },
  };
  return { status: 502, error: { code: "inference_provider_failed", message: "Inference provider failed to return a usable response" } };
}
