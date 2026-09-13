import { expect, test } from "bun:test";
import { memoryInferenceSettings } from "../src/memory-inference";

const main = { providerId: "openai-codex", modelId: "gpt-5.6-sol", reasoning: "high" as const };

test("memory can use an independent provider and reasoning setting without changing the main model", () => {
  expect(memoryInferenceSettings(main, {})).toEqual(main);
  expect(
    memoryInferenceSettings(main, { OPENTEAM_MEMORY_MODEL: "google/gemini-2.5-flash" })
  ).toEqual({
    providerId: "google",
    modelId: "gemini-2.5-flash",
    reasoning: "off",
  });
  expect(
    memoryInferenceSettings(main, {
      OPENTEAM_MEMORY_MODEL: "memory-model",
      OPENTEAM_MEMORY_REASONING: "low",
    })
  ).toEqual({
    providerId: "openai-codex",
    modelId: "memory-model",
    reasoning: "low",
  });
  expect(main.reasoning).toBe("high");
  expect(() => memoryInferenceSettings(main, { OPENTEAM_MEMORY_REASONING: "invalid" })).toThrow();
});
