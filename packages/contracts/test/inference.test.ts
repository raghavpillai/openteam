import { describe, expect, test } from "bun:test";
import {
  normalizeInferenceProviderId,
} from "../src/inference";
import { parseComputerInferenceRequest } from "../src/service-protocol";

describe("Pi inference model references", () => {

  test("rejects unsafe provider ids", () => {
    expect(() => normalizeInferenceProviderId("not valid")).toThrow("Invalid inference provider");
    expect(() => normalizeInferenceProviderId("../provider")).toThrow("Invalid inference provider");
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
