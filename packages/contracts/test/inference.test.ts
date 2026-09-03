import { describe, expect, test } from "bun:test";
import {
  formatPiModelRef,
  isRuntimeEngine,
  normalizeInferenceProviderId,
  normalizePiReasoningLevel,
  parsePiModelRef,
  piModelRef,
  RUNTIME_ENGINES,
  serverInferenceSettings,
} from "../src/inference";
import { parseComputerInferenceRequest } from "../src/service-protocol";

describe("Pi inference model references", () => {
  test("keeps runtime engine and inference provider as separate concepts", () => {
    expect(RUNTIME_ENGINES).toEqual(["pi"]);
    expect(isRuntimeEngine("pi")).toBe(true);
    expect(isRuntimeEngine("codex")).toBe(false);
    expect(piModelRef("Anthropic", "claude-sonnet-4-5")).toEqual({
      providerId: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
    expect(formatPiModelRef(piModelRef("openai", "gpt-5.2"))).toBe("openai/gpt-5.2");
  });

  test("accepts qualified and backwards-compatible bare model ids", () => {
    expect(parsePiModelRef("anthropic/claude-opus-4-1", "openai-codex")).toEqual({
      providerId: "anthropic",
      modelId: "claude-opus-4-1",
    });
    expect(parsePiModelRef("gpt-5.5", "openai-codex")).toEqual({
      providerId: "openai-codex",
      modelId: "gpt-5.5",
    });
    expect(parsePiModelRef("openrouter/anthropic/claude", "openai")).toEqual({
      providerId: "openrouter",
      modelId: "anthropic/claude",
    });
  });

  test("rejects unsafe provider ids", () => {
    expect(() => normalizeInferenceProviderId("not valid")).toThrow("Invalid inference provider");
    expect(() => normalizeInferenceProviderId("../provider")).toThrow("Invalid inference provider");
  });

  test("normalizes persisted runtime inference settings", () => {
    expect(serverInferenceSettings(" Anthropic ", "claude-sonnet", "medium")).toEqual({
      providerId: "anthropic",
      modelId: "claude-sonnet",
      reasoning: "medium",
    });
    expect(normalizePiReasoningLevel("xhigh")).toBe("xhigh");
    expect(() => normalizePiReasoningLevel("turbo")).toThrow("Invalid inference reasoning level");
  });

  test("requires runtime inference selection on direct computer requests", () => {
    const request = {
      kind: "verification",
      instructions: "Verify this response.",
      prompt: "Return JSON.",
      timeoutMs: 5_000,
    };
    expect(() => parseComputerInferenceRequest(request)).toThrow("Inference model is invalid");
    expect(
      parseComputerInferenceRequest({
        ...request,
        model: "openai-codex/gpt-5.5",
        reasoning: "high",
      })
    ).toMatchObject({ model: "openai-codex/gpt-5.5", reasoning: "high" });
  });
});
