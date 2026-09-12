import { describe, expect, test } from "bun:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { availableInferenceModels, requireInferenceModel } from "../src/inference-models";
import { InferenceProviderService } from "../src/inference-providers";

const models = [
  { provider: "openai-codex", id: "gpt-5.4" },
  { provider: "openai-codex", id: "gpt-5.4-mini" },
  { provider: "openai-codex", id: "gpt-5.5" },
  { provider: "openai-codex", id: "gpt-5.6-sol" },
  { provider: "openai", id: "gpt-5.4" },
  { provider: "openai", id: "gpt-5.4-mini" },
].map((model) => ({
  ...model,
  name: model.id,
  reasoning: true,
  contextWindow: 272_000,
  maxTokens: 128_000,
}));
const runtime = {
  getProviders: () => ["openai-codex", "openai"].map((id) => ({ id, name: id, auth: {} })),
  getModels: (provider?: string) =>
    models.filter((model) => !provider || model.provider === provider),
  getModel: (provider: string, id: string) =>
    models.find((model) => model.provider === provider && model.id === id),
  checkAuth: async () => ({ type: "oauth" }),
} as unknown as ModelRuntime;

describe("retired Codex models", () => {
  test("removes retired ChatGPT models even when a cached catalog still contains them", () => {
    expect(availableInferenceModels(runtime, "openai-codex").map((model) => model.id)).toEqual([
      "gpt-5.5",
      "gpt-5.6-sol",
    ]);
    expect(availableInferenceModels(runtime)).toHaveLength(4);
  });

  test.each([
    "gpt-5.4",
    "gpt-5.4-mini",
  ])("rejects %s with a supported replacement", async (modelId) => {
    const ref = { providerId: "openai-codex", modelId };
    const replacement = modelId === "gpt-5.4" ? "gpt-5.6-terra" : "gpt-5.6-luna";
    expect(() => requireInferenceModel(runtime, ref)).toThrow(`Select openai-codex/${replacement}`);
    const service = new InferenceProviderService(() => runtime, "/does/not/exist/models.json");
    await expect(service.verify({ ...ref, reasoning: "low" })).rejects.toThrow(
      "retired for ChatGPT sign-in"
    );
  });

  test("preserves API access and currently supported Codex models", () => {
    for (const modelId of ["gpt-5.4", "gpt-5.4-mini"]) {
      expect(requireInferenceModel(runtime, { providerId: "openai", modelId }).id).toBe(modelId);
    }
    expect(
      requireInferenceModel(runtime, { providerId: "openai-codex", modelId: "gpt-5.5" }).id
    ).toBe("gpt-5.5");
    expect(() =>
      requireInferenceModel(runtime, { providerId: "openai-codex", modelId: "missing-model" })
    ).toThrow("Pi does not provide");
  });

  test("keeps the UI catalog and provider model counts consistent", async () => {
    const service = new InferenceProviderService(() => runtime, "/does/not/exist/models.json");
    const catalog = await service.catalog("openai-codex");
    expect(catalog.models.map((model) => model.modelId)).toEqual(["gpt-5.5", "gpt-5.6-sol"]);
    expect(catalog.providers.find((provider) => provider.id === "openai-codex")?.modelCount).toBe(
      2
    );
    expect(catalog.providers.find((provider) => provider.id === "openai")?.modelCount).toBe(2);
  });
});
