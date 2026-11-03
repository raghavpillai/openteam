import { expect, test } from "bun:test";
import type { InferenceModelView } from "@openteam/contracts/inference";
import {
  FILTER_AT,
  matchesQuery,
  modelOption,
  recommendedModelId,
} from "../src/renderer/components/openteam/setup/model-picker";
import { shortHost } from "../src/renderer/lib/server-address";

const model = (modelId: string, name: string, recommended?: boolean): InferenceModelView => ({
  providerId: "openrouter",
  modelId,
  name,
  reasoning: true,
  reasoningLevels: ["low", "medium", "high"],
  defaultReasoningLevel: "medium",
  contextWindow: 200_000,
  maxTokens: 32_000,
  recommended,
});

test("an OpenRouter name splits into the model and its maker", () => {
  expect(
    modelOption(model("anthropic/claude-opus-5-5", "Anthropic: Claude Opus 5.5"), "OpenRouter")
  ).toEqual({
    modelId: "anthropic/claude-opus-5-5",
    name: "Claude Opus 5.5",
    maker: "Anthropic",
    recommended: false,
  });
  // Without a "Maker:" prefix the id names the maker.
  expect(modelOption(model("meta-llama/llama-5-70b", "Llama 5 70B"), "OpenRouter").maker).toBe(
    "Meta"
  );
  // A plan's models have no maker of their own; the provider stands in.
  expect(modelOption(model("gpt-5.6", "GPT-5.6"), "ChatGPT")).toMatchObject({
    name: "GPT-5.6",
    maker: "ChatGPT",
  });
  expect(
    modelOption(model("openrouter/auto", "OpenRouter: Auto Router", true), "OpenRouter")
  ).toMatchObject({
    name: "Auto Router",
    recommended: true,
  });
});

test("search matches every word in the name, maker or id", () => {
  const opus = modelOption(
    model("anthropic/claude-opus-5-5", "Anthropic: Claude Opus 5.5"),
    "OpenRouter"
  );
  expect(matchesQuery(opus, "claude opus")).toBe(true);
  expect(matchesQuery(opus, "ANTHROPIC 5.5")).toBe(true);
  expect(matchesQuery(opus, "opus-5")).toBe(true);
  expect(matchesQuery(opus, "claude gemini")).toBe(false);
  expect(matchesQuery(opus, "")).toBe(true);
});

test("a long server address shortens to its first name and port", () => {
  expect(shortHost("192.168.1.20:8787")).toBe("192.168.1.20:8787");
  expect(shortHost("raghav-agent-testing.tail658346.ts.net:8788")).toBe(
    "raghav-agent-testing…:8788"
  );
  expect(shortHost("my-server.example.com")).toBe("my-server.example.com");
});

test("the recommended model is the one the catalog marks, or else its first", () => {
  const chatgpt = [model("gpt-6.1-sol", "GPT-6.1-Sol"), model("gpt-6-astra", "GPT-6-Astra")].map(
    (entry) => modelOption(entry, "ChatGPT")
  );
  expect(recommendedModelId(chatgpt)).toBe("gpt-6.1-sol");
  const openrouter = [
    model("anthropic/claude-opus-5-5", "Anthropic: Claude Opus 5.5"),
    model("openrouter/auto", "OpenRouter: Auto Router", true),
  ].map((entry) => modelOption(entry, "OpenRouter"));
  expect(recommendedModelId(openrouter)).toBe("openrouter/auto");
  expect(recommendedModelId([])).toBeUndefined();
  // A plan's short list opens without a filter; OpenRouter's hundreds get one.
  expect(chatgpt.length > FILTER_AT).toBe(false);
});
